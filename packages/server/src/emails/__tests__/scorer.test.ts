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

  it('falls back to Claude when Ollama reply is missing uids', async () => {
    // Ollama covers only uid=1; Claude covers both. Must NOT default uid=2 to 3.
    const res = await scoreBatch(msgs, {
      piiProxy: fakeProxy(),
      ollama: fakeOllama('[{"uid":1,"importance":5}]'),
      anthropic: fakeAnthropic('[{"uid":1,"importance":5},{"uid":2,"importance":2}]'),
      signal: new AbortController().signal,
    });
    expect(res).toEqual([
      { uid: 1, importance: 5 },
      { uid: 2, importance: 2 },
    ]);
  });

  it('throws when BOTH Ollama and Claude replies are incomplete (protects last_seen_uid)', async () => {
    await expect(
      scoreBatch(msgs, {
        piiProxy: fakeProxy(),
        ollama: fakeOllama('[{"uid":1,"importance":5}]'),
        anthropic: fakeAnthropic('[{"uid":1,"importance":4}]'),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/did not cover every uid/i);
  });

  it('throws when both scorers throw (protects last_seen_uid)', async () => {
    const brokenOllama = { chat: vi.fn(async () => { throw new Error('ollama down'); }) } as any;
    const brokenAnthropic = {
      messages: { create: vi.fn(async () => { throw new Error('claude down'); }) },
    } as any;
    await expect(
      scoreBatch(msgs, {
        piiProxy: fakeProxy(),
        ollama: brokenOllama,
        anthropic: brokenAnthropic,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/claude down/);
    // Ollama-first is the contract: a regression that bypassed the local LLM
    // would still surface Claude's error and pass the assertion above. Pin
    // the order explicitly so that regression is caught.
    expect(brokenOllama.chat).toHaveBeenCalled();
    expect(brokenAnthropic.messages.create).toHaveBeenCalled();
    const ollamaOrder = brokenOllama.chat.mock.invocationCallOrder[0];
    const claudeOrder = brokenAnthropic.messages.create.mock.invocationCallOrder[0];
    expect(ollamaOrder).toBeLessThan(claudeOrder);
  });

  it('handles >MAX_BATCH messages across multiple batches', async () => {
    const big = Array.from({ length: 23 }, (_, i) => ({
      uid: i + 1, from: 'x', subject: 's', snippet: 'x',
    }));
    // Each Ollama call returns the full batch — scoreBatch calls it per batch (10, 10, 3).
    const ollama = {
      chat: vi.fn(async ({ messages }: { messages: Array<{ content: string }> }) => {
        const prompt = messages[0].content;
        const match = prompt.match(/"uid":\s*(\d+)/g) ?? [];
        const uids = match.map((s) => Number(s.match(/\d+/)![0]));
        const reply = uids.map((u) => ({ uid: u, importance: 4 }));
        return { text: JSON.stringify(reply) };
      }),
    } as any;
    const res = await scoreBatch(big, {
      piiProxy: fakeProxy(),
      ollama,
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(res).toHaveLength(23);
    expect(res.every((r) => r.importance === 4)).toBe(true);
    expect(ollama.chat).toHaveBeenCalledTimes(3);
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

  it('anonymizes from+subject+snippet via piiProxy before LLM (3 calls per message)', async () => {
    const proxy = fakeProxy();
    const spy = vi.spyOn(proxy, 'anonymize');
    await scoreBatch(msgs, {
      piiProxy: proxy,
      ollama: fakeOllama('[{"uid":1,"importance":4},{"uid":2,"importance":2}]'),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(spy).toHaveBeenCalledTimes(msgs.length * 3);
  });
});
