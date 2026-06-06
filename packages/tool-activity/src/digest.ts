import type {
  ActivityByApp,
  ActivityDigest,
  ActivityEpisode,
  ActivityObserver,
  ActivityObserverCounts,
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
/** Honesty note: the judge samples; quiet windows are not "clean" windows. */
const COVERAGE_NOTE =
  'Наблюдатель оценивает активность выборочно — отсутствие отметок не значит отсутствие отвлечений.';

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

/** Build the distraction-observer layer from judge evals within the window. */
function buildObserver(evals: EvalLike[], range: ActivityRange): ActivityObserver {
  const episodes: ActivityEpisode[] = evals
    .filter((e) => e.evaluated_at >= range.from && e.evaluated_at <= range.to)
    .sort((a, b) => a.evaluated_at - b.evaluated_at)
    .map((e) => ({
      at: e.evaluated_at,
      app: e.app_name,
      title: e.window_title,
      dwell_min: round1(e.eval_dwell_ms / MIN_MS),
      verdict: e.verdict,
      confidence: e.confidence,
    }));

  const counts: ActivityObserverCounts = { distracted: 0, break: 0, working: 0, unknown: 0 };
  for (const ep of episodes) {
    if (ep.verdict === 'distracted') counts.distracted += 1;
    else if (ep.verdict === 'break') counts.break += 1;
    else if (ep.verdict === 'working') counts.working += 1;
    else counts.unknown += 1; // unknown, error, anything else
  }

  return { episodes, counts, coverage_note: COVERAGE_NOTE };
}

/** Compose a ready-to-voice RU narrative. Distractions are stated episodically. */
function buildSummary(digest: Omit<ActivityDigest, 'summary'>): string {
  const { range, total_active_min, by_app, top_sites, context_switches, observer } = digest;

  if (total_active_min === 0 && observer.episodes.length === 0) {
    return `За ${range.label} активности не зафиксировано — наблюдение пустое за этот период. ${COVERAGE_NOTE}`;
  }

  const parts: string[] = [];
  const topApps = by_app
    .slice(0, 3)
    .map((a) => `${a.app} ~${a.minutes} мин (${Math.round(a.share * 100)}%)`)
    .join(', ');
  parts.push(
    `За ${range.label} — ~${total_active_min} мин активности (оценочно, выборка ~30с)` +
      (topApps ? `: ${topApps}.` : '.'),
  );

  if (top_sites.length > 0) {
    const sites = top_sites
      .slice(0, 3)
      .map((s) => `${s.host} ~${s.minutes} мин`)
      .join(', ');
    parts.push(`Сайты: ${sites}.`);
  }

  if (context_switches > 0) {
    parts.push(`Переключений между приложениями: ${context_switches}.`);
  }

  if (observer.episodes.length > 0) {
    const { distracted, break: brk, working, unknown } = observer.counts;
    const bits: string[] = [];
    if (distracted > 0) bits.push(`${distracted} залипаний`);
    if (brk > 0) bits.push(`${brk} отдых`);
    if (working > 0) bits.push(`${working} рабочих`);
    if (unknown > 0) bits.push(`${unknown} неясных`);
    const detail = bits.length > 0 ? ` (${bits.join(', ')})` : '';
    parts.push(`Наблюдатель отметил ${observer.episodes.length} эпизодов${detail}.`);
  }

  parts.push(COVERAGE_NOTE);
  return parts.join(' ');
}

/**
 * Aggregate raw window-history rows into an {@link ActivityDigest}: idle apps
 * dropped, durations clamped to `range`, per-app/per-host time, a glued
 * timeline of notable app-runs, the number of context switches, a
 * distraction-observer layer built from `evals`, and a ready-made RU summary.
 * Pure and deterministic — no I/O.
 */
export function buildActivityDigest(
  rows: WindowRowLike[],
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
      // Active minutes only — sum the parts so dropped idle gaps (loginwindow,
      // screensaver) glued between same-app sessions don't inflate the span.
      min: round1(run.parts.reduce((a, p) => a + (p.end - p.start), 0) / MIN_MS),
    }))
    .filter((entry) => entry.min >= TIMELINE_MIN_MINUTES);

  const observer = buildObserver(evals, range);

  const base: Omit<ActivityDigest, 'summary'> = {
    range,
    total_active_min: round1(totalMs / MIN_MS),
    context_switches,
    by_app,
    top_sites,
    timeline,
    observer,
  };

  return { ...base, summary: buildSummary(base) };
}
