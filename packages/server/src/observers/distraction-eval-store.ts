import type Database from 'better-sqlite3';

export type DistractionVerdict = 'distracted' | 'break' | 'working' | 'unknown' | 'error';
export type DistractionFeedback = 'back' | 'work' | 'snooze';

export interface DistractionEvalRow {
  id: number;
  app_name: string;
  dwell_started_at: number;
  window_title: string | null;
  evaluated_at: number;
  eval_dwell_ms: number;
  verdict: DistractionVerdict;
  confidence: number | null;
  pinged: number;
  feedback: DistractionFeedback | null;
  snooze_until: number | null;
}

export interface DistractionEvalInput {
  app_name: string;
  dwell_started_at: number;
  window_title?: string | null;
  evaluated_at: number;
  eval_dwell_ms: number;
  verdict: DistractionVerdict;
  confidence?: number | null;
  pinged?: boolean;
}

export interface DistractionEvalStore {
  /** Most recent eval for a given dwell key (app + runStart). */
  findLatestEvalForDwell(app: string, dwellStart: number): DistractionEvalRow | null;
  /** Most recent pinged eval for an app at or after `since` (cross-dwell dedup). */
  findRecentPing(app: string, since: number): DistractionEvalRow | null;
  /** Count of evals at or after `since` (daily LLM cap). */
  countEvalsSince(since: number): number;
  /** Max snooze_until still in the future relative to `now`, else null. */
  activeSnoozeUntil(now: number): number | null;
  /** Insert a new eval row, returning its id. */
  recordEval(input: DistractionEvalInput): number;
  /**
   * Attach button feedback to the latest eval for a dwell key. When
   * `snoozeUntil` is provided it is written; otherwise the existing value is
   * preserved. No-op if no eval exists for that dwell.
   */
  recordFeedback(
    app: string,
    dwellStart: number,
    feedback: DistractionFeedback,
    snoozeUntil?: number,
  ): void;
}

const COLUMNS =
  'id, app_name, dwell_started_at, window_title, evaluated_at, eval_dwell_ms, verdict, confidence, pinged, feedback, snooze_until';

export function createDistractionEvalStore(deps: { db: Database.Database }): DistractionEvalStore {
  const { db } = deps;

  const selectLatestForDwell = db.prepare(
    `SELECT ${COLUMNS} FROM distraction_evals
     WHERE app_name = ? AND dwell_started_at = ?
     ORDER BY evaluated_at DESC, id DESC
     LIMIT 1`,
  );
  const selectRecentPing = db.prepare(
    `SELECT ${COLUMNS} FROM distraction_evals
     WHERE app_name = ? AND pinged = 1 AND evaluated_at >= ?
     ORDER BY evaluated_at DESC, id DESC
     LIMIT 1`,
  );
  const countSince = db.prepare(
    `SELECT COUNT(*) AS n FROM distraction_evals WHERE evaluated_at >= ?`,
  );
  const selectSnooze = db.prepare(
    `SELECT MAX(snooze_until) AS s FROM distraction_evals WHERE snooze_until > ?`,
  );
  const insertEval = db.prepare(
    `INSERT INTO distraction_evals
       (app_name, dwell_started_at, window_title, evaluated_at, eval_dwell_ms, verdict, confidence, pinged)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateFeedback = db.prepare(
    `UPDATE distraction_evals
       SET feedback = ?, snooze_until = COALESCE(?, snooze_until)
     WHERE id = (
       SELECT id FROM distraction_evals
       WHERE app_name = ? AND dwell_started_at = ?
       ORDER BY evaluated_at DESC, id DESC
       LIMIT 1
     )`,
  );

  return {
    findLatestEvalForDwell(app, dwellStart) {
      const row = selectLatestForDwell.get(app, dwellStart) as DistractionEvalRow | undefined;
      return row ?? null;
    },

    findRecentPing(app, since) {
      const row = selectRecentPing.get(app, since) as DistractionEvalRow | undefined;
      return row ?? null;
    },

    countEvalsSince(since) {
      const row = countSince.get(since) as { n: number };
      return row.n;
    },

    activeSnoozeUntil(now) {
      const row = selectSnooze.get(now) as { s: number | null };
      return row.s ?? null;
    },

    recordEval(input) {
      const info = insertEval.run(
        input.app_name,
        input.dwell_started_at,
        input.window_title ?? null,
        input.evaluated_at,
        input.eval_dwell_ms,
        input.verdict,
        input.confidence ?? null,
        input.pinged ? 1 : 0,
      );
      return Number(info.lastInsertRowid);
    },

    recordFeedback(app, dwellStart, feedback, snoozeUntil) {
      updateFeedback.run(feedback, snoozeUntil ?? null, app, dwellStart);
    },
  };
}
