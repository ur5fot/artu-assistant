import type Database from 'better-sqlite3';

export interface WindowHistoryRow {
  id: number;
  app_name: string;
  window_title: string;
  started_at: number;
  last_seen_at: number;
  sample_count: number;
  url: string | null;
}

export type WindowSession = WindowHistoryRow;

export interface WindowSampleInput {
  app_name: string;
  window_title: string;
  sampled_at: number;
  /** Active-tab URL (host+path), best-effort; absent for non-browsers. */
  url?: string;
}

export interface SessionTitle {
  title: string;
  last_seen_at: number;
}

export interface RecentUrl {
  url: string;
  last_seen_at: number;
}

export interface WindowHistoryStore {
  recordSample(sample: WindowSampleInput): void;
  /** The latest recorded session (most recent row). "Current" = newest. */
  findCurrentSession(): WindowSession | null;
  findRecentRows(since: number, limit?: number): WindowSession[];
  listTitlesInSession(app: string, from: number, to: number): SessionTitle[];
  /** Distinct visited URLs (non-null) with last_seen_at >= sinceMs, newest first. */
  recentUrlsSince(sinceMs: number, limit?: number): RecentUrl[];
  purgeOlderThan(cutoff: number): number;
}

export function createWindowHistoryStore(deps: { db: Database.Database }): WindowHistoryStore {
  const { db } = deps;

  const selectLatest = db.prepare(
    `SELECT id, app_name, window_title, started_at, last_seen_at, sample_count, url
     FROM window_history ORDER BY id DESC LIMIT 1`,
  );
  // COALESCE keeps the existing url when a later same-title sample has none, so
  // a transient blank URL never wipes a captured one.
  const updateLatest = db.prepare(
    `UPDATE window_history
     SET last_seen_at = ?, sample_count = sample_count + 1, url = COALESCE(?, url)
     WHERE id = ?`,
  );
  const insertRow = db.prepare(
    `INSERT INTO window_history (app_name, window_title, started_at, last_seen_at, sample_count, url)
     VALUES (?, ?, ?, ?, 1, ?)`,
  );
  const selectRecent = db.prepare(
    `SELECT id, app_name, window_title, started_at, last_seen_at, sample_count, url
     FROM window_history
     WHERE last_seen_at >= ?
     ORDER BY last_seen_at DESC
     LIMIT ?`,
  );
  const selectRecentUrls = db.prepare(
    `SELECT url, MAX(last_seen_at) AS last_seen_at
     FROM window_history
     WHERE url IS NOT NULL AND last_seen_at >= ?
     GROUP BY url
     ORDER BY last_seen_at DESC
     LIMIT ?`,
  );
  const selectTitles = db.prepare(
    `SELECT window_title AS title, MAX(last_seen_at) AS last_seen_at
     FROM window_history
     WHERE app_name = ? AND last_seen_at >= ? AND last_seen_at <= ?
     GROUP BY window_title
     ORDER BY last_seen_at DESC`,
  );
  const deleteOlder = db.prepare(
    `DELETE FROM window_history WHERE last_seen_at < ?`,
  );

  return {
    recordSample(sample) {
      const latest = selectLatest.get() as WindowHistoryRow | undefined;
      if (
        latest &&
        latest.app_name === sample.app_name &&
        latest.window_title === sample.window_title
      ) {
        updateLatest.run(sample.sampled_at, sample.url ?? null, latest.id);
        return;
      }
      insertRow.run(
        sample.app_name,
        sample.window_title,
        sample.sampled_at,
        sample.sampled_at,
        sample.url ?? null,
      );
    },

    findCurrentSession() {
      const row = selectLatest.get() as WindowHistoryRow | undefined;
      return row ?? null;
    },

    findRecentRows(since, limit = 200) {
      return selectRecent.all(since, limit) as WindowSession[];
    },

    listTitlesInSession(app, from, to) {
      return selectTitles.all(app, from, to) as SessionTitle[];
    },

    recentUrlsSince(sinceMs, limit = 500) {
      return selectRecentUrls.all(sinceMs, limit) as RecentUrl[];
    },

    purgeOlderThan(cutoff) {
      const info = deleteOlder.run(cutoff);
      return info.changes;
    },
  };
}
