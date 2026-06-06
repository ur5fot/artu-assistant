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
  /** Rows overlapping [from, to] (newest first), bounded above so a past-day
   * window can't have its LIMIT budget eaten by newer out-of-window rows. */
  findRowsInWindow(from: number, to: number, limit?: number): WindowSession[];
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
  // a transient blank URL never wipes a captured one. url_last_seen_at advances
  // ONLY when this sample actually carried a url (the CASE): a null-url resample
  // bumps last_seen_at (session continuity / blind detection) without claiming
  // the preserved url was re-visited — otherwise a stale URL would look freshly
  // seen and could falsely auto-close an action.
  const updateLatest = db.prepare(
    `UPDATE window_history
     SET last_seen_at = @sampledAt,
         sample_count = sample_count + 1,
         url = COALESCE(@url, url),
         url_last_seen_at = CASE WHEN @url IS NOT NULL THEN @sampledAt ELSE url_last_seen_at END
     WHERE id = @id`,
  );
  const insertRow = db.prepare(
    `INSERT INTO window_history
       (app_name, window_title, started_at, last_seen_at, sample_count, url, url_last_seen_at)
     VALUES (@app, @title, @sampledAt, @sampledAt, 1, @url, @urlLastSeen)`,
  );
  const selectRecent = db.prepare(
    `SELECT id, app_name, window_title, started_at, last_seen_at, sample_count, url
     FROM window_history
     WHERE last_seen_at >= ?
     ORDER BY last_seen_at DESC
     LIMIT ?`,
  );
  // Like selectRecent but bounded above by the window end (started_at < @to), so
  // a query for a past day (e.g. "yesterday") can't have its LIMIT budget eaten
  // by newer rows that fall after the window and get clamped away downstream.
  const selectInWindow = db.prepare(
    `SELECT id, app_name, window_title, started_at, last_seen_at, sample_count, url
     FROM window_history
     WHERE last_seen_at >= ? AND started_at < ?
     ORDER BY last_seen_at DESC
     LIMIT ?`,
  );
  // last_seen_at here is the url's OWN last-observed time (url_last_seen_at), not
  // the row's session last_seen_at — so a same-title resample that didn't
  // re-capture the url can't advance it past an action's startedAt.
  const selectRecentUrls = db.prepare(
    `SELECT url, MAX(url_last_seen_at) AS last_seen_at
     FROM window_history
     WHERE url IS NOT NULL AND url_last_seen_at >= ?
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
      const url = sample.url ?? null;
      const latest = selectLatest.get() as WindowHistoryRow | undefined;
      if (
        latest &&
        latest.app_name === sample.app_name &&
        latest.window_title === sample.window_title
      ) {
        updateLatest.run({ sampledAt: sample.sampled_at, url, id: latest.id });
        return;
      }
      insertRow.run({
        app: sample.app_name,
        title: sample.window_title,
        sampledAt: sample.sampled_at,
        url,
        urlLastSeen: url !== null ? sample.sampled_at : null,
      });
    },

    findCurrentSession() {
      const row = selectLatest.get() as WindowHistoryRow | undefined;
      return row ?? null;
    },

    findRecentRows(since, limit = 200) {
      return selectRecent.all(since, limit) as WindowSession[];
    },

    findRowsInWindow(from, to, limit = 2000) {
      return selectInWindow.all(from, to, limit) as WindowSession[];
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
