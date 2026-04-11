# Local LLM Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Ollama as first-attempt LLM for chat with transparent escalation to Claude on low confidence, required tool use, or when Ollama is unreachable.

**Architecture:** New `router.ts` orchestrator wraps existing `runToolLoop` without modifying it. New `ollama.ts` client talks native Ollama `/api/chat`. New `escalation-check.ts` pure function decides escalate/not. Chat route calls `runChatRequest` instead of `runToolLoop` directly. Tool-loop remains Claude-native — router only intercepts BEFORE it.

**Tech Stack:** Ollama native API (`POST /api/chat`), fetch with AbortSignal, Vitest, TypeScript

---

### Task 1: Ollama client

**Files:**
- Create: `packages/server/src/ai/ollama.ts`
- Create: `packages/server/src/ai/__tests__/ollama.test.ts`

- [x] **Step 1: Write failing tests**

Create `packages/server/src/ai/__tests__/ollama.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOllamaClient } from '../ollama.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('OllamaClient.chat', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.OLLAMA_URL = 'http://localhost:11434';
    process.env.OLLAMA_MODEL = 'qwen2.5:7b';
  });

  it('calls native /api/chat with stream=false', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: { role: 'assistant', content: 'Hello' }, done: true }),
    });

    const client = createOllamaClient();
    const result = await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.text).toBe('Hello');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('qwen2.5:7b');
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('converts Anthropic-style array content to flat string', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: { role: 'assistant', content: 'ok' }, done: true }),
    });

    const client = createOllamaClient();
    await client.chat({
      messages: [
        { role: 'user', content: 'text one' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'part A' },
            { type: 'text', text: 'part B' },
          ] as any,
        },
      ],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].content).toBe('text one');
    expect(body.messages[1].content).toBe('part A\npart B');
  });

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'server error',
    });

    const client = createOllamaClient();
    await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/500/);
  });

  it('throws on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const client = createOllamaClient();
    await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/ECONNREFUSED/);
  });

  it('forwards AbortSignal to fetch', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: { role: 'assistant', content: 'ok' }, done: true }),
    });

    const controller = new AbortController();
    const client = createOllamaClient();
    await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('uses OLLAMA_URL and OLLAMA_MODEL from env', async () => {
    process.env.OLLAMA_URL = 'http://custom:9999';
    process.env.OLLAMA_MODEL = 'llama3.2:3b';

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: { role: 'assistant', content: 'ok' }, done: true }),
    });

    const client = createOllamaClient();
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect(mockFetch).toHaveBeenCalledWith('http://custom:9999/api/chat', expect.anything());
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('llama3.2:3b');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/ai/__tests__/ollama.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement Ollama client**

Create `packages/server/src/ai/ollama.ts`:

```typescript
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

interface OllamaChatParams {
  messages: MessageParam[];
  signal?: AbortSignal;
}

interface OllamaChatResult {
  text: string;
}

export interface OllamaClient {
  chat(params: OllamaChatParams): Promise<OllamaChatResult>;
}

interface OllamaMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

function toOllamaMessage(msg: MessageParam): OllamaMessage {
  // Anthropic MessageParam.content can be string OR array of blocks.
  // Ollama expects a flat string, so we flatten text blocks and drop the rest.
  let content: string;
  if (typeof msg.content === 'string') {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    content = msg.content
      .map((block: any) => {
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  } else {
    content = '';
  }
  return {
    role: msg.role as 'user' | 'assistant',
    content,
  };
}

export function createOllamaClient(): OllamaClient {
  return {
    async chat(params: OllamaChatParams): Promise<OllamaChatResult> {
      const url = process.env.OLLAMA_URL || 'http://localhost:11434';
      const model = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

      const body = JSON.stringify({
        model,
        stream: false,
        messages: params.messages.map(toOllamaMessage),
      });

      const res = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: params.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Ollama error ${res.status}: ${text.slice(0, 200)}`);
      }

      let data: any;
      try {
        data = await res.json();
      } catch (err) {
        throw new Error(`Ollama returned invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`);
      }

      const text = data?.message?.content;
      if (typeof text !== 'string') {
        throw new Error('Ollama response missing message.content');
      }

      return { text };
    },
  };
}
```

- [x] **Step 4: Run tests**

Run: `cd packages/server && npx vitest run src/ai/__tests__/ollama.test.ts`
Expected: all 6 tests PASS.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/ai/ollama.ts packages/server/src/ai/__tests__/ollama.test.ts
git commit -m "feat: add Ollama client for native /api/chat"
```

---

### Task 2: Escalation heuristics

**Files:**
- Create: `packages/server/src/ai/escalation-check.ts`
- Create: `packages/server/src/ai/__tests__/escalation-check.test.ts`

- [x] **Step 1: Write failing tests**

Create `packages/server/src/ai/__tests__/escalation-check.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { shouldEscalate } from '../escalation-check.js';

describe('shouldEscalate', () => {
  it('escalates on empty text', () => {
    const result = shouldEscalate('');
    expect(result.escalate).toBe(true);
    expect(result.reason).toMatch(/empty/);
  });

  it('escalates on whitespace-only text', () => {
    expect(shouldEscalate('   \n\t').escalate).toBe(true);
  });

  it('escalates on English tool-need phrases', () => {
    expect(shouldEscalate('I need to use web search for this').escalate).toBe(true);
    expect(shouldEscalate('I cannot answer without a tool').escalate).toBe(true);
    expect(shouldEscalate("I can't do that without code access").escalate).toBe(true);
    expect(shouldEscalate('Let me search for that').escalate).toBe(true);
    expect(shouldEscalate('Let me look up the current weather').escalate).toBe(true);
  });

  it('escalates on Russian tool-need phrases', () => {
    expect(shouldEscalate('я не могу без доступа к поиску').escalate).toBe(true);
    expect(shouldEscalate('мне нужно использовать инструмент').escalate).toBe(true);
    expect(shouldEscalate('я должен воспользоваться поиском').escalate).toBe(true);
  });

  it('escalates on bracketed tool markers', () => {
    expect(shouldEscalate('[need search]').escalate).toBe(true);
    expect(shouldEscalate('[need code]').escalate).toBe(true);
    expect(shouldEscalate('[need file]').escalate).toBe(true);
  });

  it('does not escalate on plain factual answer', () => {
    expect(shouldEscalate('The answer is 4.').escalate).toBe(false);
    expect(shouldEscalate('Hello, how can I help you today?').escalate).toBe(false);
  });

  it('does not escalate on Russian factual answer', () => {
    expect(shouldEscalate('Два плюс два равно четыре.').escalate).toBe(false);
    expect(shouldEscalate('Привет, чем могу помочь?').escalate).toBe(false);
  });

  it('does not escalate on long explanatory answer', () => {
    const long = 'JavaScript is a programming language primarily used for web development. '.repeat(5);
    expect(shouldEscalate(long).escalate).toBe(false);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/ai/__tests__/escalation-check.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement escalation check**

Create `packages/server/src/ai/escalation-check.ts`:

```typescript
export interface EscalationDecision {
  escalate: boolean;
  reason: string;
}

const TRIGGER_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bI\s+(need|cannot|can'?t)\b[^.]*?\b(tool|search|code|file|access)/i, reason: 'requires tool (english)' },
  { pattern: /\blet\s+me\s+(search|look\s+up|find)\b/i, reason: 'requires tool (english)' },
  { pattern: /я\s+(не\s+могу|нужно|должен)[^.]*?(поиск|инструмент|tool|доступ)/i, reason: 'requires tool (russian)' },
  { pattern: /\[need\s+(search|code|file|tool)\]/i, reason: 'bracket marker' },
];

export function shouldEscalate(text: string): EscalationDecision {
  const trimmed = (text || '').trim();
  if (trimmed.length === 0) {
    return { escalate: true, reason: 'empty response' };
  }

  for (const { pattern, reason } of TRIGGER_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { escalate: true, reason };
    }
  }

  return { escalate: false, reason: '' };
}
```

- [x] **Step 4: Run tests**

Run: `cd packages/server && npx vitest run src/ai/__tests__/escalation-check.test.ts`
Expected: all tests PASS.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/ai/escalation-check.ts packages/server/src/ai/__tests__/escalation-check.test.ts
git commit -m "feat: add escalation-check heuristics for Ollama responses"
```

---

### Task 3: Router orchestrator

**Files:**
- Create: `packages/server/src/ai/router.ts`
- Create: `packages/server/src/ai/__tests__/router.test.ts`

- [x] **Step 1: Write failing tests**

Create `packages/server/src/ai/__tests__/router.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SSEEvent } from '@r2/shared';
import { runChatRequest } from '../router.js';

describe('runChatRequest', () => {
  beforeEach(() => {
    delete process.env.LOCAL_LLM_MODE;
  });

  function passthroughPii() {
    return {
      anonymize: async (t: string) => ({ text: t, entities: [] as any }),
      deanonymize: async (t: string) => t,
    };
  }

  it('LOCAL_LLM_MODE=disabled skips Ollama and calls runToolLoop', async () => {
    process.env.LOCAL_LLM_MODE = 'disabled';

    const fakeRunLoop = vi.fn(async ({ onEvent }) => {
      onEvent({ type: 'text_delta', content: 'claude-answer' });
      onEvent({ type: 'done' });
    });
    const fakeOllama = { chat: vi.fn() };

    const events: SSEEvent[] = [];
    await runChatRequest({
      messages: [{ role: 'user', content: 'hi' }],
      onEvent: (e) => events.push(e),
      runLoop: fakeRunLoop as any,
      ollama: fakeOllama as any,
      piiProxy: passthroughPii() as any,
    });

    expect(fakeOllama.chat).not.toHaveBeenCalled();
    expect(fakeRunLoop).toHaveBeenCalled();
    expect(events.some((e) => e.type === 'text_delta' && (e as any).content === 'claude-answer')).toBe(true);
  });

  it('ollama=null skips Ollama and calls runToolLoop', async () => {
    const fakeRunLoop = vi.fn(async ({ onEvent }) => {
      onEvent({ type: 'done' });
    });

    await runChatRequest({
      messages: [{ role: 'user', content: 'hi' }],
      onEvent: () => {},
      runLoop: fakeRunLoop as any,
      ollama: null,
      piiProxy: passthroughPii() as any,
    });

    expect(fakeRunLoop).toHaveBeenCalled();
  });

  it('Ollama success + non-escalate text emits text_delta and done without runToolLoop', async () => {
    const fakeOllama = { chat: vi.fn().mockResolvedValueOnce({ text: 'The answer is 42.' }) };
    const fakeRunLoop = vi.fn();

    const events: SSEEvent[] = [];
    await runChatRequest({
      messages: [{ role: 'user', content: 'what is the answer' }],
      onEvent: (e) => events.push(e),
      runLoop: fakeRunLoop as any,
      ollama: fakeOllama as any,
      piiProxy: passthroughPii() as any,
    });

    expect(fakeOllama.chat).toHaveBeenCalled();
    expect(fakeRunLoop).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'text_delta' && (e as any).content === 'The answer is 42.')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('Ollama success + escalate phrase calls runToolLoop after progress event', async () => {
    const fakeOllama = { chat: vi.fn().mockResolvedValueOnce({ text: 'I need to use web search' }) };
    const fakeRunLoop = vi.fn(async ({ onEvent }) => {
      onEvent({ type: 'text_delta', content: 'claude-answer' });
      onEvent({ type: 'done' });
    });

    const events: SSEEvent[] = [];
    await runChatRequest({
      messages: [{ role: 'user', content: 'weather' }],
      onEvent: (e) => events.push(e),
      runLoop: fakeRunLoop as any,
      ollama: fakeOllama as any,
      piiProxy: passthroughPii() as any,
    });

    expect(fakeOllama.chat).toHaveBeenCalled();
    expect(fakeRunLoop).toHaveBeenCalled();
    const progress = events.find((e) => e.type === 'tool_progress');
    expect(progress).toBeDefined();
    expect((progress as any).message).toMatch(/Claude|escalat/i);
    expect(events.some((e) => e.type === 'text_delta' && (e as any).content === 'claude-answer')).toBe(true);
  });

  it('Ollama unreachable falls back to runToolLoop silently with warning log', async () => {
    const fakeOllama = { chat: vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')) };
    const fakeRunLoop = vi.fn(async ({ onEvent }) => {
      onEvent({ type: 'text_delta', content: 'claude-answer' });
      onEvent({ type: 'done' });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const events: SSEEvent[] = [];
    await runChatRequest({
      messages: [{ role: 'user', content: 'hi' }],
      onEvent: (e) => events.push(e),
      runLoop: fakeRunLoop as any,
      ollama: fakeOllama as any,
      piiProxy: passthroughPii() as any,
    });

    expect(fakeRunLoop).toHaveBeenCalled();
    expect(events.some((e) => e.type === 'text_delta' && (e as any).content === 'claude-answer')).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('Ollama empty response escalates', async () => {
    const fakeOllama = { chat: vi.fn().mockResolvedValueOnce({ text: '' }) };
    const fakeRunLoop = vi.fn(async ({ onEvent }) => { onEvent({ type: 'done' }); });

    await runChatRequest({
      messages: [{ role: 'user', content: 'hi' }],
      onEvent: () => {},
      runLoop: fakeRunLoop as any,
      ollama: fakeOllama as any,
      piiProxy: passthroughPii() as any,
    });

    expect(fakeRunLoop).toHaveBeenCalled();
  });

  it('applies PII anonymize to messages before Ollama and deanonymize to response', async () => {
    const piiProxy = {
      anonymize: vi.fn(async (t: string) => ({ text: t.replace('Dima', '<PERSON:1>'), entities: [] })),
      deanonymize: vi.fn(async (t: string) => t.replace('<PERSON:1>', 'Dima')),
    };
    const fakeOllama = { chat: vi.fn().mockResolvedValueOnce({ text: 'Hello <PERSON:1>' }) };

    const events: SSEEvent[] = [];
    await runChatRequest({
      messages: [{ role: 'user', content: 'Say hi to Dima' }],
      onEvent: (e) => events.push(e),
      runLoop: vi.fn() as any,
      ollama: fakeOllama as any,
      piiProxy: piiProxy as any,
    });

    expect(piiProxy.anonymize).toHaveBeenCalled();
    expect(piiProxy.deanonymize).toHaveBeenCalled();
    const sentMessages = fakeOllama.chat.mock.calls[0][0].messages;
    expect(sentMessages[0].content).toBe('Say hi to <PERSON:1>');
    expect(events.some((e) => e.type === 'text_delta' && (e as any).content === 'Hello Dima')).toBe(true);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/ai/__tests__/router.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement router**

Create `packages/server/src/ai/router.ts`:

```typescript
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent } from '@r2/shared';
import type { PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PiiProxy } from '../pii/proxy.js';
import type { OllamaClient } from './ollama.js';
import { shouldEscalate } from './escalation-check.js';

export interface RunChatRequestParams {
  messages: MessageParam[];
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
  pendingPlanReviews?: PendingPlanReviews;
  piiProxy: PiiProxy;
  ollama: OllamaClient | null;
  runLoop: (params: {
    messages: MessageParam[];
    onEvent: (event: SSEEvent) => void;
    signal?: AbortSignal;
    pendingConfirms?: PendingConfirms;
    pendingPlanReviews?: PendingPlanReviews;
    piiProxy: PiiProxy;
  }) => Promise<void>;
}

function anonymizeMessages(
  messages: MessageParam[],
  piiProxy: PiiProxy,
): Promise<MessageParam[]> {
  return Promise.all(
    messages.map(async (msg) => {
      if (typeof msg.content !== 'string') return msg;
      const result = await piiProxy.anonymize(msg.content);
      return { role: msg.role, content: result.text };
    }),
  );
}

async function callClaudeFallback(params: RunChatRequestParams): Promise<void> {
  await params.runLoop({
    messages: params.messages,
    onEvent: params.onEvent,
    signal: params.signal,
    pendingConfirms: params.pendingConfirms,
    pendingPlanReviews: params.pendingPlanReviews,
    piiProxy: params.piiProxy,
  });
}

export async function runChatRequest(params: RunChatRequestParams): Promise<void> {
  const mode = process.env.LOCAL_LLM_MODE || 'enabled';

  // Skip router entirely
  if (mode === 'disabled' || params.ollama === null) {
    await callClaudeFallback(params);
    return;
  }

  // Try Ollama first
  let ollamaText: string | null = null;
  try {
    const anonymized = await anonymizeMessages(params.messages, params.piiProxy);
    const result = await params.ollama.chat({
      messages: anonymized,
      signal: params.signal,
    });
    ollamaText = result.text;
  } catch (err) {
    console.warn(
      '[router] Ollama unreachable, falling back to Claude:',
      err instanceof Error ? err.message : err,
    );
    await callClaudeFallback(params);
    return;
  }

  // Decide: escalate or accept
  const decision = shouldEscalate(ollamaText);

  if (decision.escalate) {
    params.onEvent({
      type: 'tool_progress',
      id: 'router',
      message: `Escalating to Claude (${decision.reason})`,
    });
    await callClaudeFallback(params);
    return;
  }

  // Ollama answer accepted — deanonymize and stream
  const deanonText = await params.piiProxy.deanonymize(ollamaText);
  params.onEvent({ type: 'text_delta', content: deanonText });
  params.onEvent({ type: 'done' });
}
```

- [x] **Step 4: Run tests**

Run: `cd packages/server && npx vitest run src/ai/__tests__/router.test.ts`
Expected: all tests PASS.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/ai/router.ts packages/server/src/ai/__tests__/router.test.ts
git commit -m "feat: add router orchestrator with Ollama first + Claude fallback"
```

---

### Task 4: Wire router into chat route and index.ts

**Files:**
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/routes/chat.ts`

- [ ] **Step 1: Update chat.ts to use runChatRequest**

In `packages/server/src/routes/chat.ts`:

Add import after line 8:

```typescript
import type { OllamaClient } from '../ai/ollama.js';
import { runChatRequest } from '../ai/router.js';
```

Replace the `ChatRouterDeps` interface (lines 43-55):

```typescript
interface ChatRouterDeps {
  runLoop: (params: {
    messages: MessageParam[];
    onEvent: (event: SSEEvent) => void;
    signal?: AbortSignal;
    pendingConfirms: PendingConfirms;
    pendingPlanReviews: PendingPlanReviews;
    piiProxy: PiiProxy;
  }) => Promise<void>;
  pendingConfirms: PendingConfirms;
  pendingPlanReviews: PendingPlanReviews;
  piiProxy: PiiProxy;
  ollama: OllamaClient | null;
}
```

Replace `createChatRouter` destructure (line 57):

```typescript
export function createChatRouter({ runLoop, pendingConfirms, pendingPlanReviews, piiProxy, ollama }: ChatRouterDeps): Router {
```

Replace the `runLoop` call inside the handler (lines 109-172) with `runChatRequest`:

```typescript
    try {
      await runChatRequest({
        messages: addTimestamps(messages),
        signal: abortController.signal,
        pendingConfirms,
        pendingPlanReviews,
        piiProxy,
        ollama,
        runLoop,
        onEvent: (event: SSEEvent) => {
          // Accumulate assistant data for persistence
          if (event.type === 'text_delta') {
            assistantText += event.content;
          } else if (event.type === 'tool_call_start') {
            assistantToolCalls.push(event.toolCall);
          } else if (event.type === 'tool_call_result') {
            const tc = assistantToolCalls.find((t) => t.id === event.id);
            if (tc) {
              // Strip heavy presentational fields (e.g. code_task.fullDiff)
              // before persisting. tool-loop splits fullDiff out of the
              // Claude-facing result and re-attaches it for the SSE stream,
              // but we must not store it in SQLite: (a) it was intentionally
              // bypassed by PII anonymization, so persisting the raw diff
              // would leak unmasked secrets; (b) each diff can be tens of KB
              // and bloats the messages table and history loads.
              let persistedResult = event.result;
              if (
                persistedResult &&
                persistedResult.success &&
                persistedResult.data &&
                typeof persistedResult.data === 'object' &&
                !Array.isArray(persistedResult.data) &&
                'fullDiff' in (persistedResult.data as Record<string, unknown>)
              ) {
                const { fullDiff: _fd, ...rest } = persistedResult.data as Record<string, unknown>;
                persistedResult = { ...persistedResult, data: rest };
              }
              tc.result = persistedResult;
              tc.status = event.result.success ? 'done' : 'error';
            }
          } else if (event.type === 'pii_masked') {
            assistantPiiEntities = event.entities;
          } else if (event.type === 'done') {
            // Save assistant message on completion
            if (assistantText || assistantToolCalls.length > 0) {
              try {
                saveMessage({
                  messageId: assistantId,
                  role: 'assistant',
                  content: assistantText,
                  toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
                  piiEntities: assistantPiiEntities,
                  timestamp: Date.now(),
                });
              } catch (err) {
                console.error('Failed to save assistant message:', err instanceof Error ? err.message : err);
              }
            }
          }

          // Forward to SSE stream
          if (!res.writableEnded && !res.destroyed) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        },
      });
    } catch (error) {
```

Keep the existing catch block + partial-save logic + `res.end()` at the end as-is.

- [ ] **Step 2: Update index.ts to create Ollama client and pass it**

In `packages/server/src/index.ts`:

Add import after existing ai imports (around line 17):

```typescript
import { createOllamaClient, type OllamaClient } from './ai/ollama.js';
```

After `const client = createClaudeClient();` (around line 74 in the refactored version from Phase 3E), add:

```typescript
const localLlmMode = (process.env.LOCAL_LLM_MODE || 'enabled') as 'enabled' | 'disabled';
const ollama: OllamaClient | null = localLlmMode === 'disabled' ? null : createOllamaClient();
if (ollama) {
  console.log('[router] Local LLM enabled via Ollama at', process.env.OLLAMA_URL || 'http://localhost:11434');
} else {
  console.log('[router] Local LLM disabled — all chat goes to Claude');
}
```

Update the `createChatRouter(...)` call to include `ollama`:

```typescript
const chatRouter = createChatRouter({
  runLoop: ({ messages, onEvent, signal, pendingConfirms: pc, pendingPlanReviews: ppr, piiProxy: pp }) =>
    runToolLoop({ messages, client, registry, onEvent, signal, pendingConfirms: pc, pendingPlanReviews: ppr, piiProxy: pp }),
  pendingConfirms,
  pendingPlanReviews,
  piiProxy,
  ollama,
});
```

- [ ] **Step 3: Run server typecheck**

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Run existing chat tests**

Run: `cd packages/server && npx vitest run src/routes/__tests__/chat.test.ts`
Expected: all existing tests still pass. If any fail because they passed `runLoop` but not `ollama`, fix the test by adding `ollama: null` to the router deps.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/chat.ts packages/server/src/index.ts
git commit -m "feat: wire router into chat route with Ollama client injection"
```

---

### Task 5: Env vars and AGENTS.md documentation

**Files:**
- Modify: `.env.example`
- Modify: `AGENTS.md`

- [ ] **Step 1: Append env variables**

Append to `.env.example`:

```bash
# Phase 4G: Local LLM router
LOCAL_LLM_MODE=enabled            # enabled | disabled
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b
```

- [ ] **Step 2: Update AGENTS.md Phase 4 section**

In `AGENTS.md`, find the `## Phase 4` section and add a Phase 4G entry:

```markdown
- **4G) Local LLM router** ✓ — Ollama as first attempt for chat, Claude as fallback
  - `packages/server/src/ai/ollama.ts` — native /api/chat client
  - `packages/server/src/ai/router.ts` — runChatRequest orchestrator
  - `packages/server/src/ai/escalation-check.ts` — regex heuristics for escalation
  - LOCAL_LLM_MODE=disabled kills router; ollama unreachable → silent fallback
  - Default model: qwen2.5:7b (~5 GB RAM). Run `ollama serve` + `ollama pull qwen2.5:7b` before use.
```

If a Phase 4 section does not already exist, append:

```markdown
## Phase 4 — R2 gets Claude Code-level capabilities

- **4G) Local LLM router** ✓ — ...
```

(only add if missing)

- [ ] **Step 3: Commit**

```bash
git add .env.example AGENTS.md
git commit -m "docs: document Phase 4G local LLM router env and architecture"
```

---

### Task 6: Full verification

**Files:**
- All modified files

- [ ] **Step 1: Full typecheck**

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

- [ ] **Step 2: Run all tests**

Run: `npm test --workspaces --if-present`
Expected: all tests PASS. Critically: existing chat.test.ts, tool-loop tests, eval tests all still pass (they use mocks that never touch Ollama).

- [ ] **Step 3: Startup smoke**

Run: `npm run dev:server` in one terminal, watch logs for:
- `[router] Local LLM enabled via Ollama at http://localhost:11434` (or `disabled` message)
- No startup errors

Stop with Ctrl+C after verification.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: Phase 4G — local LLM router complete" --allow-empty
```
