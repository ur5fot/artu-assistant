import { describe, it, expect } from 'vitest';
import { sanitizeAssistantContent, sanitizeHistory } from '../sanitize-history.js';

describe('sanitizeAssistantContent', () => {
  it('flattens a basic pipe table and drops the separator row', () => {
    const input = [
      '| День | Макс | Мін |',
      '|---|---|---|',
      '| ВТ 21.04 | +12°C | +5°C |',
      '| СР 22.04 | +15°C | +8°C |',
    ].join('\n');

    const out = sanitizeAssistantContent(input);

    expect(out).not.toMatch(/\|---/);
    expect(out).not.toMatch(/^\s*\|/);
    expect(out).toContain('День · Макс · Мін');
    expect(out).toContain('ВТ 21.04 · +12°C · +5°C');
    expect(out).toContain('СР 22.04 · +15°C · +8°C');
  });

  it('preserves prose around a table', () => {
    const input = [
      '**☀️ Прогноз на тиждень:**',
      '',
      '| День | Темп |',
      '|---|---|',
      '| ПН | +12 |',
      '',
      'Увечері можливі опади.',
    ].join('\n');

    const out = sanitizeAssistantContent(input);
    expect(out).toContain('**☀️ Прогноз на тиждень:**');
    expect(out).toContain('Увечері можливі опади.');
    expect(out).toContain('День · Темп');
    expect(out).toContain('ПН · +12');
  });

  it('keeps content with no table unchanged', () => {
    const input = 'Just a normal response.\n\nNo tables here.';
    expect(sanitizeAssistantContent(input)).toBe(input);
  });

  it('ignores lines that merely start with a pipe but are not a full row', () => {
    const input = '|not a real table row';
    expect(sanitizeAssistantContent(input)).toBe(input);
  });

  it('handles alignment specifiers in the separator (":---:")', () => {
    const input = [
      '| A | B |',
      '|:---:|:---|',
      '| 1 | 2 |',
    ].join('\n');

    const out = sanitizeAssistantContent(input);
    expect(out).not.toMatch(/:---/);
    expect(out).toContain('A · B');
    expect(out).toContain('1 · 2');
  });
});

describe('sanitizeHistory', () => {
  it('sanitizes past assistant messages, leaves user messages intact', () => {
    const history = [
      { role: 'user' as const, content: 'прогноз?' },
      {
        role: 'assistant' as const,
        content: '| День | Темп |\n|---|---|\n| ПН | +12 |',
      },
      { role: 'user' as const, content: 'а на неделю?' },
    ];

    const out = sanitizeHistory(history);

    expect(out[0]).toEqual(history[0]);
    expect(out[2]).toEqual(history[2]);
    const assistantContent = out[1].content;
    expect(typeof assistantContent).toBe('string');
    expect(assistantContent).not.toMatch(/\|---/);
    expect(assistantContent).toContain('День · Темп');
    expect(assistantContent).toContain('ПН · +12');
  });

  it('leaves messages with array content (tool_use blocks) alone when they have no text blocks', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'tool_use' as const, id: 't1', name: 'x', input: {} },
        ],
      },
      { role: 'user' as const, content: 'hi' },
    ];

    const out = sanitizeHistory(history as any);
    expect(out).toEqual(history);
  });

  it('sanitizes text blocks inside array-content assistant messages', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: '| A | B |\n|---|---|\n| 1 | 2 |' },
        ],
      },
      { role: 'user' as const, content: 'k' },
    ];

    const out = sanitizeHistory(history as any);
    const textBlock = (out[0].content as any)[0];
    expect(textBlock.text).toContain('A · B');
    expect(textBlock.text).not.toMatch(/\|---/);
  });

  it('returns the same object reference when nothing changes (cheap no-op)', () => {
    const history = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'no tables here' },
      { role: 'user' as const, content: 'ok' },
    ];
    const out = sanitizeHistory(history);
    expect(out[1]).toBe(history[1]);
  });
});
