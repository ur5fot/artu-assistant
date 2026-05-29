import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb, closeDb } from '../../db.js';
import { createWindowHistoryStore } from '../window-history-store.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

describe('createWindowHistoryStore', () => {
  describe('recordSample', () => {
    it('INSERTs a new row when DB is empty', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t = 1_700_000_000_000;
      store.recordSample({ app_name: 'Chrome', window_title: 'Gmail', sampled_at: t });

      const rows = getDb()
        .prepare('SELECT app_name, window_title, started_at, last_seen_at, sample_count FROM window_history')
        .all() as Array<{
          app_name: string; window_title: string; started_at: number; last_seen_at: number; sample_count: number;
        }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        app_name: 'Chrome',
        window_title: 'Gmail',
        started_at: t,
        last_seen_at: t,
        sample_count: 1,
      });
    });

    it('UPDATEs last row when app+title match (no new row, sample_count incremented)', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t1 = 1_700_000_000_000;
      const t2 = t1 + 30_000;
      const t3 = t2 + 30_000;

      store.recordSample({ app_name: 'Chrome', window_title: 'Gmail', sampled_at: t1 });
      store.recordSample({ app_name: 'Chrome', window_title: 'Gmail', sampled_at: t2 });
      store.recordSample({ app_name: 'Chrome', window_title: 'Gmail', sampled_at: t3 });

      const rows = getDb()
        .prepare('SELECT * FROM window_history ORDER BY id')
        .all() as Array<{ started_at: number; last_seen_at: number; sample_count: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].started_at).toBe(t1);
      expect(rows[0].last_seen_at).toBe(t3);
      expect(rows[0].sample_count).toBe(3);
    });

    it('INSERTs new row when title changes (same app)', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t1 = 1_700_000_000_000;
      const t2 = t1 + 30_000;

      store.recordSample({ app_name: 'Chrome', window_title: 'Gmail', sampled_at: t1 });
      store.recordSample({ app_name: 'Chrome', window_title: 'GitHub', sampled_at: t2 });

      const rows = getDb()
        .prepare('SELECT window_title, sample_count FROM window_history ORDER BY id')
        .all() as Array<{ window_title: string; sample_count: number }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].window_title).toBe('Gmail');
      expect(rows[1].window_title).toBe('GitHub');
      expect(rows[1].sample_count).toBe(1);
    });

    it('INSERTs new row when app changes', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t1 = 1_700_000_000_000;
      const t2 = t1 + 30_000;

      store.recordSample({ app_name: 'Chrome', window_title: 'Gmail', sampled_at: t1 });
      store.recordSample({ app_name: 'iTerm', window_title: 'Gmail', sampled_at: t2 });

      const rows = getDb()
        .prepare('SELECT app_name FROM window_history ORDER BY id')
        .all() as Array<{ app_name: string }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].app_name).toBe('Chrome');
      expect(rows[1].app_name).toBe('iTerm');
    });

    it('matches on the most recent row, not any historical row with same app+title', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t1 = 1_700_000_000_000;
      store.recordSample({ app_name: 'Chrome', window_title: 'Gmail', sampled_at: t1 });
      store.recordSample({ app_name: 'iTerm', window_title: 'zsh', sampled_at: t1 + 30_000 });
      store.recordSample({ app_name: 'Chrome', window_title: 'Gmail', sampled_at: t1 + 60_000 });

      const rows = getDb()
        .prepare('SELECT app_name, window_title, sample_count FROM window_history ORDER BY id')
        .all() as Array<{ app_name: string; window_title: string; sample_count: number }>;
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.sample_count)).toEqual([1, 1, 1]);
    });
  });

  describe('findCurrentSession', () => {
    it('returns null when DB is empty', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      expect(store.findCurrentSession()).toBeNull();
    });

    it('returns the most recent row', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t1 = 1_700_000_000_000;
      store.recordSample({ app_name: 'Chrome', window_title: 'Gmail', sampled_at: t1 });
      store.recordSample({ app_name: 'iTerm', window_title: 'zsh', sampled_at: t1 + 30_000 });

      const current = store.findCurrentSession();
      expect(current).not.toBeNull();
      expect(current!.app_name).toBe('iTerm');
      expect(current!.window_title).toBe('zsh');
      expect(current!.started_at).toBe(t1 + 30_000);
      expect(current!.last_seen_at).toBe(t1 + 30_000);
      expect(current!.sample_count).toBe(1);
    });
  });

  describe('findRecentRows', () => {
    it('returns rows with last_seen_at >= since, most-recent-first', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t0 = 1_700_000_000_000;
      store.recordSample({ app_name: 'A', window_title: 't1', sampled_at: t0 });
      store.recordSample({ app_name: 'B', window_title: 't2', sampled_at: t0 + 60_000 });
      store.recordSample({ app_name: 'C', window_title: 't3', sampled_at: t0 + 120_000 });

      const rows = store.findRecentRows(t0 + 60_000);
      expect(rows).toHaveLength(2);
      expect(rows[0].app_name).toBe('C');
      expect(rows[1].app_name).toBe('B');
    });

    it('respects the limit param', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t0 = 1_700_000_000_000;
      for (let i = 0; i < 5; i++) {
        store.recordSample({
          app_name: `app${i}`, window_title: `t${i}`, sampled_at: t0 + i * 60_000,
        });
      }
      const rows = store.findRecentRows(t0, 3);
      expect(rows).toHaveLength(3);
      expect(rows[0].app_name).toBe('app4');
    });

    it('returns empty array when no rows match', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t0 = 1_700_000_000_000;
      store.recordSample({ app_name: 'A', window_title: 't1', sampled_at: t0 });
      expect(store.findRecentRows(t0 + 1)).toEqual([]);
    });
  });

  describe('listTitlesInSession', () => {
    it('returns distinct titles for given app within [from, to] window, ordered by last_seen_at desc', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t0 = 1_700_000_000_000;
      store.recordSample({ app_name: 'Chrome', window_title: 'Gmail', sampled_at: t0 });
      store.recordSample({ app_name: 'Chrome', window_title: 'GitHub', sampled_at: t0 + 60_000 });
      store.recordSample({ app_name: 'Chrome', window_title: 'Gmail', sampled_at: t0 + 120_000 });
      store.recordSample({ app_name: 'iTerm', window_title: 'zsh', sampled_at: t0 + 180_000 });

      const titles = store.listTitlesInSession('Chrome', t0, t0 + 150_000);
      expect(titles.map((t) => t.title)).toEqual(['Gmail', 'GitHub']);
      expect(titles[0].last_seen_at).toBeGreaterThanOrEqual(titles[1].last_seen_at);
    });

    it('excludes rows outside the [from, to] range', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t0 = 1_700_000_000_000;
      store.recordSample({ app_name: 'Chrome', window_title: 'before', sampled_at: t0 - 1000 });
      store.recordSample({ app_name: 'Chrome', window_title: 'inside', sampled_at: t0 + 50_000 });
      store.recordSample({ app_name: 'Chrome', window_title: 'after', sampled_at: t0 + 200_000 });

      const titles = store.listTitlesInSession('Chrome', t0, t0 + 100_000);
      expect(titles.map((t) => t.title)).toEqual(['inside']);
    });

    it('returns empty array when no rows match', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t0 = 1_700_000_000_000;
      store.recordSample({ app_name: 'iTerm', window_title: 'zsh', sampled_at: t0 });
      expect(store.listTitlesInSession('Chrome', t0, t0 + 1000)).toEqual([]);
    });
  });

  describe('purgeOlderThan', () => {
    it('deletes rows with last_seen_at < cutoff', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t0 = 1_700_000_000_000;
      store.recordSample({ app_name: 'A', window_title: 'old', sampled_at: t0 });
      store.recordSample({ app_name: 'B', window_title: 'mid', sampled_at: t0 + 60_000 });
      store.recordSample({ app_name: 'C', window_title: 'new', sampled_at: t0 + 120_000 });

      const deleted = store.purgeOlderThan(t0 + 60_000);
      expect(deleted).toBe(1);

      const rows = getDb()
        .prepare('SELECT window_title FROM window_history ORDER BY id')
        .all() as Array<{ window_title: string }>;
      expect(rows.map((r) => r.window_title)).toEqual(['mid', 'new']);
    });

    it('returns 0 when no rows match', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t0 = 1_700_000_000_000;
      store.recordSample({ app_name: 'A', window_title: 't', sampled_at: t0 });
      expect(store.purgeOlderThan(t0 - 1)).toBe(0);
    });
  });
});
