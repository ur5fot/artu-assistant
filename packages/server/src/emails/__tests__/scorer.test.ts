import { describe, it, expect, vi } from 'vitest';
import type { PiiProxy } from '../../pii/proxy.js';
import { scoreBatch } from '../scorer.js';

function fakeProxy(): PiiProxy {
  return {
    async anonymize(text) { return { text, entities: [] }; },
    async deanonymize(text) { return text; },
  };
}

function fakeOllama(jsonReply: string) {
  return { chat: vi.fn(async () => ({ text: jsonReply })) } as any;
}

function fakeAnthropic(jsonReply: string) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: jsonReply }],
        role: 'assistant',
      })),
    },
  } as any;
}

const msgs = [
  { uid: 1, from: 'Bank', subject: 'Payment', snippet: 'you paid 100' },
  { uid: 2, from: 'Newsletter', subject: 'Weekly', snippet: 'promo' },
];

describe('scoreBatch', () => {
  it('parses clean JSON reply from Ollama', async () => {
    const res = await scoreBatch(msgs, {
      piiProxy: fakeProxy(),
      ollama: fakeOllama('[{"uid":1,"importance":5},{"uid":2,"importance":1}]'),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(res).toEqual([
      { uid: 1, importance: 5 },
      { uid: 2, importance: 1 },
    ]);
  });

  it('strips fence markers around JSON', async () => {
    const res = await scoreBatch(msgs, {
      piiProxy: fakeProxy(),
      ollama: fakeOllama('```json\n[{"uid":1,"importance":4},{"uid":2,"importance":2}]\n```'),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(res.map((r) => r.importance)).toEqual([4, 2]);
  });

  it('clamps importance into 1..5', async () => {
    const res = await scoreBatch(msgs, {
      piiProxy: fakeProxy(),
      ollama: fakeOllama('[{"uid":1,"importance":9},{"uid":2,"importance":-3}]'),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(res.map((r) => r.importance)).toEqual([5, 1]);
  });

  it('falls back to Claude when Ollama returns unparseable', async () => {
    const res = await scoreBatch(msgs, {
      piiProxy: fakeProxy(),
      ollama: fakeOllama('not json at all'),
      anthropic: fakeAnthropic('[{"uid":1,"importance":3},{"uid":2,"importance":1}]'),
      signal: new AbortController().signal,
    });
    expect(res[0].importance).toBe(3);
    expect(res[1].importance).toBe(1);
  });

  it('returns importance=3 for uids missing from reply', async () => {
    const res = await scoreBatch(msgs, {
      piiProxy: fakeProxy(),
      ollama: fakeOllama('[{"uid":1,"importance":5}]'),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(res).toContainEqual({ uid: 2, importance: 3 });
  });

  it('returns empty array for empty input', async () => {
    const res = await scoreBatch([], {
      piiProxy: fakeProxy(),
      ollama: fakeOllama(''),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(res).toEqual([]);
  });

  it('anonymizes subject+snippet via piiProxy before LLM', async () => {
    const proxy = fakeProxy();
    const spy = vi.spyOn(proxy, 'anonymize');
    await scoreBatch(msgs, {
      piiProxy: proxy,
      ollama: fakeOllama('[{"uid":1,"importance":4},{"uid":2,"importance":2}]'),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(spy).toHaveBeenCalled();
  });
});
