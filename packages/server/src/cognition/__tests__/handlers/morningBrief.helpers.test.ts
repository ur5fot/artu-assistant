import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../../db.js';
import {
  getTodayStartLocal,
  isSameLocalDate,
  hasUserActivityToday,
} from '../../handlers/morningBrief.helpers.js';

const TZ = 'Europe/Kyiv';

beforeEach(() => initDb(':memory:'));

describe('getTodayStartLocal', () => {
  it('returns midnight of same local date as `now`', () => {
    const now = Date.UTC(2026, 3, 18, 14, 30, 0);
    const startLocal = getTodayStartLocal(now, TZ);
    expect(new Date(startLocal).toISOString()).toBe('2026-04-17T21:00:00.000Z');
  });

  it('handles pre-midnight UTC correctly (Kyiv ahead of UTC)', () => {
    const now = Date.UTC(2026, 3, 18, 23, 30, 0);
    const startLocal = getTodayStartLocal(now, TZ);
    expect(new Date(startLocal).toISOString()).toBe('2026-04-18T21:00:00.000Z');
  });
});

describe('isSameLocalDate', () => {
  it('returns true for two timestamps on same local date', () => {
    const a = Date.UTC(2026, 3, 18, 4, 0, 0);
    const b = Date.UTC(2026, 3, 18, 20, 0, 0);
    expect(isSameLocalDate(a, b, TZ)).toBe(true);
  });

  it('returns false across local midnight even if within 24h', () => {
    const a = Date.UTC(2026, 3, 18, 20, 0, 0);
    const b = Date.UTC(2026, 3, 18, 22, 30, 0);
    expect(isSameLocalDate(a, b, TZ)).toBe(false);
  });
});

describe('hasUserActivityToday', () => {
  it('returns false when chat_messages has no rows since today_start', () => {
    const now = Date.UTC(2026, 3, 18, 6, 0, 0);
    expect(hasUserActivityToday(getDb(), now, TZ)).toBe(false);
  });

  it('returns true when at least one user message exists after today_start', () => {
    const now = Date.UTC(2026, 3, 18, 6, 0, 0);
    const ts = Date.UTC(2026, 3, 18, 4, 0, 0);
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', 'hi', ?)",
      )
      .run(`m-${ts}`, ts);
    expect(hasUserActivityToday(getDb(), now, TZ)).toBe(true);
  });

  it('ignores messages from previous local day', () => {
    const now = Date.UTC(2026, 3, 18, 6, 0, 0);
    const ts = Date.UTC(2026, 3, 17, 20, 0, 0);
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', 'hi', ?)",
      )
      .run(`m-${ts}`, ts);
    expect(hasUserActivityToday(getDb(), now, TZ)).toBe(false);
  });

  it('ignores assistant messages (only user role counts)', () => {
    const now = Date.UTC(2026, 3, 18, 6, 0, 0);
    const ts = Date.UTC(2026, 3, 18, 4, 0, 0);
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'assistant', 'hi', ?)",
      )
      .run(`m-${ts}`, ts);
    expect(hasUserActivityToday(getDb(), now, TZ)).toBe(false);
  });
});
