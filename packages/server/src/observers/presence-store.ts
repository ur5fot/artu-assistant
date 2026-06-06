import type Database from 'better-sqlite3';

/** A closed away span: the user was idle from `away_started_at` (back-dated to
 * when idleness actually began) until `away_ended_at` (the return tick). */
export interface AwaySpan {
  id: number;
  away_started_at: number;
  away_ended_at: number;
}

export interface PresenceStore {
  /** Record a finalized away span. No-op if `to <= from` (nothing to record). */
  recordAway(from: number, to: number): void;
  /** Away spans overlapping [from, to] (any part inside the window), newest
   * first. A span counts as overlapping when it starts before `to` and ends
   * after `from`. */
  listAwayInWindow(from: number, to: number): AwaySpan[];
  purgeOlderThan(cutoff: number): number;
}

export function createPresenceStore(deps: {
  db: Database.Database;
}): PresenceStore {
  const { db } = deps;

  const insertAway = db.prepare(
    `INSERT INTO presence_log (away_started_at, away_ended_at)
     VALUES (@from, @to)`,
  );
  // Overlap with [from, to]: span_start < to AND span_end > from. Touching
  // exactly at a boundary (zero-length intersection) doesn't count.
  const selectInWindow = db.prepare(
    `SELECT id, away_started_at, away_ended_at
     FROM presence_log
     WHERE away_started_at < @to AND away_ended_at > @from
     ORDER BY away_ended_at DESC`,
  );
  const deleteOlder = db.prepare(
    `DELETE FROM presence_log WHERE away_ended_at < ?`,
  );

  return {
    recordAway(from, to) {
      if (to <= from) return;
      insertAway.run({ from, to });
    },

    listAwayInWindow(from, to) {
      return selectInWindow.all({ from, to }) as AwaySpan[];
    },

    purgeOlderThan(cutoff) {
      const info = deleteOlder.run(cutoff);
      return info.changes;
    },
  };
}
