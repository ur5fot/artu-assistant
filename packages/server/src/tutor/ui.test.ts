import { describe, it, expect } from 'vitest';
import { truncateLabel, BUTTON_LABEL_MAX } from './ui.js';

describe('truncateLabel', () => {
  it('leaves short labels untouched', () => {
    expect(truncateLabel('go')).toBe('go');
  });

  it('truncates labels over the Discord 80-char cap with an ellipsis', () => {
    const long = 'a'.repeat(BUTTON_LABEL_MAX + 10);
    const result = truncateLabel(long);
    expect(result.length).toBe(BUTTON_LABEL_MAX);
    expect(result.endsWith('…')).toBe(true);
  });

  it('falls back to an em dash for an empty label', () => {
    expect(truncateLabel('')).toBe('—');
  });

  it('falls back to an em dash for a whitespace-only label', () => {
    expect(truncateLabel('   ')).toBe('—');
  });
});
