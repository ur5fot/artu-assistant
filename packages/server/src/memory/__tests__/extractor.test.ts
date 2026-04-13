import { describe, it, expect, vi } from 'vitest';
import { extractFacts } from '../extractor.js';

describe('extractFacts', () => {
  it('calls Ollama chat and parses JSON array', async () => {
    const mockOllama = {
      chat: vi.fn().mockResolvedValue({
        text: '[{"key":"user.location","value":"Одеса"},{"key":"user.phone","value":"+380"}]',
      }),
    };
    const facts = await extractFacts(mockOllama as any, {
      userMessage: 'я живу в Одесі',
      assistantMessage: 'зрозумів',
      model: 'qwen2.5:7b',
    });
    expect(facts).toEqual([
      { key: 'user.location', value: 'Одеса' },
      { key: 'user.phone', value: '+380' },
    ]);
    expect(mockOllama.chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'qwen2.5:7b' }),
    );
  });

  it('returns empty array when Ollama returns non-JSON', async () => {
    const mockOllama = { chat: vi.fn().mockResolvedValue({ text: 'no facts found' }) };
    const facts = await extractFacts(mockOllama as any, {
      userMessage: 'привіт',
      assistantMessage: 'hi',
      model: 'qwen2.5:7b',
    });
    expect(facts).toEqual([]);
  });

  it('filters out entries missing key or value', async () => {
    const mockOllama = {
      chat: vi.fn().mockResolvedValue({
        text: '[{"key":"user.name","value":"Діма"},{"key":"bad"},{"value":"orphan"}]',
      }),
    };
    const facts = await extractFacts(mockOllama as any, {
      userMessage: 'x',
      assistantMessage: 'y',
      model: 'qwen2.5:7b',
    });
    expect(facts).toEqual([{ key: 'user.name', value: 'Діма' }]);
  });

  it('rejects keys that violate the canonical lowercase schema', async () => {
    // Memory-poisoning guard: mixed-case / punctuation keys are dropped so
    // `User.Location` and `user.location` can't coexist as separate facts,
    // and crafted keys with spaces/semicolons cannot slip through.
    const mockOllama = {
      chat: vi.fn().mockResolvedValue({
        text: JSON.stringify([
          { key: 'User.Location', value: 'Kyiv' },
          { key: 'user name', value: 'x' },
          { key: 'user.name;drop', value: 'x' },
          { key: 'user.name', value: 'Діма' },
        ]),
      }),
    };
    const facts = await extractFacts(mockOllama as any, {
      userMessage: 'x',
      assistantMessage: 'y',
      model: 'qwen2.5:7b',
    });
    expect(facts).toEqual([{ key: 'user.name', value: 'Діма' }]);
  });

  it('strips control characters and truncates values over 500 chars', async () => {
    const bigValue = 'a'.repeat(600);
    const mockOllama = {
      chat: vi.fn().mockResolvedValue({
        text: JSON.stringify([
          { key: 'user.note', value: `hello\u001b[2Jworld\u0000!` },
          { key: 'user.long', value: bigValue },
        ]),
      }),
    };
    const facts = await extractFacts(mockOllama as any, {
      userMessage: 'x',
      assistantMessage: 'y',
      model: 'qwen2.5:7b',
    });
    expect(facts[0]).toEqual({ key: 'user.note', value: 'hello [2Jworld !' });
    expect(facts[1].key).toBe('user.long');
    expect(facts[1].value.length).toBe(500);
  });

  it('returns empty array when ollama chat throws', async () => {
    const mockOllama = { chat: vi.fn().mockRejectedValue(new Error('boom')) };
    const facts = await extractFacts(mockOllama as any, {
      userMessage: 'x',
      assistantMessage: 'y',
      model: 'qwen2.5:7b',
    });
    expect(facts).toEqual([]);
  });

  it('parses JSON embedded in surrounding text', async () => {
    const mockOllama = {
      chat: vi.fn().mockResolvedValue({
        text: 'Ось факти: [{"key":"user.email","value":"a@b.com"}] готово.',
      }),
    };
    const facts = await extractFacts(mockOllama as any, {
      userMessage: 'x',
      assistantMessage: 'y',
      model: 'qwen2.5:7b',
    });
    expect(facts).toEqual([{ key: 'user.email', value: 'a@b.com' }]);
  });
});
