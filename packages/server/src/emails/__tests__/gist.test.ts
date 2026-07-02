import { describe, it, expect, vi } from 'vitest';
import type { PiiProxy } from '../../pii/proxy.js';
import { summarizeGists } from '../gist.js';

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
  { uid: 1, from: 'Bank <b@bank.com>', subject: 'Payment', body: 'You owe 100 by Friday.' },
  { uid: 2, from: 'Boss <boss@work.com>', subject: 'Report', body: 'Please send the Q3 report.' },
];

describe('summarizeGists', () => {
  it('parses Ollama reply into a uid→gist map', async () => {
    const res = await summarizeGists(msgs, {
      piiProxy: fakeProxy(),
      ollama: fakeOllama('[{"uid":1,"gist":"Счёт на 100"},{"uid":2,"gist":"Нужен отчёт"}]'),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(res.get(1)).toBe('Счёт на 100');
    expect(res.get(2)).toBe('Нужен отчёт');
  });

  it('strips fence markers around JSON', async () => {
    const res = await summarizeGists(msgs, {
      piiProxy: fakeProxy(),
      ollama: fakeOllama('```json\n[{"uid":1,"gist":"a"},{"uid":2,"gist":"b"}]\n```'),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(res.get(1)).toBe('a');
    expect(res.get(2)).toBe('b');
  });

  it('falls back to Claude when Ollama returns unparseable', async () => {
    const res = await summarizeGists(msgs, {
      piiProxy: fakeProxy(),
      ollama: fakeOllama('not json at all'),
      anthropic: fakeAnthropic('[{"uid":1,"gist":"из клода"},{"uid":2,"gist":"тоже"}]'),
      signal: new AbortController().signal,
    });
    expect(res.get(1)).toBe('из клода');
    expect(res.get(2)).toBe('тоже');
  });

  it('leaves uid out of the map when the reply misses it (partial, best-effort)', async () => {
    const res = await summarizeGists(msgs, {
      piiProxy: fakeProxy(),
      ollama: fakeOllama('[{"uid":1,"gist":"только первый"}]'),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(res.get(1)).toBe('только первый');
    expect(res.has(2)).toBe(false);
  });

  it('deanonymizes placeholders in the gist before returning', async () => {
    const proxy: PiiProxy = {
      async anonymize(text) { return { text, entities: [] }; },
      async deanonymize(text) {
        return text.replace('<PERSON:abcdef01>', 'Alice');
      },
    };
    const res = await summarizeGists(msgs, {
      piiProxy: proxy,
      ollama: fakeOllama('[{"uid":1,"gist":"Письмо от <PERSON:abcdef01>"},{"uid":2,"gist":"ok"}]'),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(res.get(1)).toBe('Письмо от Alice');
  });

  it('returns an empty map (no throw) when both providers fail', async () => {
    const brokenOllama = { chat: vi.fn(async () => { throw new Error('ollama down'); }) } as any;
    const brokenAnthropic = {
      messages: { create: vi.fn(async () => { throw new Error('claude down'); }) },
    } as any;
    const res = await summarizeGists(msgs, {
      piiProxy: fakeProxy(),
      ollama: brokenOllama,
      anthropic: brokenAnthropic,
      signal: new AbortController().signal,
    });
    expect(res.size).toBe(0);
    expect(brokenOllama.chat).toHaveBeenCalled();
    expect(brokenAnthropic.messages.create).toHaveBeenCalled();
  });

  it('returns an empty map (no throw) when both replies are unparseable', async () => {
    const res = await summarizeGists(msgs, {
      piiProxy: fakeProxy(),
      ollama: fakeOllama('garbage'),
      anthropic: fakeAnthropic('also garbage'),
      signal: new AbortController().signal,
    });
    expect(res.size).toBe(0);
  });

  it('anonymizes from+subject+body via piiProxy before LLM (3 calls per message)', async () => {
    const proxy = fakeProxy();
    const spy = vi.spyOn(proxy, 'anonymize');
    await summarizeGists(msgs, {
      piiProxy: proxy,
      ollama: fakeOllama('[{"uid":1,"gist":"a"},{"uid":2,"gist":"b"}]'),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(spy).toHaveBeenCalledTimes(msgs.length * 3);
  });

  it('returns an empty map for empty input without calling any provider', async () => {
    const ollama = fakeOllama('');
    const anthropic = fakeAnthropic('');
    const res = await summarizeGists([], { piiProxy: fakeProxy(), ollama, anthropic, signal: new AbortController().signal });
    expect(res.size).toBe(0);
    expect(ollama.chat).not.toHaveBeenCalled();
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('splits >MAX_BATCH messages across multiple calls', async () => {
    const big = Array.from({ length: 23 }, (_, i) => ({
      uid: i + 1, from: 'x', subject: 's', body: 'b',
    }));
    const ollama = {
      chat: vi.fn(async ({ messages }: { messages: Array<{ content: string }> }) => {
        const prompt = messages[0].content;
        const uids = (prompt.match(/"uid":\s*(\d+)/g) ?? []).map((s) => Number(s.match(/\d+/)![0]));
        return { text: JSON.stringify(uids.map((u) => ({ uid: u, gist: `g${u}` }))) };
      }),
    } as any;
    const res = await summarizeGists(big, {
      piiProxy: fakeProxy(),
      ollama,
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(res.size).toBe(23);
    expect(res.get(23)).toBe('g23');
    expect(ollama.chat).toHaveBeenCalledTimes(3);
  });
});
