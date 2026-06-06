import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, getDb, closeDb } from '../../db.js';
import { createPresenceStore } from '../presence-store.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => closeDb());

const T = 1_700_000_000_000;

describe('createPresenceStore', () => {
  describe('recordAway', () => {
    it('inserts a span when to > from', () => {
      const store = createPresenceStore({ db: getDb() });
      store.recordAway(T, T + 60_000);

      const rows = getDb()
        .prepare('SELECT away_started_at, away_ended_at FROM presence_log')
        .all() as Array<{ away_started_at: number; away_ended_at: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ away_started_at: T, away_ended_at: T + 60_000 });
    });

    it('is a no-op when to == from or to < from', () => {
      const store = createPresenceStore({ db: getDb() });
      store.recordAway(T, T);
      store.recordAway(T + 60_000, T);

      const rows = getDb().prepare('SELECT * FROM presence_log').all();
      expect(rows).toHaveLength(0);
    });
  });

  describe('listAwayInWindow', () => {
    it('returns spans overlapping the window, newest first', () => {
      const store = createPresenceStore({ db: getDb() });
      store.recordAway(T, T + 10_000);          // early
      store.recordAway(T + 100_000, T + 110_000); // late

      const all = store.listAwayInWindow(T - 1, T + 200_000);
      expect(all.map((s) => s.away_started_at)).toEqual([T + 100_000, T]);
    });

    it('includes spans that partially overlap the window edges', () => {
      const store = createPresenceStore({ db: getDb() });
      // starts before window, ends inside
      store.recordAway(T - 50_000, T + 10_000);
      // starts inside, ends after window
      store.recordAway(T + 90_000, T + 150_000);

      const res = store.listAwayInWindow(T, T + 100_000);
      expect(res).toHaveLength(2);
    });

    it('excludes spans entirely outside the window', () => {
      const store = createPresenceStore({ db: getDb() });
      store.recordAway(T - 100_000, T - 50_000); // fully before
      store.recordAway(T + 200_000, T + 250_000); // fully after

      const res = store.listAwayInWindow(T, T + 100_000);
      expect(res).toHaveLength(0);
    });

    it('excludes spans touching exactly at a boundary (zero overlap)', () => {
      const store = createPresenceStore({ db: getDb() });
      // span ends exactly at window start
      store.recordAway(T - 50_000, T);
      // span starts exactly at window end
      store.recordAway(T + 100_000, T + 150_000);

      const res = store.listAwayInWindow(T, T + 100_000);
      expect(res).toHaveLength(0);
    });
  });

  describe('purgeOlderThan', () => {
    it('deletes spans ended before the cutoff and returns the count', () => {
      const store = createPresenceStore({ db: getDb() });
      store.recordAway(T, T + 10_000);
      store.recordAway(T + 50_000, T + 60_000);

      const deleted = store.purgeOlderThan(T + 20_000);
      expect(deleted).toBe(1);

      const remaining = getDb()
        .prepare('SELECT away_ended_at FROM presence_log')
        .all() as Array<{ away_ended_at: number }>;
      expect(remaining.map((r) => r.away_ended_at)).toEqual([T + 60_000]);
    });
  });
});
