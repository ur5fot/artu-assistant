// Structural shapes for @r2/tool-activity. They mirror the real server stores
// (packages/server/src/observers/window-history-store.ts and
// distraction-eval-store.ts) but are duplicated locally so this package stays
// self-contained (no cross-package relative imports). TypeScript's structural
// typing means the real rows/stores satisfy these. If they drift, lift into
// @r2/shared.

/** A resolved time window with a human-facing RU label. */
export interface ActivityRange {
  /** Window start, epoch ms (inclusive). */
  from: number;
  /** Window end, epoch ms (inclusive). */
  to: number;
  /** RU label, e.g. «сегодня (6 июня)». */
  label: string;
}

/** Subset of a `window_history` row the digest needs. */
export interface WindowRowLike {
  app_name: string;
  window_title: string;
  /** Run start, epoch ms. */
  started_at: number;
  /** Last sample for this run, epoch ms. */
  last_seen_at: number;
  /** Active-tab URL (host+path), best-effort; absent for non-browsers. */
  url?: string | null;
}

/** Subset of a `distraction_evals` row the observer layer needs (Task 2). */
export interface EvalLike {
  app_name: string;
  window_title: string | null;
  /** When the judge evaluated this dwell, epoch ms. */
  evaluated_at: number;
  /** Dwell length the judge saw, ms. */
  eval_dwell_ms: number;
  verdict: string;
  confidence: number | null;
}

/** Time spent in one application across the window. */
export interface ActivityByApp {
  app: string;
  minutes: number;
  /** Fraction of `total_active_min`, 0..1. */
  share: number;
}

/** Time spent on one host (grouped from row URLs). */
export interface ActivityTopSite {
  host: string;
  minutes: number;
}

/** One distraction-judge episode mapped from a `distraction_evals` row. */
export interface ActivityEpisode {
  /** When the judge evaluated the dwell, epoch ms. */
  at: number;
  app: string;
  title: string | null;
  /** Dwell length the judge saw, minutes. */
  dwell_min: number;
  /** Judge verdict (distracted/break/working/unknown/error). */
  verdict: string;
  confidence: number | null;
}

/** Episode tallies by verdict. `error` verdicts fold into `unknown`. */
export interface ActivityObserverCounts {
  distracted: number;
  break: number;
  working: number;
  unknown: number;
}

/**
 * The distraction-observer layer over a window: the episodes the judge logged,
 * their tallies, and a permanent honesty note that sampling is selective.
 */
export interface ActivityObserver {
  /** Judge episodes in the window, chronological. */
  episodes: ActivityEpisode[];
  counts: ActivityObserverCounts;
  /** Always present: sampling is selective; no marks ≠ no distractions. */
  coverage_note: string;
}

/** One notable app-run on the chronological timeline. */
export interface ActivityTimelineEntry {
  /** Run start, epoch ms (clamped to range). */
  from: number;
  /** Run end, epoch ms (clamped to range). */
  to: number;
  app: string;
  /** Representative window title (the longest sub-run within the app-run). */
  title: string;
  /** Run span in minutes. */
  min: number;
}

/** Aggregated digest of digital activity over a window. */
export interface ActivityDigest {
  range: ActivityRange;
  /** Σ of clamped, non-idle app-run minutes. */
  total_active_min: number;
  /** Number of application switches across the chronological timeline. */
  context_switches: number;
  /** Per-app minutes + share, most time first. */
  by_app: ActivityByApp[];
  /** Per-host minutes, most time first. */
  top_sites: ActivityTopSite[];
  /** Notable app-runs (>= 3 min), chronological. */
  timeline: ActivityTimelineEntry[];
  /** Distraction-observer layer (episodes + counts + honesty note). */
  observer: ActivityObserver;
  /** Ready-made RU narrative an agent can voice verbatim. */
  summary: string;
}

/** Minimal window-history store surface the `activity` tool depends on. */
export interface ActivityStoreLike {
  /** Rows overlapping [from, to], newest first. Bounded above so a past-day
   * window isn't truncated by newer out-of-window rows hitting the limit. */
  findRowsInWindow(from: number, to: number, limit?: number): WindowRowLike[];
}

/** Minimal distraction-eval store surface (window listing, used in Task 2+). */
export interface ActivityEvalStoreLike {
  listEvalsInWindow(from: number, to: number): EvalLike[];
}

/** Dependencies injected into `createTool`. Null when the observer is off. */
export interface ActivityDeps {
  store: ActivityStoreLike | null;
  evalStore: ActivityEvalStoreLike | null;
}
