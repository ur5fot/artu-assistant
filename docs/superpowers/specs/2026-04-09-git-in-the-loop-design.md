# Phase 3C: Git-in-the-loop (code_task tool)

## Цель

R2 модифицирует сам себя через чат. Юзер даёт задачу → R2 вызывает Claude Agent SDK (once mode) или ralphex (auto mode) в изолированном git worktree на dev ветке → показывает diff в чате → коммит. Для auto mode показывается сгенерированный план, который юзер может отредактировать перед запуском.

## Архитектура

Новый пакет `packages/tool-code-task/` — стандартный R2 tool с `permissionLevel: 'confirm'`. Использует **worktree per-call** (`/tmp/r2-dev-<callId>`) — каждый вызов создаёт свежий worktree и удаляет его в `finally`. Это решает concurrency, abort cleanup, stale worktree проблемы одним решением.

Types (`ToolDefinition`, `ToolContext`, `PlanReviewResponse`) живут в `@r2/shared` — нет циклической зависимости `tool-code-task ↔ server`.

```
User: "добавь dark mode"
  ↓
Chat Claude → tool code_task({task, context})
  ↓
Tool-loop:
  1. preCheck hook → regex-based destructive check
  2. If destructive → force confirmation (ignore saved rule)
  3. Check saved permission rule → if allowed → autoMode=true
  4. Show PermissionCard (3 buttons: Once / Always / Deny) OR use saved rule
  5. User: Allow once
  6. Run handler with ctx = { onProgress, requestPlanReview, signal, meta: {autoMode, callId} }
     ↓
     Handler:
     a. workdir = /tmp/r2-dev-<callId>
     b. try {
        c.   ensureWorktree(workdir, 'dev')
        d.   if autoMode:
               - Generate draft plan
               - requestPlanReview(plan) → wait user approve/edit/reject
               - Write final plan file
               - Spawn ralphex (argv form) in workdir
             else:
               - runAgent via Claude Agent SDK in workdir
        e.   Filter staged files (denylist: .env, keys, >1MB, symlinks)
        f.   commitChanges(workdir, safe-escaped message)
        g.   Parse diff (numstat + full)
        h.   Return ToolResult
        } finally {
          removeWorktree(workdir)
        }
  ↓
SSE events во время работы: tool_progress, tool_plan_review
ToolCallCard показывает progress/plan-review-card/done с diff
```

## Пакет `@r2/tool-code-task`

### Структура

```
packages/tool-code-task/
├── src/
│   ├── index.ts              # Tool definition + handler
│   ├── destructive-check.ts  # Regex-based safety check
│   ├── worktree.ts           # Per-call worktree management
│   ├── agent-sdk.ts          # Claude Agent SDK wrapper
│   ├── ralphex.ts            # Ralphex CLI wrapper with plan review
│   ├── diff.ts               # git diff parsing + summary
│   ├── shell.ts              # execFile helpers (argv-form, no shell)
│   └── __tests__/
│       ├── destructive-check.test.ts
│       ├── worktree.test.ts
│       ├── diff.test.ts
│       ├── agent-sdk.test.ts
│       ├── ralphex.test.ts
│       └── code-task.test.ts
├── package.json
└── tsconfig.json
```

### Tool Definition

```typescript
const codeTaskTool: ToolDefinition = {
  name: 'code_task',
  description: 'Execute a coding task on R2 dev branch. Use for modifications to R2 source code. Runs Claude Code or ralphex in an isolated git worktree.',
  permissionLevel: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Specific task description' },
      context: { type: 'string', description: 'Optional: files, requirements, constraints' },
    },
    required: ['task'],
  },
  preCheck: async (input) => isDestructive(input.task as string, input.context as string | undefined),
  handler: codeTaskHandler,
};
```

## Destructive check (regex-based)

### Rationale

Regex вместо Haiku потому что:
- **Deterministic** — нет LLM non-determinism
- **No PII leakage** — не отправляет task/context наружу
- **Not prompt-injectable** — нет LLM которого можно обмануть
- **Fast + cheap** — synchronous, без API call
- **No fail-open risk** — regex либо матчится, либо нет

### Module `destructive-check.ts`

```typescript
interface DestructiveCheck {
  destructive: boolean;
  reason: string;
}

export function isDestructive(task: string, context?: string): Promise<DestructiveCheck>;
```

Returns `Promise` to match `preCheck` hook signature, though impl is synchronous.

### Patterns

```typescript
const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(delete|remove|drop|rm\s+-rf|truncate|destroy|wipe|purge)\b/i, reason: 'deletion/removal operation' },
  { pattern: /\.env(\b|\.)/, reason: 'touches .env file (secrets)' },
  { pattern: /\b(password|secret|token|api[_-]?key|credentials?)\b/i, reason: 'touches secrets/credentials' },
  { pattern: /\b(migration|schema|alter\s+table|drop\s+table)\b/i, reason: 'database schema change' },
  { pattern: /\b(package\.json|dependencies|downgrade|uninstall)\b/i, reason: 'dependency change' },
  { pattern: /\bgit\s+(push\s+--force|reset\s+--hard|filter-branch|rebase)\b/i, reason: 'git history rewrite' },
  { pattern: /\bCI\/CD\b|\.github\/workflows|deploy/i, reason: 'CI/CD or deployment change' },
  { pattern: /\b(auth|authentication|authorization|bypass|disable.*test)\b/i, reason: 'auth or test bypass' },
  { pattern: /~\/(\.ssh|\.aws|\.config|\.kube)\b/, reason: 'touches home directory secrets' },
  { pattern: /\b(exfiltrate|leak|curl.*\|.*sh|wget.*\|.*sh)\b/i, reason: 'possible exfiltration' },
];

export async function isDestructive(task: string, context?: string): Promise<DestructiveCheck> {
  const combined = `${task}\n${context ?? ''}`;
  for (const { pattern, reason } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(combined)) {
      return { destructive: true, reason };
    }
  }
  return { destructive: false, reason: '' };
}
```

## Shell helper (`shell.ts`)

Single source of truth for subprocess execution. **Never** uses shell strings.

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export async function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileP(cmd, args, { cwd, shell: false });
  return stdout.toString().trim();
}

export async function tryRun(cmd: string, args: string[], cwd?: string): Promise<{ ok: boolean; stdout: string; code: number }> {
  try {
    const stdout = await run(cmd, args, cwd);
    return { ok: true, stdout, code: 0 };
  } catch (err: any) {
    return { ok: false, stdout: '', code: err.code ?? 1 };
  }
}
```

All git/ralphex/agent calls go through these helpers. **No `exec` with shell interpolation anywhere.**

## Git worktree management (per-call)

### Module `worktree.ts`

```typescript
export async function ensureWorktree(path: string, branch: string): Promise<void>;
export async function removeWorktree(path: string): Promise<void>;
export async function commitChanges(path: string, message: string): Promise<string>;
export async function getStagedFiles(path: string): Promise<Array<{ file: string; mode: string }>>;
export async function unstageFile(path: string, file: string): Promise<void>;
```

### Path validation

```typescript
function validateWorktreePath(path: string): void {
  const prefix = process.env.R2_DEV_WORKTREE_PREFIX || '/tmp/r2-dev-';
  if (!path.startsWith(prefix)) {
    throw new Error(`Worktree path must start with ${prefix}`);
  }
  if (path.includes('..') || path.includes('~')) {
    throw new Error('Invalid worktree path');
  }
}
```

### ensureWorktree

1. `validateWorktreePath(path)`
2. If path exists → `removeWorktree(path)` first (handles leftovers from crashes)
3. `run('git', ['worktree', 'add', '--detach', path, `origin/${branch}`])`

### removeWorktree

1. `validateWorktreePath(path)` — guards against `rm -rf /`
2. `tryRun('git', ['worktree', 'remove', '--force', path])` — ignores errors (might not exist)
3. As fallback if `git worktree remove` fails: `fs.rmSync(path, { recursive: true, force: true })` (only after path validation)

### commitChanges

- `run('git', ['add', '-A'], path)` — but handler filters denylist files BEFORE calling this (see "Commit safety")
- `tryRun('git', ['diff', '--cached', '--quiet'], path)` — exit 0 = no changes
- If no changes: return empty string
- `run('git', ['commit', '-m', message], path)` — argv form, message is data not code
- Return `run('git', ['rev-parse', 'HEAD'], path)`

## Claude Agent SDK wrapper

### Module `agent-sdk.ts`

```typescript
interface AgentRunParams {
  workdir: string;
  task: string;
  context?: string;
  onProgress: (message: string) => void;
  signal?: AbortSignal;
}

export async function runAgent(params: AgentRunParams): Promise<void>;
```

### Prompt

```
Task: ${task}

Context: ${context ?? 'none'}

Work in the current directory (${cwd}) only. Make all changes needed to complete the task.
Stage changes with git add. Do not commit — the harness will commit staged changes.
```

### Progress mapping

```typescript
function describeToolUse(name: string, input: Record<string, unknown>): string {
  if (name === 'Edit' || name === 'Write') {
    return `${name === 'Edit' ? 'Editing' : 'Writing'} ${input.file_path ?? 'file'}`;
  }
  if (name === 'Bash') {
    return `Running: ${String(input.command ?? '').slice(0, 60)}`;
  }
  if (name === 'Read') {
    return `Reading ${input.file_path ?? 'file'}`;
  }
  return `Tool: ${name}`;
}
```

Iterate SDK stream:
- `assistant.message.content` → for each block:
  - `text` → `onProgress(text.slice(0, 80))`
  - `tool_use` → `onProgress(describeToolUse(block.name, block.input))`
- Check `params.signal?.aborted` each iteration, break if aborted

## Ralphex wrapper (auto mode)

### Module `ralphex.ts`

```typescript
export interface PlanReviewResponse {
  approved: boolean;
  editedPlan?: string;
}

interface RalphexRunParams {
  workdir: string;
  task: string;
  context?: string;
  onProgress: (message: string) => void;
  requestPlanReview: (plan: string) => Promise<PlanReviewResponse>;
  signal?: AbortSignal;
}

export async function runRalphex(params: RalphexRunParams): Promise<void>;
export function buildPlanContent(task: string, context?: string): string;
```

(`PlanReviewResponse` is also exported from `@r2/shared` — imported from there to avoid duplication.)

### Flow

1. `draft = buildPlanContent(task, context)` — deterministic template, no LLM
2. `review = await requestPlanReview(draft)`
3. If `!review.approved` → throw `new Error('Plan rejected by user')`
4. `finalPlan = review.editedPlan ?? draft`
5. `planPath = fs.mkdtempSync(os.tmpdir() + '/r2-task-') + '/plan.md'` with mode 0600
6. `fs.writeFileSync(planPath, finalPlan, { mode: 0o600 })`
7. `try`:
   - `spawn('ralphex', ['--max-iterations', '20', planPath], { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'], shell: false })`
   - Stream stdout/stderr lines via `onProgress(line.slice(0, 120))`
   - Propagate `signal` via `child.kill('SIGTERM')` on abort
   - Resolve on `exit code 0`, reject otherwise
8. `finally`: `fs.rmSync(path.dirname(planPath), { recursive: true, force: true })`

### Plan template

```markdown
# R2 Auto Task

**Goal:** ${task}

**Context:** ${context ?? 'none'}

---

## Task 1: Implement the task

- [ ] **Step 1: Analyze the codebase**

Read relevant files to understand existing patterns.

- [ ] **Step 2: Make the required changes**

Implement the task. Keep changes minimal and focused.

- [ ] **Step 3: Run tests if they exist**

Run: `npx vitest run` in the relevant package.

- [ ] **Step 4: Stage changes**

Run: `git add -A`
(Do not commit — the harness will commit staged changes.)
```

## Commit safety (file denylist)

Before committing, handler filters staged files:

```typescript
const DENYLIST_PATTERNS = [
  /(^|\/)\.env(\.|$)/,
  /\.(key|pem|p12|pfx|asc|gpg)$/,
  /(^|\/)id_rsa(\.|$)/,
  /(^|\/)id_ed25519(\.|$)/,
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\//,
  /(^|\/)\.kube\//,
];

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const SYMLINK_MODE = '120000';
```

Flow:
1. Run agent/ralphex (they do `git add -A` internally)
2. `getStagedFiles(workdir)` → returns `[{ file, mode }]`
3. For each staged file:
   - If `DENYLIST_PATTERNS.some(p => p.test(file))` → unstage + log
   - If `fs.statSync(path.join(workdir, file)).size > MAX_FILE_SIZE` → unstage + log
   - If `mode === SYMLINK_MODE` → unstage + log
4. Collect `blockedFiles: string[]`
5. Proceed with commit (may be empty if all files blocked → return success with `commit: ''`)
6. Result includes `blockedFiles` for visibility

## Shared types (`@r2/shared`)

### `types.ts` additions

```typescript
// Tool definition (moved from server/src/tools/base.ts)
export interface ToolDefinition {
  name: string;
  description: string;
  permissionLevel: 'auto' | 'confirm' | 'forbidden';
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (params: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolResult>;
  preCheck?: (input: Record<string, unknown>) => Promise<{ destructive: boolean; reason: string }>;
}

export interface ToolContext {
  onProgress?: (message: string) => void;
  requestPlanReview?: (plan: string) => Promise<PlanReviewResponse>;
  signal?: AbortSignal;
  meta?: { autoMode?: boolean; callId?: string };
}

export interface PlanReviewResponse {
  approved: boolean;
  editedPlan?: string;
}

// SSE event additions
export type SSEEvent =
  | ... // existing
  | { type: 'tool_progress'; id: string; message: string }
  | { type: 'tool_plan_review'; id: string; task: string; plan: string }
  | { type: 'tool_confirm_request'; toolCall: ToolCall; level: 'confirm' | 'forbidden'; destructiveWarning?: { reason: string } };
```

`server/src/tools/base.ts` becomes a re-export shim for backwards-compat, or is deleted entirely.

## Tool-loop integration

### Changes

1. **preCheck hook** — tool-loop calls `toolDef.preCheck?.(deanonInput)` before permission check. If destructive, force confirmation.
2. **autoMode detection** — if saved rule exists AND not destructive, `autoMode = true` (ralphex path)
3. **Generic** — no hardcoded `if (block.name === 'code_task')`. The `preCheck` hook is the extension point.
4. **Pending plan reviews** — new `PendingPlanReviews` map parallel to `pendingConfirms`

### New tool-loop helper

```typescript
function createPlanReviewRequester(
  callId: string,
  task: string,
  onEvent: (event: SSEEvent) => void,
  pendingPlanReviews: PendingPlanReviews,
  signal?: AbortSignal,
): (plan: string) => Promise<PlanReviewResponse> {
  return (plan: string) => new Promise((resolve) => {
    if (signal?.aborted) { resolve({ approved: false }); return; }
    const onAbort = () => { pendingPlanReviews.delete(callId); resolve({ approved: false }); };
    signal?.addEventListener('abort', onAbort, { once: true });
    pendingPlanReviews.set(callId, (response) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(response);
    });
    onEvent({ type: 'tool_plan_review', id: callId, task, plan });
  });
}
```

### Context building (extracted helper)

```typescript
function buildToolContext(
  block: ToolUseBlock,
  task: string,
  autoMode: boolean,
  onEvent: (event: SSEEvent) => void,
  pendingPlanReviews: PendingPlanReviews,
  signal?: AbortSignal,
): ToolContext {
  return {
    onProgress: (message) => onEvent({ type: 'tool_progress', id: block.id, message }),
    requestPlanReview: createPlanReviewRequester(block.id, task, onEvent, pendingPlanReviews, signal),
    signal,
    meta: { autoMode, callId: block.id },
  };
}
```

Used in both `allowed` paths (auto handler + confirm-allowed handler) — no duplication.

### Server route: POST /api/plan-review

```typescript
// routes/plan-review.ts
export interface PlanReviewResponse {
  approved: boolean;
  editedPlan?: string;
}
export type PendingPlanReviews = Map<string, (r: PlanReviewResponse) => void>;

router.post('/plan-review', (req, res) => {
  const { callId, approved, editedPlan } = req.body;
  // validate types
  // resolve pending, delete from map
  // res.json({ ok: true })
});
```

## Client UI

### PermissionCard — 3 buttons for code_task + destructive warning

- For `toolCall.name === 'code_task'`: render 3 buttons — Allow once (blue), Allow always (green ⭐), Deny (gray)
- Allow always disabled if `destructiveWarning` present
- Destructive warning: red banner above params with reason

### PlanReviewCard (new component)

```tsx
interface Props {
  task: string;
  plan: string;
  onRespond: (callId: string, approved: boolean, editedPlan?: string) => Promise<boolean>;
  callId: string;
}
```

- Shows task text
- `<textarea>` prefilled with plan (editable, min 15 rows)
- Buttons: **Run plan** (blue), **Cancel** (gray)
- On Run: `onRespond(callId, true, textareaValue)`
- On Cancel: `onRespond(callId, false)`

### useChat additions

- New state: `pendingPlanReviews: Map<callId, { task, plan }>`
- `tool_plan_review` event → add to map
- `respondToPlanReview(callId, approved, editedPlan?)` → POST `/api/plan-review` → remove from map
- Handle new SSE events: `tool_progress`, `tool_plan_review`

### MessageBubble

Renders `PlanReviewCard` if `pendingPlanReviews.get(toolCallId)` is set, otherwise falls through to `PermissionCard` or `ToolCallCard`.

### ToolCallCard for code_task

- **Running**: task + pulsing dot + latest `toolCall.progress` message
- **Done (green)**: duration, commit hash, mode (once/ralphex), file list with +/-, blocked files warning, Show diff toggle
- **Error (red)**: error message

## Configuration

```bash
# Phase 3C
R2_DEV_WORKTREE_PREFIX=/tmp/r2-dev-
R2_DEV_BRANCH=dev
R2_DEV_BASE_BRANCH=master
R2_RALPHEX_MAX_ITERATIONS=20
```

## Dependencies

```json
{
  "dependencies": {
    "@r2/shared": "*",
    "@anthropic-ai/claude-agent-sdk": "^0.2.98"
  }
}
```

No server dependency — types moved to `@r2/shared`.

## Testing

### Unit tests (Vitest)

**destructive-check.test.ts**:
- Each pattern triggers destructive=true with correct reason
- Safe task passes (destructive=false)
- Context is scanned
- Case insensitivity where applicable

**shell.test.ts**:
- `run` with mocked execFile, argv passed correctly
- `tryRun` returns ok=false on error, code captured

**worktree.test.ts**:
- `validateWorktreePath` rejects `/`, `~`, missing prefix, `..`
- `ensureWorktree` removes existing then creates fresh
- `removeWorktree` handles non-existent gracefully
- `commitChanges` returns empty on no staged changes
- `commitChanges` uses argv form (no shell)
- `getStagedFiles` returns file + mode

**diff.test.ts**:
- parseDiffStats with normal/empty/binary
- truncateDiff preserves short diffs, marks truncated ones
- summarizeDiff with multiple files

**agent-sdk.test.ts**:
- Progress emission for text blocks
- Progress emission for tool_use (Edit/Write/Bash/Read)
- Cwd passed to SDK
- Signal propagation

**ralphex.test.ts**:
- `buildPlanContent` includes task, context, checkboxes
- `runRalphex` calls `requestPlanReview` with draft plan
- Rejected plan throws "rejected"
- Edited plan is written to file instead of draft
- Non-zero exit throws
- Plan file cleanup in finally

**code-task.test.ts** (integration):
- Requires `task` param
- Happy path: once mode → agent → commit → result
- Happy path: auto mode → ralphex → commit → result
- Auto mode without `requestPlanReview` callback → error
- Denylist blocks `.env`, returns `blockedFiles`
- Worktree cleanup on success
- Worktree cleanup on agent failure
- Diff parse failure doesn't lose commit
- Agent makes no changes → success with empty files

**tool-loop.test.ts** additions:
- `preCheck` hook fires for tool with it defined
- Destructive warning forces confirmation even when saved rule exists
- `autoMode = true` when saved rule exists and not destructive
- `buildToolContext` called with correct arguments
- Plan review event forwarded to pendingPlanReviews map

**routes/plan-review.test.ts** (new):
- Validates callId string
- Validates approved boolean
- 404 on unknown callId
- Removes from map before resolve
- Accepts optional editedPlan

### Manual / E2E

- "Add loading spinner to chat input" → PermissionCard 3 buttons → Allow once → agent edits → diff shown → commit
- Same task → Allow always → next task goes through ralphex path → PlanReviewCard appears → edit plan → Run → ralphex runs → diff
- "Delete all audit log entries" → destructive warning (red banner) with reason, Allow always disabled
- Task that touches .env → denylist blocks, blockedFiles shown in result
- Abort during task (stop button) → worktree `/tmp/r2-dev-<callId>` removed
- Two concurrent code_task calls → different worktrees, no conflict

## What's NOT included

### Deferred to Phase 3D
- Merge dev → master
- Auto-deploy via git watcher
- Rollback/undo commits

### Deferred to Phase 3E
- Eval checks before merge

### Deferred to Phase 3F
- Chat commands (`r2 task`, `r2 deploy`)
- Persistent status bar

### Deferred to backlog (defense in depth)
- sandbox-exec isolation for Agent SDK (current safety: user confirmation + denylist + destructive check)
- Rate limiting (max N code_task per hour)
- Signed commit verification
- Haiku-based destructive check (only if regex proves insufficient)
- Auto-mode TTL/scope (currently persistent rule is fine for single-user)
