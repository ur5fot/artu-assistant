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
