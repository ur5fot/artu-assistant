import { describe, it, expect } from 'vitest';
import {
  BUTTON_LABEL_MAX,
  MESSAGE_MAX,
  splitDiscordContent,
  topicSteering,
  truncateLabel,
} from './ui.js';

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

describe('splitDiscordContent', () => {
  it('keeps every chunk within the Discord message limit', () => {
    const text = `${'a'.repeat(MESSAGE_MAX - 1)} ${'b'.repeat(20)}`;
    const chunks = splitDiscordContent(text);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= MESSAGE_MAX)).toBe(true);
    expect(chunks.join(' ')).toBe(text);
  });

  it('hard-splits a token longer than the Discord message limit', () => {
    const chunks = splitDiscordContent('x'.repeat(MESSAGE_MAX + 1));

    expect(chunks.map((chunk) => chunk.length)).toEqual([MESSAGE_MAX, 1]);
  });
});

describe('topicSteering', () => {
  it('keeps weak topics out of the recent avoid-list', () => {
    const progress = [
      { topic: 'weak-recent', mastery: 0.2 },
      { topic: 'strong-recent', mastery: 0.9 },
      { topic: 'another-strong', mastery: 0.7 },
      { topic: 'weak-older', mastery: 0.4 },
    ].map((item, index) => ({
      ...item,
      attempts: 1,
      correct: 0,
      lastAt: 100 - index,
    }));

    expect(topicSteering(progress)).toEqual({
      recentTopics: ['strong-recent', 'another-strong'],
      weakTopics: ['weak-recent', 'weak-older'],
    });
  });
});
