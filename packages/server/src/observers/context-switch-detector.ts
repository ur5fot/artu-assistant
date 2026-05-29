import type Database from 'better-sqlite3';
import type { WindowHistoryStore, WindowSession } from './window-history-store.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

// How far back the detector walks through window_history when looking for the
// away session immediately preceding the current one. 8h covers a workday;
// rows older than this are irrelevant to "did you just switch contexts".
const HISTORY_LOOKBACK_MS = 8 * HOUR_MS;

export interface ContextPingRow {
  id: number;
  away_app: string;
  pinged_at: number;
  away_session_started_at: number;
  away_session_ended_at: number;
}

export interface ContextPingInput {
  away_app: string;
  away_session_started_at: number;
  away_session_ended_at: number;
  pinged_at: number;
}

export interface ContextPingStore {
  recordPing(input: ContextPingInput): void;
  findRecentPing(away_app: string, since: number): ContextPingRow | null;
}

export function createContextPingStore(deps: { db: Database.Database }): ContextPingStore {
  const { db } = deps;

  const insertPing = db.prepare(
    `INSERT INTO context_pings
       (away_app, pinged_at, away_session_started_at, away_session_ended_at)
     VALUES (?, ?, ?, ?)`,
  );
  const selectRecent = db.prepare(
    `SELECT id, away_app, pinged_at, away_session_started_at, away_session_ended_at
     FROM context_pings
     WHERE away_app = ? AND pinged_at >= ?
     ORDER BY pinged_at DESC
     LIMIT 1`,
  );

  return {
    recordPing(input) {
      insertPing.run(
        input.away_app,
        input.pinged_at,
        input.away_session_started_at,
        input.away_session_ended_at,
      );
    },
    findRecentPing(away_app, since) {
      const row = selectRecent.get(away_app, since) as ContextPingRow | undefined;
      return row ?? null;
    },
  };
}

export interface SwitchEvent {
  away_app: string;
  away_session_started_at: number;
  away_session_ended_at: number;
  current_app: string;
}

export interface DetectContextSwitchParams {
  now: number;
  store: WindowHistoryStore;
  pingStore: ContextPingStore;
  longSessionMin: number;
  switchGapMin: number;
  stableNewMin: number;
  dedupeWindowH: number;
}

/**
 * Pure heuristic — given the window history and ping log, decide whether the
 * user has just (stably) returned from a long away-session on a different app.
 *
 * Structure detected: [long session on app B] → [stable return to app A].
 * The away app B is what we offer to "restore". See the plan's edge-case table.
 */
export function detectContextSwitch(params: DetectContextSwitchParams): SwitchEvent | null {
  const { now, store, pingStore, longSessionMin, switchGapMin, stableNewMin, dedupeWindowH } =
    params;

  // 1. Current session must exist and be stable (focused long enough that we
  //    believe the user has actually settled, not mid-alt-tab).
  const current = store.findCurrentSession();
  if (!current) return null;
  if (now - current.started_at < stableNewMin * MINUTE_MS) return null;

  // 2. Find the contiguous run of a single foreign app immediately preceding
  //    the current session.
  const rows = store.findRecentRows(now - HISTORY_LOOKBACK_MS, 200); // most-recent-first
  const before = rows.filter((r) => r.id !== current.id && r.started_at < current.started_at);
  if (before.length === 0) return null;

  const awayApp = before[0].app_name;
  if (awayApp === current.app_name) return null; // no real switch

  const run: WindowSession[] = [];
  for (const row of before) {
    if (row.app_name !== awayApp) break;
    run.push(row); // most-recent-first
  }
  const last = run[0];
  const first = run[run.length - 1];

  // 3. The away session must be long enough to be worth restoring.
  const duration = last.last_seen_at - first.started_at;
  if (duration < longSessionMin * MINUTE_MS) return null;

  // 4. Gap between leaving the away app and arriving at current must be small.
  //    A large gap = the machine saw nothing focused (sleep/lock) — treat as a
  //    cold return, not a context switch.
  const gap = current.started_at - last.last_seen_at;
  if (gap > switchGapMin * MINUTE_MS) return null;

  // 5. Dedupe — at most one ping per away-app per dedupe window.
  const recentPing = pingStore.findRecentPing(awayApp, now - dedupeWindowH * HOUR_MS);
  if (recentPing) return null;

  return {
    away_app: awayApp,
    away_session_started_at: first.started_at,
    away_session_ended_at: last.last_seen_at,
    current_app: current.app_name,
  };
}
