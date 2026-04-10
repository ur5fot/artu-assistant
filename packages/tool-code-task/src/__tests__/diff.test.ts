import { describe, it, expect } from 'vitest';
import { parseDiffStats, truncateDiff, summarizeDiff } from '../diff.js';

describe('parseDiffStats', () => {
  it('parses file stats from numstat', () => {
    const numstat = '45\t0\tsrc/Theme.tsx\n5\t7\tsrc/App.tsx\n';
    expect(parseDiffStats(numstat)).toEqual([
      { path: 'src/Theme.tsx', added: 45, removed: 0 },
      { path: 'src/App.tsx', added: 5, removed: 7 },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parseDiffStats('')).toEqual([]);
  });

  it('handles binary files as zero changes', () => {
    expect(parseDiffStats('-\t-\timage.png\n')).toEqual([
      { path: 'image.png', added: 0, removed: 0 },
    ]);
  });
});

describe('truncateDiff', () => {
  it('returns full diff if shorter than maxLines', () => {
    expect(truncateDiff('line1\nline2', 50)).toBe('line1\nline2');
  });

  it('truncates and appends marker', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
    const result = truncateDiff(lines.join('\n'), 50);
    const resultLines = result.split('\n');
    expect(resultLines.length).toBe(51);
    expect(resultLines[50]).toContain('truncated');
  });
});

describe('summarizeDiff', () => {
  it('formats summary with counts and commit', () => {
    const summary = summarizeDiff(
      [
        { path: 'a.ts', added: 10, removed: 0 },
        { path: 'b.ts', added: 5, removed: 3 },
      ],
      'abc1234567890',
    );
    expect(summary).toContain('2 files');
    expect(summary).toContain('+15');
    expect(summary).toContain('-3');
    expect(summary).toContain('abc1234');
  });
});
