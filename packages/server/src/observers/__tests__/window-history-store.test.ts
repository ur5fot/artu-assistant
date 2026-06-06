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

  describe('findRowsInWindow', () => {
    it('returns only rows overlapping [from, to], most-recent-first', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t0 = 1_700_000_000_000;
      store.recordSample({ app_name: 'before', window_title: 't', sampled_at: t0 - 60_000 });
      store.recordSample({ app_name: 'inside1', window_title: 't', sampled_at: t0 + 10_000 });
      store.recordSample({ app_name: 'inside2', window_title: 't', sampled_at: t0 + 50_000 });
      store.recordSample({ app_name: 'after', window_title: 't', sampled_at: t0 + 200_000 });

      const rows = store.findRowsInWindow(t0, t0 + 100_000);
      expect(rows.map((r) => r.app_name)).toEqual(['inside2', 'inside1']);
    });

    it('does not let newer out-of-window rows consume the LIMIT budget', () => {
      // Regression: querying a past day must not be truncated by today's rows.
      const store = createWindowHistoryStore({ db: getDb() });
      const dayStart = 1_700_000_000_000;
      const dayEnd = dayStart + 86_400_000;
      // One row inside the target (past) day.
      store.recordSample({ app_name: 'pastday', window_title: 't', sampled_at: dayStart + 1000 });
      // Two newer rows after the window (would sort first under findRecentRows).
      store.recordSample({ app_name: 'today1', window_title: 't', sampled_at: dayEnd + 60_000 });
      store.recordSample({ app_name: 'today2', window_title: 't', sampled_at: dayEnd + 120_000 });

      // limit=1: an unbounded query would return only 'today2'; the windowed
      // query must still surface the in-window 'pastday' row.
      const rows = store.findRowsInWindow(dayStart, dayEnd, 1);
      expect(rows.map((r) => r.app_name)).toEqual(['pastday']);
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

  describe('url capture', () => {
    it('persists and round-trips url on insert', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t = 1_700_000_000_000;
      store.recordSample({ app_name: 'Chrome', window_title: 'Gmail', sampled_at: t, url: 'example.com/x' });
      const row = getDb()
        .prepare('SELECT url FROM window_history')
        .get() as { url: string | null };
      expect(row.url).toBe('example.com/x');
    });

    it('stores url as null when absent', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t = 1_700_000_000_000;
      store.recordSample({ app_name: 'Finder', window_title: 'Docs', sampled_at: t });
      const row = getDb().prepare('SELECT url FROM window_history').get() as { url: string | null };
      expect(row.url).toBeNull();
    });

    it('a later same-title sample without url keeps the captured url (COALESCE)', () => {
      const store = createWindowHistoryStore({ db: getDb() });
      const t = 1_700_000_000_000;
      store.recordSample({ app_name: 'Chrome', window_title: 'Gmail', sampled_at: t, url: 'example.com/x' });
      store.recordSample({ app_name: 'Chrome', window_title: 'Gmail', sampled_at: t + 30_000 });
      const row = getDb().prepare('SELECT url, sample_count FROM window_history').get() as {
        url: string | null; sample_count: number;
      };
      expect(row.url).toBe('example.com/x');
      expect(row.sample_count).toBe(2);
    });

    it('a later same-title sample with a new url overwrites the captured url (COALESCE non-null)', () => {
      // COALESCE(?, url) keeps the old url only when the incoming url is null; a
      // real new url replaces it. Pins this so a regression to preserve-old
      // (which would leave matching using a stale url) is caught.
      const store = createWindowHistoryStore({ db: getDb() });
      const t = 1_700_000_000_000;
      store.recordSample({ app_name: 'Chrome', window_title: 'Gmail', sampled_at: t, url: 'example.com/1' });
      store.recordSample({ app_name: 'Chrome', window_title: 'Gmail', sampled_at: t + 30_000, url: 'example.com/2' });
      const row = getDb().prepare('SELECT url, sample_count FROM window_history').get() as {
        url: string | null; sample_count: number;
      };
      expect(row.url).toBe('example.com/2');
      expect(row.sample_count).toBe(2);
    });

    describe('recentUrlsSince', () => {
      it('returns distinct non-null urls with last_seen_at >= bound, newest first', () => {
        const store = createWindowHistoryStore({ db: getDb() });
        const t0 = 1_700_000_000_000;
        store.recordSample({ app_name: 'Chrome', window_title: 'a', sampled_at: t0, url: 'a.com/1' });
        store.recordSample({ app_name: 'Finder', window_title: 'd', sampled_at: t0 + 30_000 });
        store.recordSample({ app_name: 'Chrome', window_title: 'b', sampled_at: t0 + 60_000, url: 'b.com/2' });

        const urls = store.recentUrlsSince(t0 + 30_000);
        expect(urls).toHaveLength(1);
        expect(urls[0].url).toBe('b.com/2');
        expect(urls[0].last_seen_at).toBe(t0 + 60_000);
      });

      it('collapses repeated url to its max last_seen_at', () => {
        const store = createWindowHistoryStore({ db: getDb() });
        const t0 = 1_700_000_000_000;
        store.recordSample({ app_name: 'Chrome', window_title: 'a', sampled_at: t0, url: 'a.com/1' });
        store.recordSample({ app_name: 'iTerm', window_title: 'z', sampled_at: t0 + 30_000 });
        store.recordSample({ app_name: 'Chrome', window_title: 'a2', sampled_at: t0 + 60_000, url: 'a.com/1' });

        const urls = store.recentUrlsSince(t0);
        expect(urls).toHaveLength(1);
        expect(urls[0]).toEqual({ url: 'a.com/1', last_seen_at: t0 + 60_000 });
      });

      it('respects the limit param', () => {
        const store = createWindowHistoryStore({ db: getDb() });
        const t0 = 1_700_000_000_000;
        for (let i = 0; i < 4; i++) {
          store.recordSample({ app_name: 'Chrome', window_title: `t${i}`, sampled_at: t0 + i * 60_000, url: `s${i}.com/p` });
        }
        const urls = store.recentUrlsSince(t0, 2);
        expect(urls).toHaveLength(2);
        expect(urls[0].url).toBe('s3.com/p');
      });

      it('does NOT advance a url last-seen on a same-title resample without a url', () => {
        // A transient URL-capture failure (or same-title navigation) bumps the
        // row's session last_seen_at via COALESCE, but the url was NOT actually
        // re-observed — so its recency must stay at the original visit time and
        // not slide forward (which would falsely look like a fresh visit).
        const store = createWindowHistoryStore({ db: getDb() });
        const t0 = 1_700_000_000_000;
        store.recordSample({ app_name: 'Chrome', window_title: 'Issue', sampled_at: t0, url: 'gh.com/o/r' });
        // Same app+title, no url (capture failed) at a much later time.
        store.recordSample({ app_name: 'Chrome', window_title: 'Issue', sampled_at: t0 + 600_000 });

        // The url's recency stayed at t0, so a bound past t0 finds nothing.
        expect(store.recentUrlsSince(t0 + 1)).toEqual([]);
        // And at t0 it still reports the original observation time, not t0+600_000.
        const urls = store.recentUrlsSince(t0);
        expect(urls).toEqual([{ url: 'gh.com/o/r', last_seen_at: t0 }]);
      });

      it('advances url last-seen when the same url IS re-observed', () => {
        const store = createWindowHistoryStore({ db: getDb() });
        const t0 = 1_700_000_000_000;
        store.recordSample({ app_name: 'Chrome', window_title: 'Issue', sampled_at: t0, url: 'gh.com/o/r' });
        store.recordSample({ app_name: 'Chrome', window_title: 'Issue', sampled_at: t0 + 600_000, url: 'gh.com/o/r' });
        expect(store.recentUrlsSince(t0 + 1)).toEqual([{ url: 'gh.com/o/r', last_seen_at: t0 + 600_000 }]);
      });

      it('returns empty array when no url rows match', () => {
        const store = createWindowHistoryStore({ db: getDb() });
        const t0 = 1_700_000_000_000;
        store.recordSample({ app_name: 'Finder', window_title: 'd', sampled_at: t0 });
        expect(store.recentUrlsSince(t0)).toEqual([]);
      });
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
