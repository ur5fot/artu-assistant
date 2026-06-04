import type Database from 'better-sqlite3';
import type { ComponentData, EmbedData, HandlerResult, HandlerRunRecord } from './types.js';

const TICK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Persisted shape of a publish event — enough to re-build the Discord DM when
// re-delivering an undelivered push on reconnect. Mirrors the transient
// `cognition_publish` event payload (minus runId).
export interface PublishPayload {
  content: string;
  embed?: EmbedData;
  components?: ComponentData[];
}

export interface UndeliveredPublish {
  runId: number;
  payload: PublishPayload;
}

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
  findUndeliveredPublishes(sinceMs: number): UndeliveredPublish[];
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

    recordHandlerRun({ handlerName, firedAt, durationMs, result }) {
      let outcome: 'publish' | 'skip' | 'error';
      let content: string | null = null;
      let reason: string | null = null;
      let publishPayload: string | null = null;
      if ('publish' in result) {
        outcome = 'publish';
        content = result.content;
        const payload: PublishPayload = {
          content: result.content,
          embed: result.embed,
          components: result.components,
        };
        publishPayload = JSON.stringify(payload);
      } else if ('skip' in result) {
        outcome = 'skip';
        reason = result.reason;
      } else {
        outcome = 'error';
        reason = result.message;
      }
      const r = db
        .prepare(
          `INSERT INTO cognition_handler_runs
             (handler_name, fired_at, duration_ms, outcome, content, reason, publish_payload)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(handlerName, firedAt, durationMs, outcome, content, reason, publishPayload);
      return Number(r.lastInsertRowid);
    },

    markPublished(runId, publishedAt) {
      db.prepare('UPDATE cognition_handler_runs SET published_at = ? WHERE id = ?')
        .run(publishedAt, runId);
    },

    findUndeliveredPublishes(sinceMs) {
      const rows = db
        .prepare(
          `SELECT id, content, publish_payload
           FROM cognition_handler_runs
           WHERE outcome = 'publish' AND published_at IS NULL AND fired_at >= ?
           ORDER BY fired_at ASC`,
        )
        .all(sinceMs) as Array<{
          id: number;
          content: string | null;
          publish_payload: string | null;
        }>;
      return rows.map((r) => {
        let payload: PublishPayload = { content: r.content ?? '' };
        if (r.publish_payload) {
          try {
            const parsed = JSON.parse(r.publish_payload) as PublishPayload;
            payload = {
              content: parsed.content ?? r.content ?? '',
              embed: parsed.embed,
              components: parsed.components,
            };
          } catch {
            // Corrupt payload — fall back to plain content so the push still goes out.
          }
        }
        return { runId: r.id, payload };
      });
    },

    getLastFiredAt(handlerName) {
      const row = db
        .prepare(
          'SELECT fired_at FROM cognition_handler_runs WHERE handler_name = ? ORDER BY fired_at DESC LIMIT 1',
        )
        .get(handlerName) as { fired_at: number } | undefined;
      return row ? row.fired_at : null;
    },

    getLastResult(handlerName) {
      const row = db
        .prepare(
          'SELECT outcome, content, reason FROM cognition_handler_runs WHERE handler_name = ? ORDER BY fired_at DESC LIMIT 1',
        )
        .get(handlerName) as
        | { outcome: string; content: string | null; reason: string | null }
        | undefined;
      if (!row) return null;
      if (row.outcome === 'publish') return { publish: true, content: row.content ?? '' };
      if (row.outcome === 'skip') return { skip: true, reason: row.reason ?? '' };
      return { error: true, message: row.reason ?? '' };
    },

    recentRuns(limit) {
      const rows = db
        .prepare(
          `SELECT id, handler_name, fired_at, duration_ms, outcome, content, reason, published_at
           FROM cognition_handler_runs
           ORDER BY fired_at DESC LIMIT ?`,
        )
        .all(limit) as Array<{
          id: number;
          handler_name: string;
          fired_at: number;
          duration_ms: number;
          outcome: string;
          content: string | null;
          reason: string | null;
          published_at: number | null;
        }>;
      return rows.map((r) => ({
        id: r.id,
        handlerName: r.handler_name,
        firedAt: r.fired_at,
        durationMs: r.duration_ms,
        outcome: r.outcome as 'publish' | 'skip' | 'error',
        content: r.content ?? undefined,
        reason: r.reason ?? undefined,
        publishedAt: r.published_at ?? undefined,
      }));
    },
  };
}
