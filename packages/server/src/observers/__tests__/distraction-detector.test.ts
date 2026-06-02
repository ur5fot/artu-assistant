import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb, closeDb } from '../../db.js';
import { createWindowHistoryStore } from '../window-history-store.js';
import { createDistractionEvalStore } from '../distraction-eval-store.js';
import { shouldEvaluateDistraction } from '../distraction-detector.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

beforeEach(() => initDb(':memory:'));
afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

// Seeds an app session [start, end] under a single title (the store coalesces
// same app+title into one row: started_at=start, last_seen_at=end).
function seedSession(
  store: ReturnType<typeof createWindowHistoryStore>,
  app: string,
  start: number,
  end: number,
  title = `${app} window`,
) {
  store.recordSample({ app_name: app, window_title: title, sampled_at: start });
  if (end !== start) {
    store.recordSample({ app_name: app, window_title: title, sampled_at: end });
  }
}

const THRESHOLDS = {
  dwellMin: 25,
  workLookbackMin: 120,
  dedupeH: 3,
  reevalMin: 30,
  dailyCap: 40,
};

// Standard "worked then drifted into Chrome and got stuck" shape: iTerm work,
// then a long Chrome run that is current. now sits dwellMin+ into Chrome.
function seedDriftIntoChrome(
  store: ReturnType<typeof createWindowHistoryStore>,
  chromeTitle = 'Chrome window',
) {
  seedSession(store, 'iTerm', T0, T0 + 40 * MIN); // prior work, different app
  const chromeStart = T0 + 40 * MIN + 30_000;
  seedSession(store, 'Chrome', chromeStart, chromeStart, chromeTitle);
  const now = chromeStart + 30 * MIN; // 30 min into Chrome > dwellMin
  return { chromeStart, now };
}

describe('shouldEvaluateDistraction', () => {
  function stores() {
    return {
      store: createWindowHistoryStore({ db: getDb() }),
      evalStore: createDistractionEvalStore({ db: getDb() }),
    };
  }

  it('returns null on empty history', () => {
    const { store, evalStore } = stores();
    expect(
      shouldEvaluateDistraction({ now: T0, store, evalStore, ...THRESHOLDS }),
    ).toBeNull();
  });

  it('returns a candidate when stuck in an app after working elsewhere (happy path)', () => {
    const { store, evalStore } = stores();
    const { chromeStart, now } = seedDriftIntoChrome(store);

    const candidate = shouldEvaluateDistraction({ now, store, evalStore, ...THRESHOLDS });
    expect(candidate).toEqual({
      app: 'Chrome',
      title: 'Chrome window',
      runStart: chromeStart,
      dwellMs: now - chromeStart,
    });
  });

  it('returns null when the dwell is not long enough', () => {
    const { store, evalStore } = stores();
    seedSession(store, 'iTerm', T0, T0 + 40 * MIN);
    const chromeStart = T0 + 40 * MIN + 30_000;
    seedSession(store, 'Chrome', chromeStart, chromeStart);
    const now = chromeStart + 10 * MIN; // only 10 min < dwellMin

    expect(
      shouldEvaluateDistraction({ now, store, evalStore, ...THRESHOLDS }),
    ).toBeNull();
  });

  it('returns null when no prior session of a different app exists', () => {
    const { store, evalStore } = stores();
    // Only Chrome, from the start of the lookback — no context to drift from.
    seedSession(store, 'Chrome', T0, T0 + 30 * MIN);
    const now = T0 + 30 * MIN;

    expect(
      shouldEvaluateDistraction({ now, store, evalStore, ...THRESHOLDS }),
    ).toBeNull();
  });

  it('returns null when the only prior app is an idle/lock screen', () => {
    const { store, evalStore } = stores();
    seedSession(store, 'loginwindow', T0, T0 + 40 * MIN); // idle, not real work
    const chromeStart = T0 + 40 * MIN + 30_000;
    seedSession(store, 'Chrome', chromeStart, chromeStart);
    const now = chromeStart + 30 * MIN;

    expect(
      shouldEvaluateDistraction({ now, store, evalStore, ...THRESHOLDS }),
    ).toBeNull();
  });

  it('returns null when the current app is an idle/lock screen', () => {
    const { store, evalStore } = stores();
    seedSession(store, 'iTerm', T0, T0 + 40 * MIN);
    const lockStart = T0 + 40 * MIN + 30_000;
    seedSession(store, 'ScreenSaverEngine', lockStart, lockStart);
    const now = lockStart + 30 * MIN;

    expect(
      shouldEvaluateDistraction({ now, store, evalStore, ...THRESHOLDS }),
    ).toBeNull();
  });

  it('returns null while a snooze is active', () => {
    const { store, evalStore } = stores();
    const { chromeStart, now } = seedDriftIntoChrome(store);
    // Record a snooze in the future via a prior eval row + feedback.
    evalStore.recordEval({
      app_name: 'iTerm',
      dwell_started_at: T0,
      evaluated_at: T0 + MIN,
      eval_dwell_ms: MIN,
      verdict: 'working',
    });
    evalStore.recordFeedback('iTerm', T0, 'snooze', now + 30 * MIN);
    void chromeStart;

    expect(
      shouldEvaluateDistraction({ now, store, evalStore, ...THRESHOLDS }),
    ).toBeNull();
  });

  it('returns null when a recent ping for this app already exists (dedup)', () => {
    const { store, evalStore } = stores();
    const { now } = seedDriftIntoChrome(store);
    // A pinged eval for Chrome on an earlier (different) dwell, within dedupeH.
    evalStore.recordEval({
      app_name: 'Chrome',
      dwell_started_at: T0 - 10 * MIN,
      evaluated_at: now - 1 * HOUR, // within the 3h dedupe window
      eval_dwell_ms: 25 * MIN,
      verdict: 'distracted',
      confidence: 90,
      pinged: true,
    });

    expect(
      shouldEvaluateDistraction({ now, store, evalStore, ...THRESHOLDS }),
    ).toBeNull();
  });

  it('returns null when this dwell was already judged distracted', () => {
    const { store, evalStore } = stores();
    const { chromeStart, now } = seedDriftIntoChrome(store);
    evalStore.recordEval({
      app_name: 'Chrome',
      dwell_started_at: chromeStart,
      window_title: 'Chrome window',
      evaluated_at: now - 5 * MIN,
      eval_dwell_ms: 25 * MIN,
      verdict: 'distracted',
      confidence: 50, // low confidence, not pinged, but still distracted
      pinged: false,
    });

    expect(
      shouldEvaluateDistraction({ now, store, evalStore, ...THRESHOLDS }),
    ).toBeNull();
  });

  it('returns null when a non-distracted dwell has not grown enough and title unchanged', () => {
    const { store, evalStore } = stores();
    const { chromeStart, now } = seedDriftIntoChrome(store);
    evalStore.recordEval({
      app_name: 'Chrome',
      dwell_started_at: chromeStart,
      window_title: 'Chrome window',
      evaluated_at: now - 2 * MIN,
      eval_dwell_ms: now - chromeStart - 2 * MIN, // grew only ~2 min < reevalMin
      verdict: 'working',
    });

    expect(
      shouldEvaluateDistraction({ now, store, evalStore, ...THRESHOLDS }),
    ).toBeNull();
  });

  it('re-evaluates a non-distracted dwell once it has grown by reevalMin', () => {
    const { store, evalStore } = stores();
    const { chromeStart, now } = seedDriftIntoChrome(store);
    evalStore.recordEval({
      app_name: 'Chrome',
      dwell_started_at: chromeStart,
      window_title: 'Chrome window',
      evaluated_at: now - 31 * MIN,
      eval_dwell_ms: now - chromeStart - 31 * MIN, // grew 31 min > reevalMin (30)
      verdict: 'break',
    });

    const candidate = shouldEvaluateDistraction({ now, store, evalStore, ...THRESHOLDS });
    expect(candidate).not.toBeNull();
    expect(candidate!.runStart).toBe(chromeStart);
  });

  it('re-evaluates immediately on a title flip inside the same app-run (localhost -> YouTube)', () => {
    const { store, evalStore } = stores();
    seedSession(store, 'iTerm', T0, T0 + 40 * MIN);
    const chromeStart = T0 + 40 * MIN + 30_000;
    // Chrome run: localhost first, then flips to YouTube (same app, new title row).
    seedSession(store, 'Chrome', chromeStart, chromeStart + 20 * MIN, 'localhost:3000');
    const flipAt = chromeStart + 20 * MIN + 30_000;
    seedSession(store, 'Chrome', flipAt, flipAt, 'YouTube');
    const now = flipAt + 6 * MIN;

    // Prior eval said "working" on the localhost title; dwell barely grew but
    // the title changed, so we must re-eval.
    evalStore.recordEval({
      app_name: 'Chrome',
      dwell_started_at: chromeStart,
      window_title: 'localhost:3000',
      evaluated_at: now - 2 * MIN,
      eval_dwell_ms: now - chromeStart - 2 * MIN,
      verdict: 'working',
    });

    const candidate = shouldEvaluateDistraction({ now, store, evalStore, ...THRESHOLDS });
    expect(candidate).not.toBeNull();
    expect(candidate!.app).toBe('Chrome');
    expect(candidate!.title).toBe('YouTube');
    expect(candidate!.runStart).toBe(chromeStart);
  });

  it('coalesces a string of titles into one app-run dwell (YouTube videos)', () => {
    const { store, evalStore } = stores();
    seedSession(store, 'iTerm', T0, T0 + 40 * MIN);
    // Three back-to-back YouTube videos (distinct titles) = one Chrome run.
    const v1 = T0 + 40 * MIN + 30_000;
    seedSession(store, 'Chrome', v1, v1 + 10 * MIN, 'Video 1 - YouTube');
    const v2 = v1 + 10 * MIN + 30_000;
    seedSession(store, 'Chrome', v2, v2 + 10 * MIN, 'Video 2 - YouTube');
    const v3 = v2 + 10 * MIN + 30_000;
    seedSession(store, 'Chrome', v3, v3 + 10 * MIN, 'Video 3 - YouTube');
    const now = v3 + 10 * MIN;

    const candidate = shouldEvaluateDistraction({ now, store, evalStore, ...THRESHOLDS });
    expect(candidate).not.toBeNull();
    // runStart is the first video, not the latest — dwell spans the whole run.
    expect(candidate!.runStart).toBe(v1);
    expect(candidate!.dwellMs).toBe(now - v1);
    expect(candidate!.title).toBe('Video 3 - YouTube');
  });

  it('returns null when the daily LLM cap is reached', () => {
    const { store, evalStore } = stores();
    const { now } = seedDriftIntoChrome(store);
    // Fill the cap with evals dated at `now` (same local day as `now`).
    for (let i = 0; i < THRESHOLDS.dailyCap; i++) {
      evalStore.recordEval({
        app_name: 'Other',
        dwell_started_at: now - i,
        evaluated_at: now,
        eval_dwell_ms: 25 * MIN,
        verdict: 'working',
      });
    }

    expect(
      shouldEvaluateDistraction({ now, store, evalStore, ...THRESHOLDS }),
    ).toBeNull();
  });
});
