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

describe('CognitionStore — handler runs', () => {
  it('recordHandlerRun returns row id and persists outcome', () => {
    const store = createCognitionStore({ db: getDb() });
    const id = store.recordHandlerRun({
      handlerName: 'pulse',
      firedAt: 1000,
      durationMs: 5,
      result: { skip: true, reason: 'alive' },
    });
    expect(id).toBeGreaterThan(0);
    const row = getDb()
      .prepare('SELECT handler_name, outcome, reason FROM cognition_handler_runs WHERE id = ?')
      .get(id) as { handler_name: string; outcome: string; reason: string };
    expect(row).toEqual({ handler_name: 'pulse', outcome: 'skip', reason: 'alive' });
  });

  it('recordHandlerRun stores publish content', () => {
    const store = createCognitionStore({ db: getDb() });
    const id = store.recordHandlerRun({
      handlerName: 'reflect',
      firedAt: 2000,
      durationMs: 1234,
      result: { publish: true, content: 'noticed X' },
    });
    const row = getDb()
      .prepare('SELECT outcome, content FROM cognition_handler_runs WHERE id = ?')
      .get(id) as { outcome: string; content: string };
    expect(row).toEqual({ outcome: 'publish', content: 'noticed X' });
  });

  it('recordHandlerRun stores error message in reason', () => {
    const store = createCognitionStore({ db: getDb() });
    const id = store.recordHandlerRun({
      handlerName: 'broken',
      firedAt: 3000,
      durationMs: 10,
      result: { error: true, message: 'boom' },
    });
    const row = getDb()
      .prepare('SELECT outcome, reason FROM cognition_handler_runs WHERE id = ?')
      .get(id) as { outcome: string; reason: string };
    expect(row).toEqual({ outcome: 'error', reason: 'boom' });
  });

  it('markPublished sets published_at', () => {
    const store = createCognitionStore({ db: getDb() });
    const id = store.recordHandlerRun({
      handlerName: 'reflect',
      firedAt: 1,
      durationMs: 1,
      result: { publish: true, content: 'x' },
    });
    store.markPublished(id, 9999);
    const row = getDb()
      .prepare('SELECT published_at FROM cognition_handler_runs WHERE id = ?')
      .get(id) as { published_at: number };
    expect(row.published_at).toBe(9999);
  });

  it('getLastFiredAt returns latest fired_at for handler', () => {
    const store = createCognitionStore({ db: getDb() });
    store.recordHandlerRun({
      handlerName: 'a',
      firedAt: 100,
      durationMs: 0,
      result: { skip: true, reason: '' },
    });
    store.recordHandlerRun({
      handlerName: 'a',
      firedAt: 500,
      durationMs: 0,
      result: { skip: true, reason: '' },
    });
    store.recordHandlerRun({
      handlerName: 'b',
      firedAt: 999,
      durationMs: 0,
      result: { skip: true, reason: '' },
    });
    expect(store.getLastFiredAt('a')).toBe(500);
    expect(store.getLastFiredAt('missing')).toBe(null);
  });

  it('getLastResult round-trips publish/skip/error', () => {
    const store = createCognitionStore({ db: getDb() });
    store.recordHandlerRun({
      handlerName: 'a',
      firedAt: 1,
      durationMs: 0,
      result: { publish: true, content: 'hi' },
    });
    expect(store.getLastResult('a')).toEqual({ publish: true, content: 'hi' });
    store.recordHandlerRun({
      handlerName: 'a',
      firedAt: 2,
      durationMs: 0,
      result: { skip: true, reason: 'why' },
    });
    expect(store.getLastResult('a')).toEqual({ skip: true, reason: 'why' });
    store.recordHandlerRun({
      handlerName: 'a',
      firedAt: 3,
      durationMs: 0,
      result: { error: true, message: 'boom' },
    });
    expect(store.getLastResult('a')).toEqual({ error: true, message: 'boom' });
  });

  it('recentRuns returns rows ordered by fired_at desc, limited', () => {
    const store = createCognitionStore({ db: getDb() });
    for (let i = 1; i <= 5; i++) {
      store.recordHandlerRun({
        handlerName: 'h',
        firedAt: i * 100,
        durationMs: 0,
        result: { skip: true, reason: `r${i}` },
      });
    }
    const recent = store.recentRuns(3);
    expect(recent.map((r) => r.firedAt)).toEqual([500, 400, 300]);
    expect(recent[0].outcome).toBe('skip');
    expect(recent[0].reason).toBe('r5');
  });
});
