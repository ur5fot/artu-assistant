import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, initDb } from '../../db.js';
import { createCognitionStore } from '../store.js';

beforeEach(() => initDb(':memory:'));

describe('CognitionStore — pause/resume', () => {
  it('isPaused returns false initially', () => {
    const store = createCognitionStore({ db: getDb() });
    expect(store.isPaused()).toBe(false);
  });

  it('pause sets paused=1 and timestamp', () => {
    const store = createCognitionStore({ db: getDb() });
    store.pause(12345);
    expect(store.isPaused()).toBe(true);
    const row = getDb()
      .prepare('SELECT paused, paused_at FROM cognition_state WHERE id = 1')
      .get() as { paused: number; paused_at: number };
    expect(row).toEqual({ paused: 1, paused_at: 12345 });
  });

  it('resume clears paused', () => {
    const store = createCognitionStore({ db: getDb() });
    store.pause(12345);
    store.resume();
    expect(store.isPaused()).toBe(false);
    const row = getDb()
      .prepare('SELECT paused, paused_at FROM cognition_state WHERE id = 1')
      .get() as { paused: number; paused_at: number | null };
    expect(row).toEqual({ paused: 0, paused_at: null });
  });
});

describe('CognitionStore — ticks', () => {
  it('recordTick inserts a row', () => {
    const store = createCognitionStore({ db: getDb() });
    store.recordTick(1000);
    expect(store.getLastTickAt()).toBe(1000);
  });

  it('countTicksSince counts ticks at or after the cutoff', () => {
    const store = createCognitionStore({ db: getDb() });
    store.recordTick(1000);
    store.recordTick(2000);
    store.recordTick(3000);
    expect(store.countTicksSince(1500)).toBe(2);
  });

  it('recordTick prunes ticks older than 7 days', () => {
    const store = createCognitionStore({ db: getDb() });
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    store.recordTick(eightDaysAgo);
    store.recordTick(now);
    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM cognition_ticks').get() as { n: number }).n;
    expect(count).toBe(1);
  });
});
