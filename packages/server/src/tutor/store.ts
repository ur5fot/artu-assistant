import type Database from 'better-sqlite3';

/** CEFR levels the placement test maps to. `null` before placement completes. */
export type TutorLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
export type PlacementState = 'none' | 'in_progress' | 'done';
export type LessonStatus = 'awaiting_mcq' | 'awaiting_free' | 'done';

/** Single-user tutor profile (id = 1). `placementPayload` is parsed JSON. */
export interface TutorProfile {
  level: TutorLevel | null;
  placementState: PlacementState;
  placementPayload: unknown | null;
  dailyHour: number | null;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TutorLesson {
  id: number;
  topic: string;
  /** Parsed lesson JSON: explanation + exercises + per-exercise user state. */
  payload: unknown;
  status: LessonStatus;
  currentEx: number;
  score: number | null;
  createdAt: number;
  completedAt: number | null;
}

export interface TutorProgress {
  topic: string;
  attempts: number;
  correct: number;
  /** EWMA of per-attempt correctness in [0, 1]. */
  mastery: number;
  lastAt: number;
}

/** Fields callers may patch on the profile. Omitted fields are left untouched. */
export interface ProfilePatch {
  level?: TutorLevel | null;
  placementState?: PlacementState;
  placementPayload?: unknown | null;
  dailyHour?: number | null;
  paused?: boolean;
}

export interface LessonPatch {
  payload?: unknown;
  status?: LessonStatus;
  currentEx?: number;
  score?: number | null;
}

/** Smoothing factor for the mastery EWMA: mastery' = α·target + (1-α)·mastery. */
export const DEFAULT_MASTERY_ALPHA = 0.4;

export interface TutorStore {
  getProfile(): TutorProfile | null;
  /** Insert-or-update the single profile row (id = 1), applying `patch`. */
  updateProfile(patch: ProfilePatch): TutorProfile;

  createLesson(input: { topic: string; payload: unknown }): TutorLesson;
  getLesson(id: number): TutorLesson | null;
  /** Newest lesson whose status != done, or null when none is active. */
  getActiveLesson(): TutorLesson | null;
  updateLesson(id: number, patch: LessonPatch): TutorLesson;
  /** Terminal transition: status = done, set score + completed_at. */
  completeLesson(id: number, score: number): TutorLesson;

  getProgress(topic: string): TutorProgress | null;
  listProgress(): TutorProgress[];
  /** Fold one attempt into `topic`'s progress: bump attempts (+correct), and
   *  move mastery toward `correct ? 1 : 0` (or `outcome` if given) via EWMA. */
  recordAttempt(input: {
    topic: string;
    correct: boolean;
    outcome?: number;
    alpha?: number;
  }): TutorProgress;
}

interface ProfileRow {
  level: string | null;
  placement_state: string;
  placement_payload: string | null;
  daily_hour: number | null;
  paused: number;
  created_at: number;
  updated_at: number;
}

interface LessonRow {
  id: number;
  topic: string;
  payload: string;
  status: string;
  current_ex: number;
  score: number | null;
  created_at: number;
  completed_at: number | null;
}

interface ProgressRow {
  topic: string;
  attempts: number;
  correct: number;
  mastery: number;
  last_at: number;
}

function mapProfile(row: ProfileRow): TutorProfile {
  return {
    level: (row.level as TutorLevel | null) ?? null,
    placementState: row.placement_state as PlacementState,
    placementPayload:
      row.placement_payload == null ? null : JSON.parse(row.placement_payload),
    dailyHour: row.daily_hour,
    paused: row.paused === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLesson(row: LessonRow): TutorLesson {
  return {
    id: row.id,
    topic: row.topic,
    payload: JSON.parse(row.payload),
    status: row.status as LessonStatus,
    currentEx: row.current_ex,
    score: row.score,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function mapProgress(row: ProgressRow): TutorProgress {
  return {
    topic: row.topic,
    attempts: row.attempts,
    correct: row.correct,
    mastery: row.mastery,
    lastAt: row.last_at,
  };
}

export function createTutorStore(deps: {
  db: Database.Database;
  now?: () => number;
}): TutorStore {
  const { db } = deps;
  const now = deps.now ?? (() => Date.now());

  function readProfile(): ProfileRow | undefined {
    return db.prepare('SELECT * FROM tutor_profile WHERE id = 1').get() as
      | ProfileRow
      | undefined;
  }

  function readLesson(id: number): LessonRow | undefined {
    return db.prepare('SELECT * FROM tutor_lesson WHERE id = ?').get(id) as
      | LessonRow
      | undefined;
  }

  return {
    getProfile() {
      const row = readProfile();
      return row ? mapProfile(row) : null;
    },

    updateProfile(patch) {
      const ts = now();
      const existing = readProfile();
      if (!existing) {
        db.prepare(
          `INSERT INTO tutor_profile
             (id, level, placement_state, placement_payload, daily_hour, paused, created_at, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          patch.level ?? null,
          patch.placementState ?? 'none',
          patch.placementPayload === undefined || patch.placementPayload === null
            ? null
            : JSON.stringify(patch.placementPayload),
          patch.dailyHour ?? null,
          patch.paused ? 1 : 0,
          ts,
          ts,
        );
      } else {
        const level =
          patch.level !== undefined ? patch.level : existing.level;
        const placementState =
          patch.placementState !== undefined
            ? patch.placementState
            : existing.placement_state;
        const placementPayload =
          patch.placementPayload === undefined
            ? existing.placement_payload
            : patch.placementPayload === null
              ? null
              : JSON.stringify(patch.placementPayload);
        const dailyHour =
          patch.dailyHour !== undefined ? patch.dailyHour : existing.daily_hour;
        const paused =
          patch.paused !== undefined ? (patch.paused ? 1 : 0) : existing.paused;
        db.prepare(
          `UPDATE tutor_profile
             SET level = ?, placement_state = ?, placement_payload = ?,
                 daily_hour = ?, paused = ?, updated_at = ?
           WHERE id = 1`,
        ).run(level, placementState, placementPayload, dailyHour, paused, ts);
      }
      return mapProfile(readProfile()!);
    },

    createLesson({ topic, payload }) {
      const ts = now();
      const info = db
        .prepare(
          `INSERT INTO tutor_lesson (topic, payload, status, current_ex, created_at)
           VALUES (?, ?, 'awaiting_mcq', 0, ?)`,
        )
        .run(topic, JSON.stringify(payload), ts);
      return mapLesson(readLesson(Number(info.lastInsertRowid))!);
    },

    getLesson(id) {
      const row = readLesson(id);
      return row ? mapLesson(row) : null;
    },

    getActiveLesson() {
      const row = db
        .prepare(
          `SELECT * FROM tutor_lesson
           WHERE status != 'done'
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get() as LessonRow | undefined;
      return row ? mapLesson(row) : null;
    },

    updateLesson(id, patch) {
      const existing = readLesson(id);
      if (!existing) throw new Error(`tutor_lesson ${id} not found`);
      const payload =
        patch.payload !== undefined
          ? JSON.stringify(patch.payload)
          : existing.payload;
      const status =
        patch.status !== undefined ? patch.status : existing.status;
      const currentEx =
        patch.currentEx !== undefined ? patch.currentEx : existing.current_ex;
      const score =
        patch.score !== undefined ? patch.score : existing.score;
      db.prepare(
        `UPDATE tutor_lesson
           SET payload = ?, status = ?, current_ex = ?, score = ?
         WHERE id = ?`,
      ).run(payload, status, currentEx, score, id);
      return mapLesson(readLesson(id)!);
    },

    completeLesson(id, score) {
      const existing = readLesson(id);
      if (!existing) throw new Error(`tutor_lesson ${id} not found`);
      db.prepare(
        `UPDATE tutor_lesson
           SET status = 'done', score = ?, completed_at = ?
         WHERE id = ?`,
      ).run(score, now(), id);
      return mapLesson(readLesson(id)!);
    },

    getProgress(topic) {
      const row = db
        .prepare('SELECT * FROM tutor_progress WHERE topic = ?')
        .get(topic) as ProgressRow | undefined;
      return row ? mapProgress(row) : null;
    },

    listProgress() {
      const rows = db
        .prepare('SELECT * FROM tutor_progress ORDER BY last_at DESC')
        .all() as ProgressRow[];
      return rows.map(mapProgress);
    },

    recordAttempt({ topic, correct, outcome, alpha }) {
      const a = alpha ?? DEFAULT_MASTERY_ALPHA;
      const target = outcome ?? (correct ? 1 : 0);
      const ts = now();
      const prev = db
        .prepare('SELECT * FROM tutor_progress WHERE topic = ?')
        .get(topic) as ProgressRow | undefined;
      if (!prev) {
        // First attempt seeds mastery directly at the target — no prior EWMA
        // value to blend, so blending against the 0 default would understate
        // a correct first answer.
        db.prepare(
          `INSERT INTO tutor_progress (topic, attempts, correct, mastery, last_at)
           VALUES (?, 1, ?, ?, ?)`,
        ).run(topic, correct ? 1 : 0, target, ts);
      } else {
        const mastery = a * target + (1 - a) * prev.mastery;
        db.prepare(
          `UPDATE tutor_progress
             SET attempts = attempts + 1,
                 correct = correct + ?,
                 mastery = ?,
                 last_at = ?
           WHERE topic = ?`,
        ).run(correct ? 1 : 0, mastery, ts, topic);
      }
      return mapProgress(
        db
          .prepare('SELECT * FROM tutor_progress WHERE topic = ?')
          .get(topic) as ProgressRow,
      );
    },
  };
}
