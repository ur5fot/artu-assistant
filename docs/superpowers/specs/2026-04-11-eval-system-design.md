# Phase 3E: Eval System

## Цель

Behavior tests для R2 — catch regressions в AI-поведении которые unit tests не покрывают. Юзер сохраняет eval через чат ("это неправильно, должно быть X"), `code_deploy` прогоняет все evals перед мержем и блокирует если хоть один fail. Semantic evaluator через Haiku решает passed/failed.

## Архитектура

Два новых tool'а (`eval_add`, `eval_run`) + runner + semantic evaluator + storage в `data/evals.json`. Tools используют factory pattern (`createTool(deps)`) чтобы получить `runToolLoop` через DI. `code_deploy` тоже переходит на factory и получает `runLoop` для запуска evals перед merge.

```
Flow — save eval:
  User: "Ты неправильно ответил про X. Должен был Y"
  Chat Claude → tool eval_add({ input: previousUserMsg, expected: 'Y' })
  PermissionCard confirm → user allows → data/evals.json updated

Flow — run evals standalone:
  User: "прогони evals"
  Chat Claude → tool eval_run({})
  Handler:
    for each eval in data/evals.json (sequential or concurrency=N):
      run real runToolLoop with eval.input
      collect text_delta + tool_call_start events
      call semantic evaluator (Haiku) with {input, expected, actualText, actualToolCalls}
      parse {passed, reason}
    return { passed: X, failed: Y, results: [...] }

Flow — pre-merge gate:
  User: "деплой"
  Chat Claude → tool code_deploy
  Handler:
    1. runAllEvals(runLoop)
    2. if failed > 0 → return { success: false, error: "N evals failed", data: failures }
    3. else → POST /api/merge (existing flow)
    4. return merge result
```

## Storage — `data/evals.json`

Committed to git (fixtures, not data). Gitignore changes: no.

```json
[
  {
    "id": "7c3e9a12-4b5d-4f8e-9a6c-1d2e3f4a5b6c",
    "input": "Сколько будет 2+2?",
    "expected": "Ответ должен содержать число 4.",
    "toolUseExpected": null,
    "createdAt": "2026-04-11T14:52:00.000Z"
  },
  {
    "id": "8d4f0b23-5c6e-5f9f-0b7d-2e3f4a5b6c7d",
    "input": "Какая сегодня погода в Киеве?",
    "expected": "Ответ содержит реальную информацию о погоде из поиска, не выдуманную.",
    "toolUseExpected": ["web_search"],
    "createdAt": "2026-04-11T15:00:00.000Z"
  }
]
```

Fields:
- `id` — UUID (crypto.randomUUID())
- `input` — user message that will be sent to R2 for the eval run
- `expected` — natural language description of correct behavior (semantic evaluator rubric)
- `toolUseExpected` — optional string[] with tool names R2 MUST call (null = don't check)
- `createdAt` — ISO 8601 timestamp

### Store module `packages/server/src/evals/store.ts`

```typescript
export interface Eval {
  id: string;
  input: string;
  expected: string;
  toolUseExpected: string[] | null;
  createdAt: string;
}

export async function loadEvals(): Promise<Eval[]>;
export async function saveEval(newEval: Eval): Promise<void>;
export async function getEvalsPath(): string;
```

Default path: `data/evals.json` (under R2 root). Env override: `EVALS_PATH`.

On load: if file missing, return `[]`. If malformed JSON, throw with clear message.
On save: atomic write (write to `.tmp` then rename).

## Semantic evaluator — `packages/server/src/evals/evaluator.ts`

```typescript
export interface EvaluatorInput {
  input: string;
  expected: string;
  actualText: string;
  actualToolCalls: string[];
  toolUseExpected: string[] | null;
}

export interface EvaluatorResult {
  passed: boolean;
  reason: string;
}

export async function evaluate(input: EvaluatorInput): Promise<EvaluatorResult>;
```

Implementation:
- Uses `@anthropic-ai/sdk` with model from `CLAUDE_HAIKU_MODEL` env (default `claude-haiku-4-5-20251001`)
- System prompt:

```
You evaluate AI assistant responses. Given a user input, expected behavior, what the assistant actually said, and which tools it called, decide if the response meets the expectation.

Rules:
- `expected` is a natural language description of correct behavior.
- `actualText` is the assistant's final text response (may be empty if it only used tools).
- `actualToolCalls` lists tool names the assistant invoked during the conversation.
- If `toolUseExpected` is not empty, ALL those tools MUST be in actualToolCalls. Missing any = fail.
- Be lenient on phrasing, strict on facts and required tools.
- If facts are wrong, fail.
- If required tools were not called, fail.

Reply ONLY with valid JSON: {"passed": true|false, "reason": "short explanation"}
```

User message format:

```
Input: <input>
Expected: <expected>
Actual text: <actualText>
Actual tools: <actualToolCalls.join(', ')>
Expected tools: <toolUseExpected?.join(', ') || 'any'>
```

Error handling (fail-closed):
- On parse error: return `{passed: false, reason: 'evaluator returned invalid JSON'}`
- On API error: return `{passed: false, reason: 'evaluator API error: <message>'}`
- On missing fields: return `{passed: false, reason: 'evaluator returned incomplete result'}`

Max tokens: 256.

## Runner — `packages/server/src/evals/runner.ts`

```typescript
import type { runToolLoop } from '../ai/tool-loop.js';

export interface EvalResult {
  evalId: string;
  input: string;
  passed: boolean;
  reason: string;
  actualText: string;
  actualToolCalls: string[];
}

export interface RunAllOptions {
  concurrency: number;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export interface RunAllResult {
  passed: number;
  failed: number;
  results: EvalResult[];
}

export async function runSingleEval(
  target: Eval,
  runLoop: typeof runToolLoop,
  deps: { client: ClaudeClient; registry: ToolRegistry; piiProxy: PiiProxy },
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<EvalResult>;

export async function runAllEvals(
  runLoop: typeof runToolLoop,
  deps: { client: ClaudeClient; registry: ToolRegistry; piiProxy: PiiProxy },
  options: RunAllOptions,
): Promise<RunAllResult>;
```

### `runSingleEval` flow

1. Create empty arrays `actualText = ''` and `actualToolCalls: string[] = []`
2. Call `runLoop({ messages: [{role: 'user', content: target.input}], client, registry, onEvent, signal, piiProxy })`
   - `piiProxy` must be passthrough (not real) for deterministic eval runs — evals don't care about PII
   - Actually: use the passed piiProxy from deps (caller decides)
3. In `onEvent` callback:
   - `text_delta` → append to `actualText`
   - `tool_call_start` → push `event.toolCall.name` to `actualToolCalls`
   - ignore other events
4. After `done`, call `evaluate({input, expected, actualText, actualToolCalls, toolUseExpected})`
5. Return `EvalResult`

Error inside runLoop → return `{passed: false, reason: 'run error: <msg>', actualText: '', actualToolCalls: []}`.

### `runAllEvals` flow

1. `evals = await loadEvals()`
2. If empty: return `{passed: 0, failed: 0, results: []}`
3. Concurrency control via simple semaphore:
   ```typescript
   const limit = pLimit(options.concurrency);
   const results = await Promise.all(
     evals.map((e, i) => limit(async () => {
       options.onProgress?.(`Running eval ${i + 1}/${evals.length}: ${e.id}`);
       return runSingleEval(e, runLoop, deps, undefined, options.signal);
     }))
   );
   ```
4. Count passed/failed, return `RunAllResult`

Note: use `p-limit` package (lightweight, 3KB) or inline semaphore. If inline, ~20 lines.

## Tool registry factory pattern

### Extend `packages/server/src/tools/registry.ts`

Current `discoverTools()` only loads `default export`. New version also supports `createTool` named export.

```typescript
export interface ToolDeps {
  runLoop: typeof runToolLoop;
  client: ClaudeClient;
  registry: ToolRegistry;
  piiProxy: PiiProxy;
}

export async function discoverTools(
  registry: ToolRegistry,
  deps?: ToolDeps,
): Promise<void> {
  // iterate packages/tool-*/
  for (const pkgDir of toolDirs) {
    const module = await import(pkgName);
    
    let definitions: ToolDefinition[] = [];
    
    if (typeof module.createTool === 'function') {
      if (!deps) {
        console.warn(`${pkgName} exports createTool but no deps provided, skipping`);
        continue;
      }
      const result = module.createTool(deps);
      definitions = Array.isArray(result) ? result : [result];
    } else if (module.default) {
      definitions = Array.isArray(module.default) ? module.default : [module.default];
    }
    
    for (const def of definitions) {
      registry.register(def);
    }
  }
}
```

### Chicken-and-egg problem

`runToolLoop` needs `registry` (to iterate tools). `discoverTools` needs `runLoop` (to pass to factories). Solution: registry is created first as empty object with methods; `runLoop` is bound to that registry via closure; `discoverTools` fills the registry in-place.

In `packages/server/src/index.ts`:

```typescript
const registry = createRegistry();

// Bound closure of runToolLoop that always uses this registry
const runLoopFn = (params: Omit<ToolLoopParams, 'client' | 'registry' | 'piiProxy'>) =>
  runToolLoop({ ...params, client, registry, piiProxy });

// Deps for factory-style tools
const toolDeps: ToolDeps = { runLoop: runLoopFn, client, registry, piiProxy };

await discoverTools(registry, toolDeps);
```

`runLoopFn` signature is a partial application — tools only need to pass `messages`, `onEvent`, `signal`, `pendingConfirms`, `pendingPlanReviews`. Client/registry/piiProxy are baked in.

### Updated `ToolDeps` type in `@r2/shared`

```typescript
export interface ToolDeps {
  runLoop: (params: {
    messages: MessageParam[];
    onEvent: (event: SSEEvent) => void;
    signal?: AbortSignal;
    pendingConfirms?: PendingConfirms;
    pendingPlanReviews?: PendingPlanReviews;
  }) => Promise<void>;
}
```

Wait — this creates a cycle (shared → server types). Solution: define minimal `RunLoopFn` type in `@r2/shared` with only what tool factories need (messages + onEvent + signal), and use `any` for the rest. Or keep `ToolDeps` in `@r2/server/tools/base.ts` — tool packages can import from there if they need DI.

**Chosen approach**: `ToolDeps` lives in `@r2/server/tools/base.ts`, tool packages that use factory import from `@r2/server`. Tool packages without DI (file, web-search, code-task, code-deploy) don't need this import. This is acceptable because factory tools are inherently tied to server internals anyway.

## Tool `eval_add` — `packages/tool-eval-add/`

No DI needed (only touches `data/evals.json`). Uses default export.

```typescript
import type { ToolDefinition, ToolResult } from '@r2/shared';
import { saveEval } from '@r2/server/evals/store.js'; // ← cross-package import

// Actually cleaner: duplicate saveEval logic or import via a shared package
// Simpler: tool-eval-add does its own file I/O (JSON append)
```

**Simpler:** `eval_add` tool does its own file I/O directly. No import from `@r2/server`. Just reads/writes `EVALS_PATH || 'data/evals.json'` relative to cwd.

```typescript
export const evalAddTool: ToolDefinition = {
  name: 'eval_add',
  description: 'Save a new behavior eval for R2. Use when user says "this is wrong, should be X", or explicitly asks to remember correct behavior. Persists to data/evals.json for pre-merge regression checks.',
  permissionLevel: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The user message that triggered wrong behavior' },
      expected: { type: 'string', description: 'Description of correct behavior in natural language' },
      toolUseExpected: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: tools R2 must call (e.g. ["web_search"])',
      },
    },
    required: ['input', 'expected'],
  },
  async handler(params) {
    const input = typeof params.input === 'string' ? params.input : '';
    const expected = typeof params.expected === 'string' ? params.expected : '';
    const toolUseExpected = Array.isArray(params.toolUseExpected) ? params.toolUseExpected as string[] : null;
    
    if (!input.trim() || !expected.trim()) {
      return { success: false, error: 'input and expected are required' };
    }
    
    const newEval = {
      id: crypto.randomUUID(),
      input: input.trim(),
      expected: expected.trim(),
      toolUseExpected,
      createdAt: new Date().toISOString(),
    };
    
    const path = process.env.EVALS_PATH || 'data/evals.json';
    let list = [];
    try {
      const raw = fs.readFileSync(path, 'utf8');
      list = JSON.parse(raw);
    } catch {
      // file missing or empty — start fresh
    }
    list.push(newEval);
    // Atomic write
    fs.writeFileSync(`${path}.tmp`, JSON.stringify(list, null, 2));
    fs.renameSync(`${path}.tmp`, path);
    
    return {
      success: true,
      data: { id: newEval.id, totalEvals: list.length },
      display: {
        type: 'text',
        content: `Saved eval "${newEval.id}". Total evals: ${list.length}.`,
      },
    };
  },
};

export default evalAddTool;
```

## Tool `eval_run` — `packages/tool-eval-run/`

Uses DI (factory). Needs `runLoop` from deps.

```typescript
import type { ToolDefinition, ToolResult, ToolContext } from '@r2/shared';
import type { ToolDeps } from '@r2/server';
import { runAllEvals } from '@r2/server/evals/runner.js';

export function createTool(deps: ToolDeps): ToolDefinition {
  return {
    name: 'eval_run',
    description: 'Run all behavior evals against the current R2. Returns pass/fail summary with details. Use when user asks to check regressions or before deploying.',
    permissionLevel: 'confirm',
    parameters: { type: 'object', properties: {}, required: [] },
    async handler(_params, ctx?: ToolContext): Promise<ToolResult> {
      const onProgress = ctx?.onProgress ?? (() => {});
      onProgress('Loading evals...');
      
      try {
        const { passed, failed, results } = await runAllEvals(
          deps.runLoop,
          { client: deps.client, registry: deps.registry, piiProxy: deps.piiProxy },
          {
            concurrency: parseInt(process.env.EVAL_CONCURRENCY || '3', 10),
            onProgress,
            signal: ctx?.signal,
          },
        );
        
        return {
          success: failed === 0,
          data: { passed, failed, results },
          display: {
            type: 'text',
            content: formatSummary({ passed, failed, results }),
          },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'eval run failed',
        };
      }
    },
  };
}

function formatSummary({ passed, failed, results }: { passed: number; failed: number; results: EvalResult[] }): string {
  const header = `Evals: ${passed} passed, ${failed} failed`;
  const failures = results
    .filter((r) => !r.passed)
    .map((r) => `  ✗ ${r.evalId}: ${r.reason}`)
    .join('\n');
  return failures ? `${header}\n${failures}` : header;
}
```

## Tool `code_deploy` — refactor to factory

Change from default export to `createTool(deps)` factory. Handler adds eval pre-check:

```typescript
export function createTool(deps: ToolDeps): ToolDefinition {
  return {
    name: 'code_deploy',
    description: '...',
    permissionLevel: 'confirm',
    preCheck: async () => ({ destructive: true, reason: 'deploys to production master branch' }),
    parameters: { type: 'object', properties: {}, required: [] },
    async handler(_params, ctx?: ToolContext): Promise<ToolResult> {
      const onProgress = ctx?.onProgress ?? (() => {});
      
      // 1. Run evals first
      onProgress('Running pre-merge evals...');
      try {
        const { passed, failed, results } = await runAllEvals(
          deps.runLoop,
          { client: deps.client, registry: deps.registry, piiProxy: deps.piiProxy },
          {
            concurrency: parseInt(process.env.EVAL_CONCURRENCY || '3', 10),
            onProgress,
            signal: ctx?.signal,
          },
        );
        
        if (failed > 0) {
          const failedList = results.filter((r) => !r.passed).map((r) => `  - ${r.evalId}: ${r.reason}`).join('\n');
          return {
            success: false,
            error: `Merge blocked: ${failed} evals failed\n${failedList}`,
            data: { passed, failed, results },
          };
        }
        
        onProgress(`All ${passed} evals passed, merging...`);
      } catch (err) {
        return {
          success: false,
          error: `Eval run failed: ${err instanceof Error ? err.message : 'unknown'}`,
        };
      }
      
      // 2. Existing merge flow (unchanged)
      const port = process.env.PORT || '3001';
      // ... fetch POST /api/merge → return result
    },
  };
}
```

Skip evals: if `data/evals.json` is empty array (0 evals), `runAllEvals` returns `{passed: 0, failed: 0}` → `failed === 0` → proceeds with merge. No explicit bypass.

## Configuration

```bash
# Phase 3E
EVAL_CONCURRENCY=3
EVALS_PATH=./data/evals.json
# CLAUDE_HAIKU_MODEL already exists from Phase 3C
```

## Testing

### Unit tests

**`packages/server/src/evals/store.test.ts`**:
- saveEval + loadEvals round-trip
- loadEvals returns [] when file missing
- saveEval atomic (no corruption on concurrent writes — sequential test)
- Malformed JSON throws clear error

**`packages/server/src/evals/evaluator.test.ts`**:
- Parses valid `{passed, reason}` JSON from Haiku mock
- Returns `{passed: false, reason: 'evaluator returned invalid JSON'}` on parse error
- Returns `{passed: false, reason: 'evaluator API error: ...'}` on API error
- Uses `CLAUDE_HAIKU_MODEL` env when set

**`packages/server/src/evals/runner.test.ts`**:
- `runSingleEval` happy path: mock runLoop emits text_delta + tool_call_start → actualText/actualToolCalls captured → evaluator called with correct input
- `runSingleEval` captures tool_call_start names only
- `runSingleEval` returns fail result on runLoop error
- `runSingleEval` toolUseExpected forwarded to evaluator
- `runAllEvals` loads from store, iterates all, respects concurrency
- `runAllEvals` counts passed/failed correctly
- `runAllEvals` empty evals list returns zeros

**`packages/server/src/tools/registry.test.ts`** (new or update):
- `discoverTools` loads default export (existing behavior)
- `discoverTools` loads `createTool` factory and passes deps
- `discoverTools` skips factory packages if no deps provided (warning)
- Both types can coexist in registry

**`packages/tool-eval-add/src/__tests__/eval-add.test.ts`**:
- Saves new eval, returns id
- Appends to existing file
- Rejects empty input or expected
- Atomic write (tmp → rename)

**`packages/tool-eval-run/src/__tests__/eval-run.test.ts`**:
- Factory creates tool with deps
- Handler calls runAllEvals with deps
- Returns success when all pass
- Returns failure with details when any fail
- Forwards onProgress

**`packages/tool-code-deploy/src/__tests__/code-deploy.test.ts`** (update):
- Factory-style createTool
- Handler runs evals first
- Merge blocked when evals fail (no fetch call made)
- Merge proceeds when evals pass
- Empty evals list (0 evals) allows merge
- Progress messages include "Running pre-merge evals" and "All N evals passed"

### Manual / E2E

- Send message to R2 like "это неправильно, должно быть X" → R2 calls `eval_add` → PermissionCard → Allow once → `data/evals.json` gains new entry
- "Прогони evals" → `eval_run` card → Allow once → summary in chat with pass/fail
- Fake a bad R2 state (change system prompt) → run evals → observe failures
- "Деплой" with evals failing → blocked with error details
- "Деплой" with all evals passing → normal merge flow

## What's NOT included

- History of eval runs (no SQLite table — would need Phase 3E.1)
- Rubric-based scoring with multiple criteria per eval
- Eval dataset versioning / git blame of expected changes
- Auto-generated evals from chat transcripts without user confirmation
- Scheduled eval runs (cron) — needs Phase 4F
- Diff mode ("was failing, should now pass") to verify fixes
- UI for editing evals (only through eval_add tool + file)
- Eval categories / tags / filters
- Eval timeout per run (relies on runLoop + signal)
