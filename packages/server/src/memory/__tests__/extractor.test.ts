import { describe, it, expect, vi } from 'vitest';
import { extractFacts, hasImportanceKeyword, normalizeKey, IMPORTANT_BOOST_VALUE } from '../extractor.js';

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
      { key: 'user.location', value: 'Одеса', importance: 1 },
      { key: 'user.phone', value: '+380', importance: 1 },
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
    expect(facts).toEqual([{ key: 'user.name', value: 'Діма', importance: 1 }]);
  });

  it('normalizes drifted keys and rejects unsalvageable punctuation', async () => {
    // Normalization collapses case / whitespace drift and defaults the
    // `user.` namespace so supersede detection sees one canonical key.
    // Punctuation that can't be mapped (e.g. `;`) still fails the guard.
    const mockOllama = {
      chat: vi.fn().mockResolvedValue({
        text: JSON.stringify([
          { key: 'User.Location', value: 'Kyiv' },
          { key: 'Name', value: 'Діма' },
          { key: 'user wife', value: 'Марина' },
          { key: 'user.name;drop', value: 'bad' },
        ]),
      }),
    };
    const facts = await extractFacts(mockOllama as any, {
      userMessage: 'x',
      assistantMessage: 'y',
      model: 'qwen2.5:7b',
    });
    expect(facts).toEqual([
      { key: 'user.location', value: 'Kyiv', importance: 1 },
      { key: 'user.name', value: 'Діма', importance: 1 },
      { key: 'user.user_wife', value: 'Марина', importance: 1 },
    ]);
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
    expect(facts[0]).toEqual({ key: 'user.note', value: 'hello [2Jworld !', importance: 1 });
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
    expect(facts).toEqual([{ key: 'user.email', value: 'a@b.com', importance: 1 }]);
  });

  it('boosts importance to 10 when user message has an importance keyword', async () => {
    const mockOllama = {
      chat: vi.fn().mockResolvedValue({
        text: '[{"key":"user.name","value":"Іван"}]',
      }),
    };
    const facts = await extractFacts(mockOllama as any, {
      userMessage: "Запам'ятай, мене звати Іван",
      assistantMessage: 'ок',
      model: 'qwen2.5:7b',
    });
    expect(facts).toEqual([{ key: 'user.name', value: 'Іван', importance: IMPORTANT_BOOST_VALUE }]);
  });

  it('leaves importance=1 when no keyword is present', async () => {
    const mockOllama = {
      chat: vi.fn().mockResolvedValue({ text: '[{"key":"user.name","value":"Іван"}]' }),
    };
    const facts = await extractFacts(mockOllama as any, {
      userMessage: 'мене звати Іван',
      assistantMessage: 'ок',
      model: 'qwen2.5:7b',
    });
    expect(facts[0].importance).toBe(1);
  });
});

describe('normalizeKey', () => {
  it('lowercases and preserves canonical keys', () => {
    expect(normalizeKey('user.location')).toBe('user.location');
    expect(normalizeKey('User.Location')).toBe('user.location');
  });

  it('replaces whitespace with underscore', () => {
    expect(normalizeKey('project.r2 status')).toBe('project.r2_status');
    expect(normalizeKey('user.full  name')).toBe('user.full_name');
  });

  it('defaults missing subject namespace to user.', () => {
    expect(normalizeKey('name')).toBe('user.name');
    expect(normalizeKey('Wife')).toBe('user.wife');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeKey('  user.name  ')).toBe('user.name');
  });

  it('rejects malformed dotted keys that collapse to a single segment', () => {
    expect(normalizeKey('user.')).toBe('');
    expect(normalizeKey('.name')).toBe('');
    expect(normalizeKey('project.')).toBe('');
    expect(normalizeKey('..user..')).toBe('');
  });
});

describe('hasImportanceKeyword', () => {
  it('matches cyrillic keywords case-insensitively', () => {
    expect(hasImportanceKeyword('Важливо, не забудь про зустріч')).toBe(true);
    expect(hasImportanceKeyword("запам'ятай цей номер")).toBe(true);
    expect(hasImportanceKeyword('ЗАПОМНИ пароль')).toBe(true);
    expect(hasImportanceKeyword('Не забудь купити хліб')).toBe(true);
  });

  it('matches english keywords', () => {
    expect(hasImportanceKeyword('this is important')).toBe(true);
    expect(hasImportanceKeyword("don't forget milk")).toBe(true);
  });

  it('does not match substrings (word boundary)', () => {
    expect(hasImportanceKeyword('важливість справи')).toBe(false);
    expect(hasImportanceKeyword('importantly speaking')).toBe(false);
  });

  it('returns false for plain text', () => {
    expect(hasImportanceKeyword('привіт як справи')).toBe(false);
    expect(hasImportanceKeyword('')).toBe(false);
  });
});
