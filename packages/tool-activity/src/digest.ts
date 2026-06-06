import type {
  ActivityByApp,
  ActivityDigest,
  ActivityRange,
  ActivityTimelineEntry,
  ActivityTopSite,
  EvalLike,
  WindowRowLike,
} from './types.js';

const MIN_MS = 60_000;
/** App-run shorter than this is not "notable" enough for the timeline. */
const TIMELINE_MIN_MINUTES = 3;
/** Apps that mean the machine was idle/locked (mirrors the distraction detector). */
const IDLE_APP_NAMES = ['loginwindow', 'ScreenSaverEngine'];

/** A window row clamped to the range, with positive duration. */
interface ClampedInterval {
  app: string;
  title: string;
  url: string | null;
  start: number;
  end: number;
}

/** Contiguous run of one app, built by gluing adjacent same-app intervals. */
interface AppRun {
  app: string;
  from: number;
  to: number;
  parts: ClampedInterval[];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Clamp a row to `[range.from, range.to]`; null if it lands outside / empty. */
function clampRow(row: WindowRowLike, range: ActivityRange): ClampedInterval | null {
  if (IDLE_APP_NAMES.includes(row.app_name)) return null;
  const start = Math.max(row.started_at, range.from);
  const end = Math.min(row.last_seen_at, range.to);
  if (end <= start) return null;
  return {
    app: row.app_name,
    title: row.window_title,
    url: row.url ?? null,
    start,
    end,
  };
}

/** Extract a comparable host from a row URL (scheme optional), stripping `www.`. */
function hostOf(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const host = new URL(withScheme).hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Glue chronologically-sorted intervals into per-app runs (same app adjacent). */
function buildRuns(intervals: ClampedInterval[]): AppRun[] {
  const runs: AppRun[] = [];
  for (const iv of intervals) {
    const last = runs[runs.length - 1];
    if (last && last.app === iv.app) {
      last.to = Math.max(last.to, iv.end);
      last.parts.push(iv);
    } else {
      runs.push({ app: iv.app, from: iv.start, to: iv.end, parts: [iv] });
    }
  }
  return runs;
}

/** Title of the longest sub-interval in a run (its representative). */
function representativeTitle(run: AppRun): string {
  let best = run.parts[0];
  for (const p of run.parts) {
    if (p.end - p.start > best.end - best.start) best = p;
  }
  return best.title;
}

/**
 * Aggregate raw window-history rows into an {@link ActivityDigest}: idle apps
 * dropped, durations clamped to `range`, per-app/per-host time, a glued
 * timeline of notable app-runs, and the number of context switches. Pure and
 * deterministic — no I/O. `evals` is accepted for the observer layer added in
 * Task 2 and is unused here.
 */
export function buildActivityDigest(
  rows: WindowRowLike[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  evals: EvalLike[],
  range: ActivityRange,
): ActivityDigest {
  const intervals = rows
    .map((r) => clampRow(r, range))
    .filter((iv): iv is ClampedInterval => iv !== null)
    .sort((a, b) => a.start - b.start);

  // Per-app totals.
  const appMs = new Map<string, number>();
  let totalMs = 0;
  for (const iv of intervals) {
    const dur = iv.end - iv.start;
    totalMs += dur;
    appMs.set(iv.app, (appMs.get(iv.app) ?? 0) + dur);
  }
  const by_app: ActivityByApp[] = [...appMs.entries()]
    .map(([app, ms]) => ({
      app,
      minutes: round1(ms / MIN_MS),
      share: totalMs > 0 ? Math.round((ms / totalMs) * 100) / 100 : 0,
    }))
    .sort((a, b) => b.minutes - a.minutes || a.app.localeCompare(b.app));

  // Per-host totals (browser URLs only).
  const hostMs = new Map<string, number>();
  for (const iv of intervals) {
    if (!iv.url) continue;
    const host = hostOf(iv.url);
    if (!host) continue;
    hostMs.set(host, (hostMs.get(host) ?? 0) + (iv.end - iv.start));
  }
  const top_sites: ActivityTopSite[] = [...hostMs.entries()]
    .map(([host, ms]) => ({ host, minutes: round1(ms / MIN_MS) }))
    .sort((a, b) => b.minutes - a.minutes || a.host.localeCompare(b.host));

  // Glued runs → context switches (all runs) and notable timeline (>= 3 min).
  const runs = buildRuns(intervals);
  const context_switches = Math.max(0, runs.length - 1);
  const timeline: ActivityTimelineEntry[] = runs
    .map((run) => ({
      from: run.from,
      to: run.to,
      app: run.app,
      title: representativeTitle(run),
      min: round1((run.to - run.from) / MIN_MS),
    }))
    .filter((entry) => entry.min >= TIMELINE_MIN_MINUTES);

  return {
    range,
    total_active_min: round1(totalMs / MIN_MS),
    context_switches,
    by_app,
    top_sites,
    timeline,
  };
}
