import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTool, resolveRange } from '../index.js';
import type {
  ActivityDigest,
  ActivityEvalStoreLike,
  ActivityPresenceStoreLike,
  ActivityStoreLike,
  AwaySpanLike,
  EvalLike,
  WindowRowLike,
} from '../types.js';

const MIN = 60_000;
const DAY = 86_400_000;

/** A fake window-history store returning fixed rows, recording its window args. */
function fakeStore(
  rows: WindowRowLike[],
): ActivityStoreLike & { lastSince: number | null; lastWindow: [number, number] | null } {
  return {
    lastSince: null,
    lastWindow: null,
    findRowsInWindow(from: number, to: number) {
      this.lastSince = from;
      this.lastWindow = [from, to];
      return rows;
    },
  };
}

/** A fake eval store returning fixed evals, recording its window args. */
function fakeEvalStore(
  evals: EvalLike[],
): ActivityEvalStoreLike & { lastWindow: [number, number] | null } {
  return {
    lastWindow: null,
    listEvalsInWindow(from: number, to: number) {
      this.lastWindow = [from, to];
      return evals;
    },
  };
}

/** A fake presence store returning fixed away spans, recording its window args. */
function fakePresenceStore(
  spans: AwaySpanLike[],
): ActivityPresenceStoreLike & { lastWindow: [number, number] | null } {
  return {
    lastWindow: null,
    listAwayInWindow(from: number, to: number) {
      this.lastWindow = [from, to];
      return spans;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveRange', () => {
  // 2026-06-06 14:30 local time as the "now" reference.
  const now = new Date(2026, 5, 6, 14, 30, 0, 0).getTime();
  const midnight = new Date(2026, 5, 6, 0, 0, 0, 0).getTime();

  it('today → [local midnight, now]', () => {
    const r = resolveRange('today', now);
    expect(r.from).toBe(midnight);
    expect(r.to).toBe(now);
    expect(r.label).toContain('сегодня');
    expect(r.label).toContain('6 июня');
  });

  it('yesterday → [midnight − 24h, midnight]', () => {
    const r = resolveRange('yesterday', now);
    expect(r.from).toBe(midnight - DAY);
    expect(r.to).toBe(midnight);
    expect(r.label).toContain('вчера');
    expect(r.label).toContain('5 июня');
  });

  it('last_24h → [now − 24h, now]', () => {
    const r = resolveRange('last_24h', now);
    expect(r.from).toBe(now - DAY);
    expect(r.to).toBe(now);
    expect(r.label).toContain('последние 24 часа');
  });

  it('unknown period falls back to today', () => {
    // @ts-expect-error testing the runtime fallback for an invalid value
    const r = resolveRange('bogus', now);
    expect(r.from).toBe(midnight);
    expect(r.to).toBe(now);
  });
});

describe('activity tool', () => {
  it('is read-only and registered with the expected shape', () => {
    const [tool] = createTool({ store: fakeStore([]), evalStore: fakeEvalStore([]) });
    expect(tool.name).toBe('activity');
    expect(tool.permissionLevel).toBe('auto');
    expect(tool.provider).toBe('all');
    const period = (tool.parameters.properties as Record<string, { enum?: string[] }>).period;
    expect(period.enum).toEqual(['today', 'yesterday', 'last_24h']);
  });

  it('disabled observer (store null) → success:false with a clear error', async () => {
    const [tool] = createTool({ store: null, evalStore: null });
    const res = await tool.handler({ period: 'today' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('WINDOW_LOGGER_ENABLED');
  });

  it('store throwing → success:false carrying the error message', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 6, 14, 30, 0, 0));
    const store: ActivityStoreLike = {
      findRowsInWindow() {
        throw new Error('db gone');
      },
    };
    const [tool] = createTool({ store, evalStore: fakeEvalStore([]) });
    const res = await tool.handler({ period: 'today' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('db gone');
  });

  it('success: builds a digest from store rows + evals', async () => {
    vi.useFakeTimers();
    const now = new Date(2026, 5, 6, 14, 30, 0, 0);
    vi.setSystemTime(now);
    const t0 = new Date(2026, 5, 6, 9, 0, 0, 0).getTime();

    const rows: WindowRowLike[] = [
      {
        app_name: 'Code',
        window_title: 'index.ts',
        started_at: t0,
        last_seen_at: t0 + 30 * MIN,
        url: null,
      },
    ];
    const evals: EvalLike[] = [
      {
        app_name: 'Safari',
        window_title: 'youtube',
        evaluated_at: t0 + 10 * MIN,
        eval_dwell_ms: 5 * MIN,
        verdict: 'distracted',
        confidence: 0.9,
      },
    ];
    const store = fakeStore(rows);
    const evalStore = fakeEvalStore(evals);
    const [tool] = createTool({ store, evalStore });

    const res = await tool.handler({ period: 'today' });
    expect(res.success).toBe(true);
    const data = res.data as ActivityDigest;
    expect(data.total_active_min).toBe(30);
    expect(data.by_app[0].app).toBe('Code');
    expect(data.observer.episodes).toHaveLength(1);
    expect(data.observer.counts.distracted).toBe(1);

    // Store was queried from local midnight; eval store over the full window.
    const midnight = new Date(2026, 5, 6, 0, 0, 0, 0).getTime();
    expect(store.lastSince).toBe(midnight);
    expect(evalStore.lastWindow).toEqual([midnight, now.getTime()]);
  });

  it('injects presence away spans over the window into the digest', async () => {
    vi.useFakeTimers();
    const now = new Date(2026, 5, 6, 14, 30, 0, 0);
    vi.setSystemTime(now);
    const t0 = new Date(2026, 5, 6, 9, 0, 0, 0).getTime();

    const rows: WindowRowLike[] = [
      { app_name: 'Code', window_title: 'index.ts', started_at: t0, last_seen_at: t0 + 60 * MIN, url: null },
    ];
    const spans: AwaySpanLike[] = [
      { away_started_at: t0 + 20 * MIN, away_ended_at: t0 + 35 * MIN },
    ];
    const presence = fakePresenceStore(spans);
    const [tool] = createTool({ store: fakeStore(rows), evalStore: fakeEvalStore([]), presence });

    const res = await tool.handler({ period: 'today' });
    expect(res.success).toBe(true);
    const data = res.data as ActivityDigest;
    expect(data.away_min).toBe(15);
    expect(data.away_spans).toHaveLength(1);
    expect(data.summary).toContain('Отошёл ~15 мин (1 отлучка)');

    const midnight = new Date(2026, 5, 6, 0, 0, 0, 0).getTime();
    expect(presence.lastWindow).toEqual([midnight, now.getTime()]);
  });

  it('absent presence dep → digest reports no away time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 6, 14, 30, 0, 0));
    const [tool] = createTool({ store: fakeStore([]), evalStore: fakeEvalStore([]) });
    const res = await tool.handler({ period: 'today' });
    expect(res.success).toBe(true);
    const data = res.data as ActivityDigest;
    expect(data.away_min).toBe(0);
    expect(data.away_spans).toEqual([]);
  });

  it('empty day → success:true with an empty digest', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 6, 14, 30, 0, 0));
    const [tool] = createTool({ store: fakeStore([]), evalStore: fakeEvalStore([]) });

    const res = await tool.handler({});
    expect(res.success).toBe(true);
    const data = res.data as ActivityDigest;
    expect(data.total_active_min).toBe(0);
    expect(data.by_app).toEqual([]);
    expect(data.observer.episodes).toEqual([]);
    expect(data.observer.coverage_note).toBeTruthy();
    expect(data.summary).toContain('наблюдение пустое');
  });

  it('defaults to today when period param is omitted/invalid', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 6, 14, 30, 0, 0));
    const store = fakeStore([]);
    const [tool] = createTool({ store, evalStore: fakeEvalStore([]) });

    await tool.handler({ period: 'nonsense' });
    const midnight = new Date(2026, 5, 6, 0, 0, 0, 0).getTime();
    expect(store.lastSince).toBe(midnight);
  });
});
