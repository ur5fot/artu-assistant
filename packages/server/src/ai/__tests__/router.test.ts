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
