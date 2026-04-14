# PII Tree Anonymization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Анонимизировать только строковые листья JSON-дерева tool result / input, чтобы числовые timestamp'ы не попадали под regex `CREDIT_CARD` / `PHONE_NUMBER` в Presidio.

**Architecture:** Добавить чистую функцию `anonymizeJsonStringLeaves(value, piiProxy)` в `packages/server/src/pii/`, которая рекурсивно обходит произвольное значение и вызывает `piiProxy.anonymize` только на string-leaf. Переключить `tool-helpers.ts` на этот helper в двух местах (tool result, audit log input).

**Tech Stack:** TypeScript, Node.js, Vitest, существующий `PiiProxy` из `packages/server/src/pii/proxy.ts`.

**Spec:** `docs/superpowers/specs/2026-04-14-pii-tree-anonymize-design.md`

---

## File Structure

- **Create:** `packages/server/src/pii/anonymize-tree.ts` — helper `anonymizeJsonStringLeaves`.
- **Create:** `packages/server/src/pii/anonymize-tree.test.ts` — unit-тесты helper'а.
- **Modify:** `packages/server/src/ai/tool-helpers.ts` — строки 199-208 (tool result) и 210-222 (audit input).

Все файлы в одном пакете, одна ответственность на файл. Существующие `proxy.ts` / `presidio.ts` не трогаем.

---

## Task 1: TDD — helper `anonymizeJsonStringLeaves`

**Files:**
- Create: `packages/server/src/pii/anonymize-tree.test.ts`
- Create: `packages/server/src/pii/anonymize-tree.ts`

### Step 1.1: Write failing tests

- [ ] Create `packages/server/src/pii/anonymize-tree.test.ts` with the following content:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { PiiProxy, AnonymizeResult } from './proxy.js';
import { anonymizeJsonStringLeaves } from './anonymize-tree.js';

function makeMockProxy(): PiiProxy & {
  anonymize: ReturnType<typeof vi.fn>;
  deanonymize: ReturnType<typeof vi.fn>;
} {
  return {
    anonymize: vi.fn(async (text: string): Promise<AnonymizeResult> => {
      // Default mock: mask any "a@b.c" substring into "<EMAIL:aaaa1111>".
      if (text.includes('a@b.c')) {
        return {
          text: text.replace('a@b.c', '<EMAIL:aaaa1111>'),
          entities: [{ type: 'EMAIL_ADDRESS', token: '<EMAIL:aaaa1111>', original: 'a@b.c' }],
        };
      }
      return { text, entities: [] };
    }),
    deanonymize: vi.fn(async (text: string) => text),
  };
}

describe('anonymizeJsonStringLeaves', () => {
  it('leaves non-string primitives untouched and does not call anonymize', async () => {
    const proxy = makeMockProxy();
    const input = { timestamp: 1776106975610, count: 42, active: true, nothing: null };

    const result = await anonymizeJsonStringLeaves(input, proxy);

    expect(result.value).toEqual(input);
    expect(result.entities).toEqual([]);
    expect(proxy.anonymize).not.toHaveBeenCalled();
  });

  it('regression: numeric timestamp stays a number while email string is masked', async () => {
    const proxy = makeMockProxy();
    const input = { timestamp: 1776106975610, text: 'email: a@b.c' };

    const result = await anonymizeJsonStringLeaves(input, proxy);

    expect(result.value).toEqual({
      timestamp: 1776106975610,
      text: 'email: <EMAIL:aaaa1111>',
    });
    expect(proxy.anonymize).toHaveBeenCalledTimes(1);
    expect(proxy.anonymize).toHaveBeenCalledWith('email: a@b.c');
    expect(result.entities).toEqual([
      { type: 'EMAIL_ADDRESS', token: '<EMAIL:aaaa1111>', original: 'a@b.c' },
    ]);
  });

  it('walks nested objects and arrays', async () => {
    const proxy = makeMockProxy();
    const input = { a: { b: [{ c: 'x' }, { c: 5 }] } };

    const result = await anonymizeJsonStringLeaves(input, proxy);

    expect(result.value).toEqual({ a: { b: [{ c: 'x' }, { c: 5 }] } });
    expect(proxy.anonymize).toHaveBeenCalledTimes(1);
    expect(proxy.anonymize).toHaveBeenCalledWith('x');
  });

  it('processes only string elements in arrays of primitives', async () => {
    const proxy = makeMockProxy();
    const input = [1, 2, 'text', true];

    const result = await anonymizeJsonStringLeaves(input, proxy);

    expect(result.value).toEqual([1, 2, 'text', true]);
    expect(proxy.anonymize).toHaveBeenCalledTimes(1);
    expect(proxy.anonymize).toHaveBeenCalledWith('text');
  });

  it('skips empty strings without calling anonymize', async () => {
    const proxy = makeMockProxy();
    const input = { a: '', b: 'a@b.c' };

    const result = await anonymizeJsonStringLeaves(input, proxy);

    expect(result.value).toEqual({ a: '', b: '<EMAIL:aaaa1111>' });
    expect(proxy.anonymize).toHaveBeenCalledTimes(1);
    expect(proxy.anonymize).toHaveBeenCalledWith('a@b.c');
  });

  it('aggregates entities across multiple string leaves', async () => {
    const proxy = makeMockProxy();
    proxy.anonymize
      .mockImplementationOnce(async () => ({
        text: '<EMAIL:1>',
        entities: [{ type: 'EMAIL_ADDRESS', token: '<EMAIL:1>', original: 'a@x.c' }],
      }))
      .mockImplementationOnce(async () => ({
        text: '<PHONE:1>',
        entities: [{ type: 'PHONE_NUMBER', token: '<PHONE:1>', original: '+1' }],
      }));

    const result = await anonymizeJsonStringLeaves({ e: 'a@x.c', p: '+1' }, proxy);

    expect(result.value).toEqual({ e: '<EMAIL:1>', p: '<PHONE:1>' });
    expect(result.entities).toEqual([
      { type: 'EMAIL_ADDRESS', token: '<EMAIL:1>', original: 'a@x.c' },
      { type: 'PHONE_NUMBER', token: '<PHONE:1>', original: '+1' },
    ]);
  });

  it('handles top-level null without throwing', async () => {
    const proxy = makeMockProxy();

    const result = await anonymizeJsonStringLeaves(null, proxy);

    expect(result.value).toBeNull();
    expect(result.entities).toEqual([]);
    expect(proxy.anonymize).not.toHaveBeenCalled();
  });

  it('handles top-level string', async () => {
    const proxy = makeMockProxy();

    const result = await anonymizeJsonStringLeaves('email: a@b.c', proxy);

    expect(result.value).toBe('email: <EMAIL:aaaa1111>');
    expect(result.entities).toHaveLength(1);
  });
});
```

### Step 1.2: Verify tests fail

- [ ] Run: `cd packages/server && npx vitest run src/pii/anonymize-tree.test.ts`

Expected: **FAIL** — "Failed to resolve import './anonymize-tree.js'" (module does not exist yet).

### Step 1.3: Implement helper

- [ ] Create `packages/server/src/pii/anonymize-tree.ts` with:

```ts
import type { PiiProxy, AnonymizeResult } from './proxy.js';

export interface TreeAnonymizeResult {
  value: unknown;
  entities: AnonymizeResult['entities'];
}

/**
 * Recursively walks a JSON-like value and anonymizes only string leaves via
 * the given PiiProxy. Numbers, booleans, null, and undefined are returned
 * untouched so that numeric fields (timestamps, scores, ids) never reach
 * Presidio's regex recognizers — which would otherwise mis-classify large
 * integers as CREDIT_CARD / PHONE_NUMBER.
 */
export async function anonymizeJsonStringLeaves(
  value: unknown,
  piiProxy: PiiProxy,
): Promise<TreeAnonymizeResult> {
  const entities: AnonymizeResult['entities'] = [];

  async function walk(node: unknown): Promise<unknown> {
    if (typeof node === 'string') {
      if (node.length === 0) return node;
      const anon = await piiProxy.anonymize(node);
      entities.push(...anon.entities);
      return anon.text;
    }
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const item of node) {
        out.push(await walk(item));
      }
      return out;
    }
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = await walk(v);
      }
      return out;
    }
    return node;
  }

  const walked = await walk(value);
  return { value: walked, entities };
}
```

### Step 1.4: Verify tests pass

- [ ] Run: `cd packages/server && npx vitest run src/pii/anonymize-tree.test.ts`

Expected: **PASS** — all 8 tests green.

### Step 1.5: Commit

- [ ] Run:

```bash
cd /Users/dim/code/R2-D2
git add packages/server/src/pii/anonymize-tree.ts packages/server/src/pii/anonymize-tree.test.ts
git commit -m "$(cat <<'EOF'
feat(pii): add anonymizeJsonStringLeaves helper

Recursively walks JSON-like values and anonymizes only string leaves,
leaving numbers/booleans/null untouched so numeric timestamps are not
mis-classified by regex recognizers.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire helper into `tool-helpers.ts`

**Files:**
- Modify: `packages/server/src/ai/tool-helpers.ts:198-208` (tool result block)
- Modify: `packages/server/src/ai/tool-helpers.ts:210-222` (audit log input block)

### Step 2.1: Add import

- [ ] Open `packages/server/src/ai/tool-helpers.ts`. Near the top of the file, add the import next to the other `../pii/*` or relative imports (keep import group sorting consistent with the existing style):

```ts
import { anonymizeJsonStringLeaves } from '../pii/anonymize-tree.js';
```

### Step 2.2: Replace tool result anonymization block

- [ ] In `packages/server/src/ai/tool-helpers.ts`, locate:

```ts
  // Anonymize tool result before logging and sending back to LLM
  if (result.data) {
    const anonResult = await piiProxy.anonymize(JSON.stringify(result.data));
    if (anonResult.entities.length > 0) {
      try {
        result = { ...result, data: JSON.parse(anonResult.text) };
      } catch {
        result = { ...result, data: anonResult.text };
      }
    }
  }
```

Replace with:

```ts
  // Anonymize tool result before logging and sending back to LLM.
  // Walk the JSON tree and mask only string leaves — numeric fields like
  // timestamps must stay numbers so Presidio's regex recognizers don't
  // mis-classify them as CREDIT_CARD / PHONE_NUMBER.
  if (result.data) {
    const anon = await anonymizeJsonStringLeaves(result.data, piiProxy);
    if (anon.entities.length > 0) {
      result = { ...result, data: anon.value };
    }
  }
```

### Step 2.3: Replace audit log input anonymization block

- [ ] In the same file, locate:

```ts
  // Audit log — anonymize input before writing to avoid PII at rest
  try {
    const anonInput = await piiProxy.anonymize(JSON.stringify(input));
    let logInput: Record<string, unknown>;
    try {
      logInput = JSON.parse(anonInput.text) as Record<string, unknown>;
    } catch {
      logInput = { _raw: anonInput.text };
    }
    logToolCall({ toolName: toolDef.name, input: logInput, result, success: result.success, durationMs });
  } catch (err) {
    console.error('Audit log write failed:', err instanceof Error ? err.message : err);
  }
```

Replace with:

```ts
  // Audit log — anonymize input before writing to avoid PII at rest.
  // Same reasoning as the result block: only string leaves go through Presidio.
  try {
    const anonInput = await anonymizeJsonStringLeaves(input, piiProxy);
    const logInput =
      anonInput.value !== null && typeof anonInput.value === 'object' && !Array.isArray(anonInput.value)
        ? (anonInput.value as Record<string, unknown>)
        : { _raw: anonInput.value };
    logToolCall({ toolName: toolDef.name, input: logInput, result, success: result.success, durationMs });
  } catch (err) {
    console.error('Audit log write failed:', err instanceof Error ? err.message : err);
  }
```

Note: `input` into tool calls is always a plain object in our tool registry (`Record<string, unknown>`), so the `_raw` branch is a defensive fallback only.

### Step 2.4: Typecheck and run existing server tests

- [ ] Run: `cd packages/server && npx tsc --noEmit`

Expected: **no errors**.

- [ ] Run: `cd packages/server && npx vitest run src/ai src/pii`

Expected: **all tests pass** (both the new helper tests and the pre-existing ai/pii suites). If any test was pinning on the old `JSON.stringify` behavior, investigate before fixing — it may indicate a missed call site.

### Step 2.5: Commit

- [ ] Run:

```bash
cd /Users/dim/code/R2-D2
git add packages/server/src/ai/tool-helpers.ts
git commit -m "$(cat <<'EOF'
fix(pii): anonymize tool result/input by walking string leaves

Stops Presidio regex recognizers from masking numeric timestamps in
memory_search results (and other structured tool outputs) as
CREDIT_CARD / PHONE_NUMBER. Numbers, booleans, and null now bypass the
anonymizer entirely; only string leaves are sent through piiProxy.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: End-to-end verification against running dev server

**Files:** (read-only checks)

### Step 3.1: Restart dev server

- [ ] `tsx watch` should auto-restart after the edits to `tool-helpers.ts`. Confirm the server is healthy:

```bash
curl -s http://localhost:3004/api/health
```

Expected: `{"status":"R2 online", ...}`.

### Step 3.2: Trigger memory_search via chat

- [ ] Run:

```bash
curl -sN -X POST http://localhost:3004/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"/память как меня зовут"}]}' \
  --max-time 30
```

### Step 3.3: Inspect the SSE stream

- [ ] In the output, find the `data: {"type":"tool_call_result",...}` line for `memory_search`.

Expected:
- No `<CARD:...>` or `<PHONE:...>` tokens in place of numeric timestamps.
- `timestamp` values inside the returned JSON are numbers (e.g. `1776106975610`), not token strings.
- Real PII in string content (emails, phones typed by the user) is still masked with tokens.

If any of these fail, do NOT claim success — return to Task 1 or 2 and debug.

### Step 3.4: Confirm `/api/messages` still serves history

- [ ] Run:

```bash
curl -s http://localhost:3004/api/messages | head -c 500
```

Expected: returns a JSON array of recent messages — the anonymization change must not have affected message persistence format.

### Step 3.5: Mark complete

- [ ] Only after Steps 3.1–3.4 all pass, consider the feature done. No additional commit needed (Task 2 already committed the code).

---

## Done Criteria

- `anonymize-tree.test.ts` contains 8 tests, all passing.
- `npx tsc --noEmit` in `packages/server` is clean.
- `npx vitest run src/ai src/pii` in `packages/server` is green.
- Live `memory_search` tool_result stream shows numeric timestamps preserved and no spurious `<CARD:...>` / `<PHONE:...>` tokens.
- Two commits exist on the branch:
  1. `feat(pii): add anonymizeJsonStringLeaves helper`
  2. `fix(pii): anonymize tool result/input by walking string leaves`
