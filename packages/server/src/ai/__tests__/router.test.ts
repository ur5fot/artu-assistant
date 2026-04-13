import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SSEEvent } from '@r2/shared';
import { runChatRequest } from '../router.js';

function fakeRegistry() {
  return {
    register: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getForProvider: vi.fn().mockReturnValue([]),
  };
}

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
      registry: fakeRegistry() as any,
      memoryService: null,
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
      registry: fakeRegistry() as any,
      memoryService: null,
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
      registry: fakeRegistry() as any,
      memoryService: null,
    });

    expect(fakeOllama.chat).toHaveBeenCalled();
    expect(fakeRunLoop).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'text_delta' && (e as any).content === 'The answer is 42.')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('Ollama success + escalate phrase calls runToolLoop after progress event', async () => {
    const fakeOllama = { chat: vi.fn().mockResolvedValueOnce({ text: 'I need to use a tool for this' }) };
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
      registry: fakeRegistry() as any,
      memoryService: null,
    });

    expect(fakeOllama.chat).toHaveBeenCalled();
    expect(fakeRunLoop).toHaveBeenCalled();
    const progress = events.find((e) => e.type === 'tool_progress');
    expect(progress).toBeDefined();
    expect((progress as any).message).toMatch(/Claude|escalat/i);
    // Synthesized router tool call must wrap the progress event so the UI
    // can render the escalation notice (bare tool_progress is dropped).
    const startIdx = events.findIndex(
      (e) => e.type === 'tool_call_start' && (e as any).toolCall.id === 'router',
    );
    const progressIdx = events.findIndex((e) => e.type === 'tool_progress');
    const resultIdx = events.findIndex(
      (e) => e.type === 'tool_call_result' && (e as any).id === 'router',
    );
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThan(progressIdx);
    expect(startIdx).toBeLessThan(progressIdx);
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
      registry: fakeRegistry() as any,
      memoryService: null,
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
      registry: fakeRegistry() as any,
      memoryService: null,
    });

    expect(fakeRunLoop).toHaveBeenCalled();
  });

  it('messages with non-text content blocks skip Ollama and go straight to Claude', async () => {
    const fakeOllama = { chat: vi.fn() };
    const piiProxy = {
      anonymize: vi.fn(async (t: string) => ({ text: t, entities: [] })),
      deanonymize: vi.fn(async (t: string) => t),
    };
    const fakeRunLoop = vi.fn(async ({ onEvent }) => {
      onEvent({ type: 'done' });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runChatRequest({
      messages: [
        { role: 'user', content: 'start' },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
      ] as any,
      onEvent: () => {},
      runLoop: fakeRunLoop as any,
      ollama: fakeOllama as any,
      piiProxy: piiProxy as any,
      registry: fakeRegistry() as any,
      memoryService: null,
    });

    expect(fakeOllama.chat).not.toHaveBeenCalled();
    expect(piiProxy.anonymize).not.toHaveBeenCalled();
    expect(fakeRunLoop).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('text-only content block arrays still reach Ollama', async () => {
    const fakeOllama = { chat: vi.fn().mockResolvedValueOnce({ text: 'fine.' }) };
    const fakeRunLoop = vi.fn();

    await runChatRequest({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ] as any,
      onEvent: () => {},
      runLoop: fakeRunLoop as any,
      ollama: fakeOllama as any,
      piiProxy: passthroughPii() as any,
      registry: fakeRegistry() as any,
      memoryService: null,
    });

    expect(fakeOllama.chat).toHaveBeenCalled();
    expect(fakeRunLoop).not.toHaveBeenCalled();
  });

  it('escalation path does not emit router-level pii_masked (tool-loop handles it)', async () => {
    const piiProxy = {
      anonymize: vi.fn(async (t: string) => ({ text: t.replace('Dima', '<PERSON:1>'), entities: [{ type: 'PERSON', original: 'Dima' }] })),
      deanonymize: vi.fn(async (t: string) => t),
    };
    const fakeOllama = { chat: vi.fn().mockResolvedValueOnce({ text: 'I need to use a tool for this' }) };
    const fakeRunLoop = vi.fn(async ({ onEvent }) => {
      onEvent({ type: 'pii_masked', entities: [{ type: 'PERSON', original: 'Dima' }] });
      onEvent({ type: 'done' });
    });

    const events: SSEEvent[] = [];
    await runChatRequest({
      messages: [{ role: 'user', content: 'weather for Dima' }],
      onEvent: (e) => events.push(e),
      runLoop: fakeRunLoop as any,
      ollama: fakeOllama as any,
      piiProxy: piiProxy as any,
      registry: fakeRegistry() as any,
      memoryService: null,
    });

    const piiEvents = events.filter((e) => e.type === 'pii_masked');
    expect(piiEvents).toHaveLength(1);
  });

});
