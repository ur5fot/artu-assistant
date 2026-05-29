import type Database from 'better-sqlite3';

export interface WindowHistoryRow {
  id: number;
  app_name: string;
  window_title: string;
  started_at: number;
  last_seen_at: number;
  sample_count: number;
}

export type WindowSession = WindowHistoryRow;

export interface WindowSampleInput {
  app_name: string;
  window_title: string;
  sampled_at: number;
}

export interface SessionTitle {
  title: string;
  last_seen_at: number;
}

export interface WindowHistoryStore {
  recordSample(sample: WindowSampleInput): void;
  /** The latest recorded session (most recent row). "Current" = newest. */
  findCurrentSession(): WindowSession | null;
  findRecentRows(since: number, limit?: number): WindowSession[];
  listTitlesInSession(app: string, from: number, to: number): SessionTitle[];
  purgeOlderThan(cutoff: number): number;
}

export function createWindowHistoryStore(deps: { db: Database.Database }): WindowHistoryStore {
  const { db } = deps;

  const selectLatest = db.prepare(
    `SELECT id, app_name, window_title, started_at, last_seen_at, sample_count
     FROM window_history ORDER BY id DESC LIMIT 1`,
  );
  const updateLatest = db.prepare(
    `UPDATE window_history
     SET last_seen_at = ?, sample_count = sample_count + 1
     WHERE id = ?`,
  );
  const insertRow = db.prepare(
    `INSERT INTO window_history (app_name, window_title, started_at, last_seen_at, sample_count)
     VALUES (?, ?, ?, ?, 1)`,
  );
  const selectRecent = db.prepare(
    `SELECT id, app_name, window_title, started_at, last_seen_at, sample_count
     FROM window_history
     WHERE last_seen_at >= ?
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
        updateLatest.run(sample.sampled_at, latest.id);
        return;
      }
      insertRow.run(
        sample.app_name,
        sample.window_title,
        sample.sampled_at,
        sample.sampled_at,
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

    purgeOlderThan(cutoff) {
      const info = deleteOlder.run(cutoff);
      return info.changes;
    },
  };
}
