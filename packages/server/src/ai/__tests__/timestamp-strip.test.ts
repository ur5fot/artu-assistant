import { describe, expect, it } from 'vitest';
import { stripTimestampPrefix } from '../timestamp-strip.js';

describe('stripTimestampPrefix', () => {
  it('strips a leading [DD.MM.YYYY, HH:MM] prefix', () => {
    expect(stripTimestampPrefix('[14.04.2026, 10:39] 4')).toBe('4');
  });

  it('strips prefix followed by multi-line content', () => {
    expect(stripTimestampPrefix('[01.01.2026, 00:00] line one\nline two')).toBe(
      'line one\nline two',
    );
  });

  it('tolerates different separators inside the bracket', () => {
    // uk-UA locale can emit `[DD.MM.YYYY р., HH:MM]` or similar variations;
    // the regex matches anything up to the closing bracket.
    expect(stripTimestampPrefix('[14.04.2026 р., 10:39] текст')).toBe('текст');
  });

  it('leaves text without a leading bracket untouched', () => {
    expect(stripTimestampPrefix('4')).toBe('4');
    expect(stripTimestampPrefix('hello world')).toBe('hello world');
  });

  it('leaves mid-sentence brackets alone', () => {
    expect(stripTimestampPrefix('see [14.04.2026, 10:39] for the timestamp')).toBe(
      'see [14.04.2026, 10:39] for the timestamp',
    );
  });

  it('does not match brackets with only a year-month or wrong format', () => {
    expect(stripTimestampPrefix('[2026-04-14] hello')).toBe('[2026-04-14] hello');
    expect(stripTimestampPrefix('[abc] hello')).toBe('[abc] hello');
  });

  it('returns empty string for empty input', () => {
    expect(stripTimestampPrefix('')).toBe('');
  });

  it('strips prefix with trailing whitespace variants', () => {
    expect(stripTimestampPrefix('[14.04.2026, 10:39]  4')).toBe('4');
    expect(stripTimestampPrefix('[14.04.2026, 10:39]\n4')).toBe('4');
  });
});
