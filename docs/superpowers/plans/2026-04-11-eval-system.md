# Eval System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add behavior evals for R2 — save eval pairs through chat, run them against real R2 with a semantic Haiku evaluator, and gate `code_deploy` on eval success.

**Architecture:** Storage in `data/evals.json`. New `store.ts` / `evaluator.ts` / `runner.ts` modules in `packages/server/src/evals/`. Tool registry extended with a `createTool(deps)` factory pattern so tools can receive `runLoop` via DI. Two new tool packages: `@r2/tool-eval-add` (default export) and `@r2/tool-eval-run` (factory). `@r2/tool-code-deploy` refactored to factory so it can run pre-merge evals.

**Tech Stack:** `@anthropic-ai/sdk` (Haiku), `p-limit` (optional — inline semaphore is fine), Vitest, TypeScript monorepo

---

### Task 1: Eval storage module

**Files:**
- Create: `packages/server/src/evals/store.ts`
- Create: `packages/server/src/evals/store.test.ts`

- [x] **Step 1: Write failing tests**

Create `packages/server/src/evals/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadEvals, saveEval, type Eval } from './store.js';

describe('eval store', () => {
  let tmpDir: string;
  let evalsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-evals-'));
    evalsPath = path.join(tmpDir, 'evals.json');
    process.env.EVALS_PATH = evalsPath;
  });

  afterEach(() => {
    delete process.env.EVALS_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when file does not exist', async () => {
    const evals = await loadEvals();
    expect(evals).toEqual([]);
  });

  it('returns empty array when file has empty JSON array', async () => {
    fs.writeFileSync(evalsPath, '[]');
    const evals = await loadEvals();
    expect(evals).toEqual([]);
  });

  it('throws on malformed JSON', async () => {
    fs.writeFileSync(evalsPath, 'not json');
    await expect(loadEvals()).rejects.toThrow(/Failed to parse/);
  });

  it('saves and loads a single eval', async () => {
    const e: Eval = {
      id: 'eval-1',
      input: 'hello',
      expected: 'reply with world',
      toolUseExpected: null,
      createdAt: '2026-04-11T00:00:00.000Z',
    };
    await saveEval(e);
    const list = await loadEvals();
    expect(list).toEqual([e]);
  });

  it('appends a second eval without losing the first', async () => {
    await saveEval({
      id: 'a',
      input: 'q1',
      expected: 'e1',
      toolUseExpected: null,
      createdAt: '2026-04-11T00:00:00.000Z',
    });
    await saveEval({
      id: 'b',
      input: 'q2',
      expected: 'e2',
      toolUseExpected: ['web_search'],
      createdAt: '2026-04-11T00:00:01.000Z',
    });

    const list = await loadEvals();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('a');
    expect(list[1].id).toBe('b');
    expect(list[1].toolUseExpected).toEqual(['web_search']);
  });

  it('creates parent directory if missing', async () => {
    evalsPath = path.join(tmpDir, 'sub', 'evals.json');
    process.env.EVALS_PATH = evalsPath;

    await saveEval({
      id: 'x',
      input: 'q',
      expected: 'e',
      toolUseExpected: null,
      createdAt: '2026-04-11T00:00:00.000Z',
    });

    expect(fs.existsSync(evalsPath)).toBe(true);
  });

  it('atomic write: uses tmp + rename', async () => {
    await saveEval({
      id: 'atomic',
      input: 'q',
      expected: 'e',
      toolUseExpected: null,
      createdAt: '2026-04-11T00:00:00.000Z',
    });
    // No leftover tmp file
    expect(fs.existsSync(`${evalsPath}.tmp`)).toBe(false);
    expect(fs.existsSync(evalsPath)).toBe(true);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/evals/store.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement store module**

Create `packages/server/src/evals/store.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';

export interface Eval {
  id: string;
  input: string;
  expected: string;
  toolUseExpected: string[] | null;
  createdAt: string;
}

function getEvalsPath(): string {
  return process.env.EVALS_PATH || path.resolve(process.cwd(), 'data', 'evals.json');
}

export async function loadEvals(): Promise<Eval[]> {
  const filePath = getEvalsPath();
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.trim().length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse evals file at ${filePath}: ${err instanceof Error ? err.message : 'invalid JSON'}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Failed to parse evals file at ${filePath}: expected array`);
  }
  return parsed as Eval[];
}

export async function saveEval(newEval: Eval): Promise<void> {
  const filePath = getEvalsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const list = await loadEvals();
  list.push(newEval);

  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(list, null, 2));
  fs.renameSync(tmpPath, filePath);
}
```

- [x] **Step 4: Run tests**

Run: `cd packages/server && npx vitest run src/evals/store.test.ts`
Expected: all 7 tests PASS.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/evals/store.ts packages/server/src/evals/store.test.ts
git commit -m "feat: add eval store with atomic JSON persistence"
```

---

### Task 2: Semantic evaluator module

**Files:**
- Create: `packages/server/src/evals/evaluator.ts`
- Create: `packages/server/src/evals/evaluator.test.ts`

- [x] **Step 1: Write failing tests**

Create `packages/server/src/evals/evaluator.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluate } from './evaluator.js';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

describe('evaluate', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('parses passed=true response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"passed": true, "reason": "matches expected"}' }],
    });

    const result = await evaluate({
      input: 'hi',
      expected: 'greeting',
      actualText: 'hello',
      actualToolCalls: [],
      toolUseExpected: null,
    });

    expect(result).toEqual({ passed: true, reason: 'matches expected' });
  });

  it('parses passed=false response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"passed": false, "reason": "facts wrong"}' }],
    });

    const result = await evaluate({
      input: 'math',
      expected: '4',
      actualText: '5',
      actualToolCalls: [],
      toolUseExpected: null,
    });

    expect(result.passed).toBe(false);
  });

  it('sends toolUseExpected in user message when provided', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"passed": true, "reason": "ok"}' }],
    });

    await evaluate({
      input: 'weather',
      expected: 'use search',
      actualText: 'sunny',
      actualToolCalls: ['web_search'],
      toolUseExpected: ['web_search'],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const userMsg = callArgs.messages[0].content;
    expect(userMsg).toContain('web_search');
  });

  it('fail-closed on API error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API down'));

    const result = await evaluate({
      input: 'hi',
      expected: 'greeting',
      actualText: 'hello',
      actualToolCalls: [],
      toolUseExpected: null,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('API');
  });

  it('fail-closed on invalid JSON', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not json' }],
    });

    const result = await evaluate({
      input: 'hi',
      expected: 'greeting',
      actualText: 'hello',
      actualToolCalls: [],
      toolUseExpected: null,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('invalid JSON');
  });

  it('fail-closed on missing fields', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"only": "this"}' }],
    });

    const result = await evaluate({
      input: 'hi',
      expected: 'greeting',
      actualText: 'hello',
      actualToolCalls: [],
      toolUseExpected: null,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('incomplete');
  });

  it('uses CLAUDE_HAIKU_MODEL env when set', async () => {
    process.env.CLAUDE_HAIKU_MODEL = 'custom-haiku';
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"passed": true, "reason": "ok"}' }],
    });

    await evaluate({
      input: 'hi',
      expected: 'greeting',
      actualText: 'hello',
      actualToolCalls: [],
      toolUseExpected: null,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'custom-haiku' }),
    );
    delete process.env.CLAUDE_HAIKU_MODEL;
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/evals/evaluator.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement evaluator**

Create `packages/server/src/evals/evaluator.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';

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

const SYSTEM_PROMPT = `You evaluate AI assistant responses. Given a user input, expected behavior, what the assistant actually said, and which tools it called, decide if the response meets the expectation.

Rules:
- "expected" is a natural language description of correct behavior.
- "actualText" is the assistant's final text response (may be empty if it only used tools).
- "actualToolCalls" lists tool names the assistant invoked during the conversation.
- If "toolUseExpected" is not empty, ALL those tools MUST be in actualToolCalls. Missing any = fail.
- Be lenient on phrasing, strict on facts and required tools.
- If facts are wrong, fail.
- If required tools were not called, fail.

Reply ONLY with valid JSON: {"passed": true|false, "reason": "short explanation"}`;

export async function evaluate(input: EvaluatorInput): Promise<EvaluatorResult> {
  let client: Anthropic;
  try {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  } catch (err) {
    return { passed: false, reason: `evaluator API error: ${err instanceof Error ? err.message : 'init failed'}` };
  }

  const model = process.env.CLAUDE_HAIKU_MODEL || 'claude-haiku-4-5-20251001';

  const userContent = [
    `Input: ${input.input}`,
    `Expected: ${input.expected}`,
    `Actual text: ${input.actualText || '(empty)'}`,
    `Actual tools: ${input.actualToolCalls.length > 0 ? input.actualToolCalls.join(', ') : '(none)'}`,
    `Expected tools: ${input.toolUseExpected && input.toolUseExpected.length > 0 ? input.toolUseExpected.join(', ') : 'any'}`,
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });
  } catch (err) {
    return {
      passed: false,
      reason: `evaluator API error: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return { passed: false, reason: 'evaluator returned no text' };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    return { passed: false, reason: 'evaluator returned invalid JSON' };
  }

  if (typeof parsed.passed !== 'boolean' || typeof parsed.reason !== 'string') {
    return { passed: false, reason: 'evaluator returned incomplete result' };
  }

  return { passed: parsed.passed, reason: parsed.reason };
}
```

- [x] **Step 4: Run tests**

Run: `cd packages/server && npx vitest run src/evals/evaluator.test.ts`
Expected: all 7 tests PASS.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/evals/evaluator.ts packages/server/src/evals/evaluator.test.ts
git commit -m "feat: add semantic Haiku evaluator with fail-closed error handling"
```

---

### Task 3: Eval runner module

**Files:**
- Create: `packages/server/src/evals/runner.ts`
- Create: `packages/server/src/evals/runner.test.ts`

- [x] **Step 1: Write failing tests**

Create `packages/server/src/evals/runner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runSingleEval, runAllEvals, type EvalResult } from './runner.js';
import type { Eval } from './store.js';

const mockEvaluate = vi.fn();
vi.mock('./evaluator.js', () => ({
  evaluate: (...args: any[]) => mockEvaluate(...args),
}));

describe('runSingleEval', () => {
  beforeEach(() => {
    mockEvaluate.mockReset();
  });

  it('captures text_delta events as actualText', async () => {
    mockEvaluate.mockResolvedValueOnce({ passed: true, reason: 'ok' });

    const fakeRunLoop = vi.fn(async ({ onEvent }) => {
      onEvent({ type: 'text_delta', content: 'Hello ' });
      onEvent({ type: 'text_delta', content: 'world' });
      onEvent({ type: 'done' });
    });

    const e: Eval = { id: 'e1', input: 'hi', expected: 'greeting', toolUseExpected: null, createdAt: '2026-04-11T00:00:00Z' };
    const result = await runSingleEval(e, fakeRunLoop as any);

    expect(result.actualText).toBe('Hello world');
    expect(result.passed).toBe(true);
    expect(mockEvaluate).toHaveBeenCalledWith(expect.objectContaining({
      actualText: 'Hello world',
    }));
  });

  it('captures tool_call_start names as actualToolCalls', async () => {
    mockEvaluate.mockResolvedValueOnce({ passed: true, reason: 'ok' });

    const fakeRunLoop = vi.fn(async ({ onEvent }) => {
      onEvent({ type: 'tool_call_start', toolCall: { id: 't1', name: 'web_search', input: {}, status: 'running' } });
      onEvent({ type: 'tool_call_start', toolCall: { id: 't2', name: 'file_read', input: {}, status: 'running' } });
      onEvent({ type: 'done' });
    });

    const e: Eval = { id: 'e2', input: 'search', expected: 'find', toolUseExpected: null, createdAt: '2026-04-11T00:00:00Z' };
    const result = await runSingleEval(e, fakeRunLoop as any);

    expect(result.actualToolCalls).toEqual(['web_search', 'file_read']);
  });

  it('returns fail result when runLoop throws', async () => {
    const fakeRunLoop = vi.fn(async () => {
      throw new Error('loop crashed');
    });

    const e: Eval = { id: 'e3', input: 'hi', expected: 'greeting', toolUseExpected: null, createdAt: '2026-04-11T00:00:00Z' };
    const result = await runSingleEval(e, fakeRunLoop as any);

    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/run error/);
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it('forwards toolUseExpected to evaluator', async () => {
    mockEvaluate.mockResolvedValueOnce({ passed: true, reason: 'ok' });
    const fakeRunLoop = vi.fn(async ({ onEvent }) => {
      onEvent({ type: 'done' });
    });

    const e: Eval = { id: 'e4', input: 'q', expected: 'exp', toolUseExpected: ['web_search'], createdAt: '2026-04-11T00:00:00Z' };
    await runSingleEval(e, fakeRunLoop as any);

    expect(mockEvaluate).toHaveBeenCalledWith(expect.objectContaining({
      toolUseExpected: ['web_search'],
    }));
  });
});

describe('runAllEvals', () => {
  let tmpDir: string;

  beforeEach(() => {
    mockEvaluate.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-runner-'));
    process.env.EVALS_PATH = path.join(tmpDir, 'evals.json');
  });

  afterEach(() => {
    delete process.env.EVALS_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns zeros when evals file is empty', async () => {
    fs.writeFileSync(process.env.EVALS_PATH!, '[]');
    const fakeRunLoop = vi.fn();

    const result = await runAllEvals(fakeRunLoop as any, { concurrency: 3 });

    expect(result).toEqual({ passed: 0, failed: 0, results: [] });
    expect(fakeRunLoop).not.toHaveBeenCalled();
  });

  it('runs all evals and counts passes/fails', async () => {
    fs.writeFileSync(process.env.EVALS_PATH!, JSON.stringify([
      { id: 'a', input: 'q1', expected: 'e1', toolUseExpected: null, createdAt: '2026-04-11T00:00:00Z' },
      { id: 'b', input: 'q2', expected: 'e2', toolUseExpected: null, createdAt: '2026-04-11T00:00:01Z' },
      { id: 'c', input: 'q3', expected: 'e3', toolUseExpected: null, createdAt: '2026-04-11T00:00:02Z' },
    ]));

    mockEvaluate
      .mockResolvedValueOnce({ passed: true, reason: 'ok' })
      .mockResolvedValueOnce({ passed: false, reason: 'wrong' })
      .mockResolvedValueOnce({ passed: true, reason: 'ok' });

    const fakeRunLoop = vi.fn(async ({ onEvent }) => {
      onEvent({ type: 'text_delta', content: 'response' });
      onEvent({ type: 'done' });
    });

    const result = await runAllEvals(fakeRunLoop as any, { concurrency: 3 });

    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results).toHaveLength(3);
  });

  it('invokes onProgress for each eval', async () => {
    fs.writeFileSync(process.env.EVALS_PATH!, JSON.stringify([
      { id: 'x', input: 'q', expected: 'e', toolUseExpected: null, createdAt: '2026-04-11T00:00:00Z' },
      { id: 'y', input: 'q', expected: 'e', toolUseExpected: null, createdAt: '2026-04-11T00:00:01Z' },
    ]));

    mockEvaluate.mockResolvedValue({ passed: true, reason: 'ok' });

    const fakeRunLoop = vi.fn(async ({ onEvent }) => { onEvent({ type: 'done' }); });
    const progress: string[] = [];

    await runAllEvals(fakeRunLoop as any, { concurrency: 2, onProgress: (m) => progress.push(m) });

    expect(progress.some((p) => p.includes('1/2'))).toBe(true);
    expect(progress.some((p) => p.includes('2/2'))).toBe(true);
  });

  it('respects concurrency limit', async () => {
    fs.writeFileSync(process.env.EVALS_PATH!, JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({
        id: `e${i}`,
        input: 'q',
        expected: 'e',
        toolUseExpected: null,
        createdAt: '2026-04-11T00:00:00Z',
      })),
    ));

    mockEvaluate.mockResolvedValue({ passed: true, reason: 'ok' });

    let active = 0;
    let peak = 0;
    const fakeRunLoop = vi.fn(async ({ onEvent }) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      onEvent({ type: 'done' });
    });

    await runAllEvals(fakeRunLoop as any, { concurrency: 2 });

    expect(peak).toBeLessThanOrEqual(2);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/evals/runner.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement runner**

Create `packages/server/src/evals/runner.ts`:

```typescript
import type { SSEEvent } from '@r2/shared';
import type { Eval } from './store.js';
import { loadEvals } from './store.js';
import { evaluate } from './evaluator.js';

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

type RunLoopFn = (params: {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
}) => Promise<void>;

export async function runSingleEval(
  target: Eval,
  runLoop: RunLoopFn,
  signal?: AbortSignal,
): Promise<EvalResult> {
  let actualText = '';
  const actualToolCalls: string[] = [];

  const onEvent = (event: SSEEvent) => {
    if (event.type === 'text_delta') {
      actualText += event.content;
    } else if (event.type === 'tool_call_start') {
      actualToolCalls.push(event.toolCall.name);
    }
  };

  try {
    await runLoop({
      messages: [{ role: 'user', content: target.input }],
      onEvent,
      signal,
    });
  } catch (err) {
    return {
      evalId: target.id,
      input: target.input,
      passed: false,
      reason: `run error: ${err instanceof Error ? err.message : 'unknown'}`,
      actualText,
      actualToolCalls,
    };
  }

  const result = await evaluate({
    input: target.input,
    expected: target.expected,
    actualText,
    actualToolCalls,
    toolUseExpected: target.toolUseExpected,
  });

  return {
    evalId: target.id,
    input: target.input,
    passed: result.passed,
    reason: result.reason,
    actualText,
    actualToolCalls,
  };
}

async function withLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let index = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push((async () => {
      while (index < items.length) {
        const current = index++;
        await fn(items[current], current);
      }
    })());
  }
  await Promise.all(workers);
}

export async function runAllEvals(
  runLoop: RunLoopFn,
  options: RunAllOptions,
): Promise<RunAllResult> {
  const evals = await loadEvals();
  if (evals.length === 0) {
    return { passed: 0, failed: 0, results: [] };
  }

  const results: EvalResult[] = new Array(evals.length);
  const concurrency = Math.max(1, options.concurrency);

  await withLimit(evals, concurrency, async (target, i) => {
    options.onProgress?.(`Running eval ${i + 1}/${evals.length}: ${target.id}`);
    results[i] = await runSingleEval(target, runLoop, options.signal);
  });

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  return { passed, failed, results };
}
```

- [x] **Step 4: Run tests**

Run: `cd packages/server && npx vitest run src/evals/runner.test.ts`
Expected: all tests PASS.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/evals/runner.ts packages/server/src/evals/runner.test.ts
git commit -m "feat: add eval runner with concurrency control"
```

---

### Task 4: Extend tool registry with createTool factory

**Files:**
- Modify: `packages/server/src/tools/base.ts`
- Modify: `packages/server/src/tools/registry.ts`
- Modify: `packages/server/src/tools/__tests__/registry.test.ts` (create if not exists)

- [x] **Step 1: Add ToolDeps type to base.ts**

In `packages/server/src/tools/base.ts`, add after existing re-exports:

```typescript
import type { PiiProxy } from '../pii/proxy.js';
import type { ClaudeClient } from '../ai/claude.js';
import type { ToolRegistry } from './registry.js';
import type { SSEEvent, ToolDefinition } from '@r2/shared';
import type { PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';

export interface RunLoopParams {
  messages: Array<{ role: 'user' | 'assistant'; content: string }> | any;
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
  pendingPlanReviews?: PendingPlanReviews;
}

export type RunLoopFn = (params: RunLoopParams) => Promise<void>;

export interface ToolDeps {
  runLoop: RunLoopFn;
  client: ClaudeClient;
  registry: ToolRegistry;
  piiProxy: PiiProxy;
}

export type ToolFactory = (deps: ToolDeps) => ToolDefinition | ToolDefinition[];
```

(Keep existing `export type { ToolDefinition, ToolContext, PlanReviewResponse } from '@r2/shared';` and `toClaudeTool` function as-is.)

- [x] **Step 2: Write failing test for registry factory support**

Create or extend `packages/server/src/tools/__tests__/registry.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRegistry, discoverTools } from '../registry.js';

describe('createRegistry', () => {
  it('registers and retrieves tools', () => {
    const registry = createRegistry();
    const tool = {
      name: 'echo',
      description: 'echo',
      permissionLevel: 'auto' as const,
      parameters: { type: 'object' as const, properties: {} },
      handler: async () => ({ success: true }),
    };

    registry.register(tool);
    expect(registry.get('echo')).toBe(tool);
    expect(registry.getAll()).toHaveLength(1);
  });

  it('throws on duplicate registration', () => {
    const registry = createRegistry();
    const tool = {
      name: 'echo',
      description: 'echo',
      permissionLevel: 'auto' as const,
      parameters: { type: 'object' as const, properties: {} },
      handler: async () => ({ success: true }),
    };
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow(/already registered/);
  });
});

describe('discoverTools with factory support', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-registry-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createFakeToolPackage(name: string, exportCode: string) {
    const pkgDir = path.join(tmpDir, name);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: `@r2/${name}`,
      main: 'index.mjs',
    }));
    fs.writeFileSync(path.join(pkgDir, 'index.mjs'), exportCode);
  }

  it('loads default export (backward compatibility)', async () => {
    await createFakeToolPackage('tool-echo', `
      export default {
        name: 'echo',
        description: 'echoes',
        permissionLevel: 'auto',
        parameters: { type: 'object', properties: {} },
        handler: async () => ({ success: true }),
      };
    `);

    const registry = createRegistry();
    await discoverTools(registry, undefined, tmpDir);

    expect(registry.get('echo')).toBeDefined();
  });

  it('loads createTool factory when deps provided', async () => {
    await createFakeToolPackage('tool-di', `
      export function createTool(deps) {
        return {
          name: 'di_tool',
          description: 'needs deps',
          permissionLevel: 'auto',
          parameters: { type: 'object', properties: {} },
          handler: async () => ({ success: true, data: { hasRunLoop: typeof deps.runLoop === 'function' } }),
        };
      }
    `);

    const registry = createRegistry();
    const deps = {
      runLoop: async () => {},
      client: {} as any,
      registry,
      piiProxy: {} as any,
    };
    await discoverTools(registry, deps, tmpDir);

    expect(registry.get('di_tool')).toBeDefined();
    const result = await registry.get('di_tool')!.handler({});
    expect((result.data as any).hasRunLoop).toBe(true);
  });

  it('skips factory packages when deps missing', async () => {
    await createFakeToolPackage('tool-di-only', `
      export function createTool(deps) {
        return {
          name: 'di_only',
          description: 'deps required',
          permissionLevel: 'auto',
          parameters: { type: 'object', properties: {} },
          handler: async () => ({ success: true }),
        };
      }
    `);

    const registry = createRegistry();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await discoverTools(registry, undefined, tmpDir);

    expect(registry.get('di_only')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('di-only'));
    warnSpy.mockRestore();
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `cd packages/server && npx vitest run src/tools/__tests__/registry.test.ts`
Expected: FAIL — `discoverTools` signature mismatch or factory not supported.

- [x] **Step 4: Refactor registry.ts to support factories**

Replace `packages/server/src/tools/registry.ts` with:

```typescript
import type { ToolDefinition } from '@r2/shared';
import type { ToolDeps } from './base.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
}

export function createRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool: ToolDefinition): void {
      if (tools.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" already registered`);
      }
      tools.set(tool.name, tool);
    },

    get(name: string): ToolDefinition | undefined {
      return tools.get(name);
    },

    getAll(): ToolDefinition[] {
      return [...tools.values()];
    },
  };
}

export async function discoverTools(
  registry?: ToolRegistry,
  deps?: ToolDeps,
  packagesDir?: string,
): Promise<ToolRegistry> {
  const reg = registry ?? createRegistry();
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const dir = packagesDir ?? path.resolve(thisDir, '..', '..', '..');

  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((name) => name.startsWith('tool-'));
  } catch (err) {
    console.warn(
      `WARNING: Could not read packages directory "${dir}":`,
      err instanceof Error ? err.message : err,
    );
    console.warn('WARNING: No tools were discovered. The assistant will not be able to use any tools.');
    return reg;
  }

  for (const entry of entries) {
    const toolPackageName = `@r2/${entry}`;
    try {
      let mod: any;
      try {
        mod = await import(toolPackageName);
      } catch {
        const pkgJsonPath = path.join(dir, entry, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
          const main = pkgJson.main || 'index.js';
          const entryPath = path.resolve(dir, entry, main);
          mod = await import(pathToFileURL(entryPath).href);
        } else {
          throw new Error(`Cannot resolve ${toolPackageName}`);
        }
      }

      let toRegister: ToolDefinition[] = [];

      if (typeof mod.createTool === 'function') {
        if (!deps) {
          console.warn(
            `WARNING: Tool package ${entry} exports createTool factory but no deps were provided; skipping.`,
          );
          continue;
        }
        const result = mod.createTool(deps);
        toRegister = Array.isArray(result) ? result : [result];
      } else if (mod.default) {
        toRegister = Array.isArray(mod.default) ? mod.default : [mod.default];
      }

      for (const tool of toRegister) {
        if (tool && typeof tool.name === 'string' && typeof tool.handler === 'function') {
          reg.register(tool);
          console.log(`  Tool discovered: ${tool.name} (${entry})`);
        }
      }
    } catch (err) {
      console.error(`  Failed to load tool ${entry}:`, err instanceof Error ? err.message : err);
    }
  }

  const toolCount = reg.getAll().length;
  if (toolCount === 0) {
    console.warn('WARNING: No tools were discovered. The assistant will not be able to use any tools.');
  } else {
    console.log(`Tools loaded: ${toolCount}`);
  }
  return reg;
}
```

- [x] **Step 5: Run tests**

Run: `cd packages/server && npx vitest run src/tools/__tests__/registry.test.ts`
Expected: all tests PASS.

- [x] **Step 6: Update index.ts to create registry first, then discover with deps**

In `packages/server/src/index.ts`, replace the tool discovery block (around line 74-77):

```typescript
// Before: const registry = await discoverTools();

// Create empty registry first so we can bake it into runLoop closure
import { createRegistry } from './tools/registry.js';
const registry = createRegistry();

// Setup
const client = createClaudeClient();
const pendingConfirms: PendingConfirms = new Map();
const pendingPlanReviews: PendingPlanReviews = new Map();

// Bound runLoop closure — tool factories use this
const runLoopFn = (params: any) =>
  runToolLoop({
    client,
    registry,
    piiProxy,
    ...params,
  });

// Now discover tools with deps (fills registry in-place)
await discoverTools(registry, {
  runLoop: runLoopFn,
  client,
  registry,
  piiProxy,
});
```

- [x] **Step 7: Full server typecheck and tests**

Run: `npx tsc --noEmit -p packages/server/tsconfig.json && cd packages/server && npx vitest run`
Expected: no type errors, all tests pass.

- [x] **Step 8: Commit**

```bash
git add packages/server/src/tools/base.ts packages/server/src/tools/registry.ts packages/server/src/tools/__tests__/registry.test.ts packages/server/src/index.ts
git commit -m "feat: add createTool factory pattern to tool registry"
```

---

### Task 5: `@r2/tool-eval-add` package

**Files:**
- Create: `packages/tool-eval-add/package.json`
- Create: `packages/tool-eval-add/tsconfig.json`
- Create: `packages/tool-eval-add/src/index.ts`
- Create: `packages/tool-eval-add/src/__tests__/eval-add.test.ts`

- [x] **Step 1: Scaffold package**

Create `packages/tool-eval-add/package.json`:

```json
{
  "name": "@r2/tool-eval-add",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@r2/shared": "*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.1.0"
  }
}
```

Create `packages/tool-eval-add/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [x] **Step 2: Write failing tests**

Create `packages/tool-eval-add/src/__tests__/eval-add.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { evalAddTool } from '../index.js';

describe('evalAddTool', () => {
  let tmpDir: string;
  let evalsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-eval-add-'));
    evalsPath = path.join(tmpDir, 'evals.json');
    process.env.EVALS_PATH = evalsPath;
  });

  afterEach(() => {
    delete process.env.EVALS_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates file with first eval', async () => {
    const result = await evalAddTool.handler({
      input: 'what is 2+2',
      expected: 'reply 4',
    });

    expect(result.success).toBe(true);
    const list = JSON.parse(fs.readFileSync(evalsPath, 'utf8'));
    expect(list).toHaveLength(1);
    expect(list[0].input).toBe('what is 2+2');
    expect(list[0].expected).toBe('reply 4');
    expect(list[0].toolUseExpected).toBeNull();
    expect(list[0].id).toBeTruthy();
    expect(list[0].createdAt).toBeTruthy();
  });

  it('appends to existing file', async () => {
    fs.writeFileSync(evalsPath, JSON.stringify([
      { id: 'old', input: 'q', expected: 'e', toolUseExpected: null, createdAt: '2026-04-11T00:00:00Z' },
    ]));

    await evalAddTool.handler({
      input: 'new q',
      expected: 'new e',
    });

    const list = JSON.parse(fs.readFileSync(evalsPath, 'utf8'));
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('old');
  });

  it('stores toolUseExpected array', async () => {
    await evalAddTool.handler({
      input: 'search',
      expected: 'find weather',
      toolUseExpected: ['web_search'],
    });

    const list = JSON.parse(fs.readFileSync(evalsPath, 'utf8'));
    expect(list[0].toolUseExpected).toEqual(['web_search']);
  });

  it('rejects empty input', async () => {
    const result = await evalAddTool.handler({
      input: '',
      expected: 'something',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/required/);
  });

  it('rejects empty expected', async () => {
    const result = await evalAddTool.handler({
      input: 'q',
      expected: '',
    });
    expect(result.success).toBe(false);
  });

  it('has confirm permission level', () => {
    expect(evalAddTool.permissionLevel).toBe('confirm');
  });

  it('atomic write leaves no tmp file', async () => {
    await evalAddTool.handler({ input: 'q', expected: 'e' });
    expect(fs.existsSync(`${evalsPath}.tmp`)).toBe(false);
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `cd packages/tool-eval-add && npm install && npx vitest run`
Expected: FAIL — module not found.

- [x] **Step 4: Implement tool**

Create `packages/tool-eval-add/src/index.ts`:

```typescript
import type { ToolDefinition, ToolResult } from '@r2/shared';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function getEvalsPath(): string {
  return process.env.EVALS_PATH || path.resolve(process.cwd(), 'data', 'evals.json');
}

function loadList(): any[] {
  const filePath = getEvalsPath();
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeList(list: any[]): void {
  const filePath = getEvalsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(list, null, 2));
  fs.renameSync(tmpPath, filePath);
}

export const evalAddTool: ToolDefinition = {
  name: 'eval_add',
  description: 'Save a new behavior eval for R2. Use when user says "this is wrong, should be X", or explicitly asks to remember correct behavior. Persists to data/evals.json for pre-merge regression checks.',
  permissionLevel: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The user message that triggered the wrong behavior' },
      expected: { type: 'string', description: 'Natural language description of correct behavior' },
      toolUseExpected: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: tools R2 must call to pass this eval',
      },
    },
    required: ['input', 'expected'],
  },
  async handler(params: Record<string, unknown>): Promise<ToolResult> {
    const input = typeof params.input === 'string' ? params.input.trim() : '';
    const expected = typeof params.expected === 'string' ? params.expected.trim() : '';
    const toolUseExpected = Array.isArray(params.toolUseExpected)
      ? (params.toolUseExpected as unknown[]).filter((x): x is string => typeof x === 'string')
      : null;

    if (input.length === 0) {
      return { success: false, error: 'input is required' };
    }
    if (expected.length === 0) {
      return { success: false, error: 'expected is required' };
    }

    const newEval = {
      id: crypto.randomUUID(),
      input,
      expected,
      toolUseExpected: toolUseExpected && toolUseExpected.length > 0 ? toolUseExpected : null,
      createdAt: new Date().toISOString(),
    };

    try {
      const list = loadList();
      list.push(newEval);
      writeList(list);

      return {
        success: true,
        data: { id: newEval.id, totalEvals: list.length },
        display: {
          type: 'text',
          content: `Saved eval "${newEval.id}". Total evals: ${list.length}.`,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'failed to save eval',
      };
    }
  },
};

export default evalAddTool;
```

- [x] **Step 5: Install and run tests**

Run: `npm install && cd packages/tool-eval-add && npx vitest run`
Expected: all tests PASS.

- [x] **Step 6: Commit**

```bash
git add packages/tool-eval-add/ package.json package-lock.json
git commit -m "feat: add @r2/tool-eval-add — save behavior evals from chat"
```

---

### Task 6: `@r2/tool-eval-run` package with factory

**Files:**
- Create: `packages/tool-eval-run/package.json`
- Create: `packages/tool-eval-run/tsconfig.json`
- Create: `packages/tool-eval-run/src/index.ts`
- Create: `packages/tool-eval-run/src/__tests__/eval-run.test.ts`

- [x] **Step 1: Scaffold package**

Create `packages/tool-eval-run/package.json`:

```json
{
  "name": "@r2/tool-eval-run",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@r2/shared": "*",
    "@r2/server": "*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.1.0"
  }
}
```

Create `packages/tool-eval-run/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [x] **Step 2: Write failing tests**

Create `packages/tool-eval-run/src/__tests__/eval-run.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRunAllEvals = vi.fn();
vi.mock('@r2/server/evals/runner.js', () => ({
  runAllEvals: (...args: any[]) => mockRunAllEvals(...args),
}));

import { createTool } from '../index.js';

describe('eval_run tool', () => {
  const deps = {
    runLoop: vi.fn(),
    client: {} as any,
    registry: {} as any,
    piiProxy: {} as any,
  };

  beforeEach(() => {
    mockRunAllEvals.mockReset();
  });

  it('creates tool with expected name and confirm permission', () => {
    const tool = createTool(deps);
    expect(tool.name).toBe('eval_run');
    expect(tool.permissionLevel).toBe('confirm');
  });

  it('returns success when all evals pass', async () => {
    mockRunAllEvals.mockResolvedValueOnce({
      passed: 3,
      failed: 0,
      results: [
        { evalId: 'a', input: 'q', passed: true, reason: 'ok', actualText: 'r', actualToolCalls: [] },
        { evalId: 'b', input: 'q', passed: true, reason: 'ok', actualText: 'r', actualToolCalls: [] },
        { evalId: 'c', input: 'q', passed: true, reason: 'ok', actualText: 'r', actualToolCalls: [] },
      ],
    });

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(true);
    expect((result.data as any).passed).toBe(3);
    expect((result.data as any).failed).toBe(0);
  });

  it('returns failure when any eval fails', async () => {
    mockRunAllEvals.mockResolvedValueOnce({
      passed: 1,
      failed: 1,
      results: [
        { evalId: 'a', input: 'q', passed: true, reason: 'ok', actualText: 'r', actualToolCalls: [] },
        { evalId: 'b', input: 'q', passed: false, reason: 'wrong', actualText: 'r', actualToolCalls: [] },
      ],
    });

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.display?.content).toContain('wrong');
  });

  it('returns success:true with zero evals', async () => {
    mockRunAllEvals.mockResolvedValueOnce({ passed: 0, failed: 0, results: [] });

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(true);
    expect(result.display?.content).toContain('0 passed');
  });

  it('forwards onProgress to runAllEvals', async () => {
    mockRunAllEvals.mockResolvedValueOnce({ passed: 0, failed: 0, results: [] });

    const tool = createTool(deps);
    const progress: string[] = [];
    await tool.handler({}, { onProgress: (m) => progress.push(m) });

    expect(mockRunAllEvals).toHaveBeenCalledWith(
      deps.runLoop,
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
  });

  it('handles runAllEvals throwing', async () => {
    mockRunAllEvals.mockRejectedValueOnce(new Error('runner crashed'));

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/runner crashed/);
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `cd packages/tool-eval-run && npm install && npx vitest run`
Expected: FAIL — module not found.

- [x] **Step 4: Implement tool**

Create `packages/tool-eval-run/src/index.ts`:

```typescript
import type { ToolDefinition, ToolResult, ToolContext } from '@r2/shared';
import type { ToolDeps } from '@r2/server/tools/base.js';
import { runAllEvals } from '@r2/server/evals/runner.js';
import type { EvalResult } from '@r2/server/evals/runner.js';

function formatSummary(input: { passed: number; failed: number; results: EvalResult[] }): string {
  const header = `Evals: ${input.passed} passed, ${input.failed} failed`;
  const failures = input.results
    .filter((r) => !r.passed)
    .map((r) => `  ✗ ${r.evalId}: ${r.reason}`);
  return failures.length > 0 ? `${header}\n${failures.join('\n')}` : header;
}

export function createTool(deps: ToolDeps): ToolDefinition {
  return {
    name: 'eval_run',
    description: 'Run all behavior evals against the current R2. Returns pass/fail summary with details. Use when user asks to check regressions or before deploying.',
    permissionLevel: 'confirm',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async handler(_params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
      const onProgress = ctx?.onProgress ?? (() => {});
      onProgress('Loading evals...');

      try {
        const { passed, failed, results } = await runAllEvals(deps.runLoop as any, {
          concurrency: parseInt(process.env.EVAL_CONCURRENCY || '3', 10),
          onProgress,
          signal: ctx?.signal,
        });

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
```

- [x] **Step 5: Install and run tests**

Run: `npm install && cd packages/tool-eval-run && npx vitest run`
Expected: all tests PASS.

- [x] **Step 6: Commit**

```bash
git add packages/tool-eval-run/ package.json package-lock.json
git commit -m "feat: add @r2/tool-eval-run — run all evals via createTool factory"
```

---

### Task 7: Refactor `@r2/tool-code-deploy` to factory + pre-merge evals

**Files:**
- Modify: `packages/tool-code-deploy/package.json`
- Modify: `packages/tool-code-deploy/src/index.ts`
- Modify: `packages/tool-code-deploy/src/__tests__/code-deploy.test.ts`

- [x] **Step 1: Add @r2/server dep to package.json**

In `packages/tool-code-deploy/package.json`, add to dependencies:

```json
"dependencies": {
  "@r2/shared": "*",
  "@r2/server": "*"
}
```

- [x] **Step 2: Update tests to cover factory + pre-merge evals**

Replace `packages/tool-code-deploy/src/__tests__/code-deploy.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockRunAllEvals = vi.fn();
vi.mock('@r2/server/evals/runner.js', () => ({
  runAllEvals: (...args: any[]) => mockRunAllEvals(...args),
}));

import { createTool } from '../index.js';

describe('code_deploy tool', () => {
  const deps = {
    runLoop: vi.fn(),
    client: {} as any,
    registry: {} as any,
    piiProxy: {} as any,
  };

  beforeEach(() => {
    mockFetch.mockReset();
    mockRunAllEvals.mockReset();
    process.env.PORT = '3001';
  });

  it('exports factory createTool', () => {
    const tool = createTool(deps);
    expect(tool.name).toBe('code_deploy');
    expect(tool.permissionLevel).toBe('confirm');
  });

  it('preCheck returns destructive', async () => {
    const tool = createTool(deps);
    const check = await tool.preCheck!({});
    expect(check.destructive).toBe(true);
    expect(check.reason).toMatch(/master/i);
  });

  it('runs evals before merge and blocks on failure', async () => {
    mockRunAllEvals.mockResolvedValueOnce({
      passed: 1,
      failed: 2,
      results: [
        { evalId: 'a', input: 'q', passed: true, reason: 'ok', actualText: 'r', actualToolCalls: [] },
        { evalId: 'b', input: 'q', passed: false, reason: 'wrong', actualText: 'r', actualToolCalls: [] },
        { evalId: 'c', input: 'q', passed: false, reason: 'broken', actualText: 'r', actualToolCalls: [] },
      ],
    });

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('2 evals failed');
    expect(result.error).toContain('wrong');
    expect(result.error).toContain('broken');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('proceeds with merge when all evals pass', async () => {
    mockRunAllEvals.mockResolvedValueOnce({ passed: 3, failed: 0, results: [] });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, commit: 'abc1234567', filesChanged: 5, message: 'Deployed abc1234' }),
    });

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/merge',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.success).toBe(true);
  });

  it('proceeds with merge when evals list is empty', async () => {
    mockRunAllEvals.mockResolvedValueOnce({ passed: 0, failed: 0, results: [] });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, commit: 'abc', filesChanged: 1, message: 'ok' }),
    });

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalled();
  });

  it('returns failure when eval runner throws', async () => {
    mockRunAllEvals.mockRejectedValueOnce(new Error('runner crashed'));

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('runner crashed');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns conflict error on 409 response', async () => {
    mockRunAllEvals.mockResolvedValueOnce({ passed: 0, failed: 0, results: [] });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'merge conflicts', conflicts: ['src/a.ts'] }),
    });

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('src/a.ts');
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `cd packages/tool-code-deploy && npx vitest run`
Expected: FAIL — `createTool` not exported.

- [x] **Step 4: Rewrite tool with factory**

Replace `packages/tool-code-deploy/src/index.ts`:

```typescript
import type { ToolDefinition, ToolResult, ToolContext } from '@r2/shared';
import type { ToolDeps } from '@r2/server/tools/base.js';
import { runAllEvals, type EvalResult } from '@r2/server/evals/runner.js';

export function createTool(deps: ToolDeps): ToolDefinition {
  return {
    name: 'code_deploy',
    description: 'Deploy changes from dev branch to master. Runs pre-merge evals, then merges dev into master and pushes. Use after code_task is complete and user has reviewed the changes. Always requires confirmation.',
    permissionLevel: 'confirm',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },

    preCheck: async () => ({
      destructive: true,
      reason: 'deploys to production master branch',
    }),

    async handler(_params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
      const onProgress = ctx?.onProgress ?? (() => {});
      const port = process.env.PORT || '3001';

      onProgress('Running pre-merge evals...');

      let evalsResult;
      try {
        evalsResult = await runAllEvals(deps.runLoop as any, {
          concurrency: parseInt(process.env.EVAL_CONCURRENCY || '3', 10),
          onProgress,
          signal: ctx?.signal,
        });
      } catch (err) {
        return {
          success: false,
          error: `Eval run failed: ${err instanceof Error ? err.message : 'unknown'}`,
        };
      }

      if (evalsResult.failed > 0) {
        const failedList = evalsResult.results
          .filter((r: EvalResult) => !r.passed)
          .map((r: EvalResult) => `  - ${r.evalId}: ${r.reason}`)
          .join('\n');
        return {
          success: false,
          error: `Merge blocked: ${evalsResult.failed} evals failed\n${failedList}`,
          data: evalsResult,
        };
      }

      onProgress(`${evalsResult.passed} evals passed, merging...`);

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/merge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        let data: any = {};
        try {
          data = await res.json();
        } catch {
          // ignore
        }

        if (res.status === 409 && Array.isArray(data.conflicts) && data.conflicts.length > 0) {
          return {
            success: false,
            error: `Merge conflicts in: ${data.conflicts.join(', ')}`,
          };
        }

        if (!res.ok) {
          return {
            success: false,
            error: data.error || `Merge failed with status ${res.status}`,
          };
        }

        onProgress(`Deployed ${String(data.commit || '').slice(0, 7)}`);

        return {
          success: true,
          data: {
            commit: data.commit,
            filesChanged: data.filesChanged,
            summary: data.message,
            evalsPassed: evalsResult.passed,
          },
          display: {
            type: 'text',
            content: `✓ ${data.message}\n\n${evalsResult.passed} evals passed.\nSupervisor will restart the worker within 60 seconds.`,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'deploy request failed',
        };
      }
    },
  };
}
```

(Note: no `export default` — this is a factory-only package now.)

- [x] **Step 5: Run tests**

Run: `npm install && cd packages/tool-code-deploy && npx vitest run`
Expected: all 7 tests PASS.

- [x] **Step 6: Commit**

```bash
git add packages/tool-code-deploy/ package.json package-lock.json
git commit -m "feat: refactor code_deploy to factory with pre-merge eval gate"
```

---

### Task 8: Env variables, full verification, and final commit

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Append env variables**

Append to `.env.example`:

```bash
# Phase 3E: Eval system
EVAL_CONCURRENCY=3
EVALS_PATH=./data/evals.json
```

- [ ] **Step 2: Full typecheck across all packages**

Run:
```bash
npx tsc --noEmit -p packages/shared/tsconfig.json && \
npx tsc --noEmit -p packages/server/tsconfig.json && \
npx tsc --noEmit -p packages/client/tsconfig.json && \
npx tsc --noEmit -p packages/supervisor/tsconfig.json && \
npx tsc --noEmit -p packages/tool-code-task/tsconfig.json && \
npx tsc --noEmit -p packages/tool-code-deploy/tsconfig.json && \
npx tsc --noEmit -p packages/tool-eval-add/tsconfig.json && \
npx tsc --noEmit -p packages/tool-eval-run/tsconfig.json
```
Expected: no type errors.

- [ ] **Step 3: Run all tests**

Run: `npm test --workspaces --if-present`
Expected: all tests PASS.

- [ ] **Step 4: Verify tools auto-discover**

Run: `npm run dev:server` in one terminal, watch logs for:
- `Tool discovered: eval_add (tool-eval-add)`
- `Tool discovered: eval_run (tool-eval-run)`
- `Tool discovered: code_deploy (tool-code-deploy)` (now via factory)
- `Tool discovered: code_task (tool-code-task)`

Stop with Ctrl+C after verification.

- [ ] **Step 5: Commit env and final marker**

```bash
git add .env.example
git commit -m "feat: add Phase 3E env vars"
git commit --allow-empty -m "chore: Phase 3E — eval system complete"
```
