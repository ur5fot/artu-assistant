import type { WindowHistoryStore } from './window-history-store.js';
import type { DistractionEvalStore } from './distraction-eval-store.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

// Lock/idle apps that must never count as a dwell context or as the "prior
// other app" anchor. Mirrors IDLE_APP_NAMES in morningBrief.helpers.ts.
const IDLE_APP_NAMES = ['loginwindow', 'ScreenSaverEngine'];

export interface DistractionCandidate {
  /** App the user is currently stuck in. */
  app: string;
  /** Current window title (used downstream for the judge + title-flip re-eval). */
  title: string;
  /** Earliest started_at of the contiguous app-level run = the dwell key. */
  runStart: number;
  /** how long the user has been in this app-run, in ms. */
  dwellMs: number;
}

export interface ShouldEvaluateDistractionParams {
  now: number;
  store: WindowHistoryStore;
  evalStore: DistractionEvalStore;
  /** Minimum app-level dwell before we consider waking the judge (minutes). */
  dwellMin: number;
  /** How far back to walk window_history when building the run (minutes). */
  workLookbackMin: number;
  /** Per-app cross-dwell ping dedup window (hours). */
  dedupeH: number;
  /** Re-eval a non-distracted dwell only after it grows this much (minutes). */
  reevalMin: number;
  /** Max evals per day before the filter goes silent (LLM cost ceiling). */
  dailyCap: number;
  /**
   * Freshness bound (ms): reject a current session whose last observation is
   * older than this. The window logger only writes a row when osascript returns
   * a snapshot, so on blind ticks (null/throw) or a stopped logger it writes
   * nothing — `findCurrentSession()` then returns a frozen "last good" row whose
   * dwell (`now - runStart`) keeps growing into a false candidate. Omit to skip
   * the guard (e.g. detector unit tests that don't simulate live sampling); the
   * production handler always supplies it from the poller interval.
   */
  freshnessMs?: number;
}

/**
 * Pure recall filter — given window history and the eval log, decide whether
 * the current app-run is a *candidate* worth waking the AI judge for. No AI,
 * no I/O beyond the two injected stores. Deliberately app-coarse and generous;
 * precision is the judge's job (see the design spec §2).
 *
 * Returns the dwell candidate, or null when no evaluation is warranted.
 */
export function shouldEvaluateDistraction(
  params: ShouldEvaluateDistractionParams,
): DistractionCandidate | null {
  const { now, store, evalStore, dwellMin, workLookbackMin, dedupeH, reevalMin, dailyCap, freshnessMs } =
    params;

  // §2.1 — current session exists and is not a lock/idle screen.
  const current = store.findCurrentSession();
  if (!current) return null;
  if (IDLE_APP_NAMES.includes(current.app_name)) return null;

  // §2.1b — freshness guard: don't judge a stale "last good" row. When the
  // logger goes blind (osascript lost Automation permission) or is stopped, no
  // new row is written, so `now - runStart` would keep aging a long-dead session
  // into a false distraction. A live dwell refreshes last_seen_at every tick, so
  // this only rejects genuinely stale state.
  if (freshnessMs != null && now - current.last_seen_at > freshnessMs) return null;

  // §2.2 — app-level dwell. Build the contiguous run of the current app at the
  // head of recent history (most-recent-first). Title changes inside the app
  // (e.g. a string of YouTube videos) coalesce into one run, so the dwell does
  // not reset on every title flip.
  const rows = store.findRecentRows(now - workLookbackMin * MINUTE_MS); // most-recent-first
  const run = [];
  for (const row of rows) {
    if (row.app_name !== current.app_name) break;
    run.push(row);
  }
  if (run.length === 0) return null; // current app not within lookback — can't size dwell
  const runStart = run[run.length - 1].started_at; // earliest in the run
  const dwellMs = now - runStart;
  if (dwellMs < dwellMin * MINUTE_MS) return null;

  // §2.3 — anti-degenerate: the user must have arrived here *from something*.
  // Require at least one non-idle session of a different app before runStart.
  const cameFromElsewhere = rows.some(
    (r) =>
      r.started_at < runStart &&
      r.app_name !== current.app_name &&
      !IDLE_APP_NAMES.includes(r.app_name),
  );
  if (!cameFromElsewhere) return null;

  // §2.4 — global snooze ("Отстань") not active.
  if (evalStore.activeSnoozeUntil(now) !== null) return null;

  // §2.5 — per-app cross-dwell dedup: no recent ping for this app.
  if (evalStore.findRecentPing(current.app_name, now - dedupeH * HOUR_MS)) return null;

  // §2.6 — this dwell key (app, runStart) not already worked out. Re-eval only a
  // previously non-distracted dwell, and only when it grew >= REEVAL_MIN or the
  // window title flipped inside the run (catches localhost -> YouTube fast).
  const latest = evalStore.findLatestEvalForDwell(current.app_name, runStart);
  if (latest) {
    if (latest.verdict === 'distracted') return null; // already judged distracted (pinged or low-conf)
    const dwellGrew = dwellMs - latest.eval_dwell_ms >= reevalMin * MINUTE_MS;
    const titleChanged = current.window_title !== (latest.window_title ?? null);
    if (!dwellGrew && !titleChanged) return null;
  }

  // §2.7 — daily LLM ceiling. Count evals since the start of the local day.
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  if (evalStore.countEvalsSince(dayStart) >= dailyCap) return null;

  return {
    app: current.app_name,
    title: current.window_title,
    runStart,
    dwellMs,
  };
}
