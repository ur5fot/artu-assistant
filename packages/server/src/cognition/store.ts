import type Database from 'better-sqlite3';
import type { HandlerResult, HandlerRunRecord } from './types.js';

const TICK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface CognitionStore {
  db: Database.Database;
  isPaused(): boolean;
  pause(now: number): void;
  resume(): void;
  recordTick(now: number): void;
  countTicksSince(sinceMs: number): number;
  getLastTickAt(): number | null;
  recordHandlerRun(params: {
    handlerName: string;
    firedAt: number;
    durationMs: number;
    result: HandlerResult;
  }): number;
  markPublished(runId: number, publishedAt: number): void;
  getLastFiredAt(handlerName: string): number | null;
  getLastResult(handlerName: string): HandlerResult | null;
  recentRuns(limit: number): HandlerRunRecord[];
}

export function createCognitionStore(deps: { db: Database.Database }): CognitionStore {
  const { db } = deps;

  return {
    db,

    isPaused() {
      const row = db
        .prepare('SELECT paused FROM cognition_state WHERE id = 1')
        .get() as { paused: number } | undefined;
      return !!row && row.paused === 1;
    },

    pause(now) {
      db.prepare('UPDATE cognition_state SET paused = 1, paused_at = ? WHERE id = 1').run(now);
    },

    resume() {
      db.prepare('UPDATE cognition_state SET paused = 0, paused_at = NULL WHERE id = 1').run();
    },

    recordTick(now) {
      db.prepare('INSERT INTO cognition_ticks (tick_at) VALUES (?)').run(now);
      const cutoff = now - TICK_RETENTION_MS;
      db.prepare('DELETE FROM cognition_ticks WHERE tick_at < ?').run(cutoff);
    },

    countTicksSince(sinceMs) {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM cognition_ticks WHERE tick_at >= ?')
        .get(sinceMs) as { n: number };
      return row.n;
    },

    getLastTickAt() {
      const row = db
        .prepare('SELECT tick_at FROM cognition_ticks ORDER BY tick_at DESC LIMIT 1')
        .get() as { tick_at: number } | undefined;
      return row ? row.tick_at : null;
    },

    recordHandlerRun(_params) {
      throw new Error('not implemented yet — Task 4');
    },

    markPublished(_runId, _publishedAt) {
      throw new Error('not implemented yet — Task 4');
    },

    getLastFiredAt(_handlerName) {
      throw new Error('not implemented yet — Task 4');
    },

    getLastResult(_handlerName) {
      throw new Error('not implemented yet — Task 4');
    },

    recentRuns(_limit) {
      throw new Error('not implemented yet — Task 4');
    },
  };
}
