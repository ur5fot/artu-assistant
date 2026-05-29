import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb, closeDb } from '../../db.js';
import { createWindowHistoryStore } from '../window-history-store.js';
import {
  createContextPingStore,
  detectContextSwitch,
} from '../context-switch-detector.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

beforeEach(() => initDb(':memory:'));
afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

// Records a session for `app` spanning [start, end] by recording two samples
// (the store coalesces same app+title into one row: started_at=start,
// last_seen_at=end).
function seedSession(
  store: ReturnType<typeof createWindowHistoryStore>,
  app: string,
  start: number,
  end: number,
) {
  store.recordSample({ app_name: app, window_title: `${app} window`, sampled_at: start });
  if (end !== start) {
    store.recordSample({ app_name: app, window_title: `${app} window`, sampled_at: end });
  }
}

const THRESHOLDS = {
  longSessionMin: 30,
  switchGapMin: 5,
  stableNewMin: 5,
  dedupeWindowH: 8,
};

describe('createContextPingStore', () => {
  it('records a ping and finds it within the since window', () => {
    const store = createContextPingStore({ db: getDb() });
    store.recordPing({
      away_app: 'Chrome',
      away_session_started_at: T0,
      away_session_ended_at: T0 + 30 * MIN,
      pinged_at: T0 + 31 * MIN,
    });

    const found = store.findRecentPing('Chrome', T0);
    expect(found).not.toBeNull();
    expect(found!.away_app).toBe('Chrome');
    expect(found!.pinged_at).toBe(T0 + 31 * MIN);
    expect(found!.away_session_started_at).toBe(T0);
    expect(found!.away_session_ended_at).toBe(T0 + 30 * MIN);
  });

  it('returns null when there is no ping for the app', () => {
    const store = createContextPingStore({ db: getDb() });
    expect(store.findRecentPing('Chrome', T0)).toBeNull();
  });

  it('returns null when the only ping is older than `since`', () => {
    const store = createContextPingStore({ db: getDb() });
    store.recordPing({
      away_app: 'Chrome',
      away_session_started_at: T0,
      away_session_ended_at: T0 + 30 * MIN,
      pinged_at: T0,
    });
    expect(store.findRecentPing('Chrome', T0 + 1)).toBeNull();
  });

  it('filters by away_app', () => {
    const store = createContextPingStore({ db: getDb() });
    store.recordPing({
      away_app: 'Chrome',
      away_session_started_at: T0,
      away_session_ended_at: T0 + 30 * MIN,
      pinged_at: T0 + 31 * MIN,
    });
    expect(store.findRecentPing('iTerm', T0)).toBeNull();
    expect(store.findRecentPing('Chrome', T0)).not.toBeNull();
  });

  it('returns the most recent ping when several exist', () => {
    const store = createContextPingStore({ db: getDb() });
    store.recordPing({
      away_app: 'Chrome',
      away_session_started_at: T0,
      away_session_ended_at: T0 + 10 * MIN,
      pinged_at: T0 + 11 * MIN,
    });
    store.recordPing({
      away_app: 'Chrome',
      away_session_started_at: T0 + 60 * MIN,
      away_session_ended_at: T0 + 90 * MIN,
      pinged_at: T0 + 91 * MIN,
    });
    const found = store.findRecentPing('Chrome', T0);
    expect(found!.pinged_at).toBe(T0 + 91 * MIN);
  });
});

describe('detectContextSwitch', () => {
  it('returns null on empty history', () => {
    const store = createWindowHistoryStore({ db: getDb() });
    const pingStore = createContextPingStore({ db: getDb() });
    expect(
      detectContextSwitch({ now: T0, store, pingStore, ...THRESHOLDS }),
    ).toBeNull();
  });

  it('returns null when the current session is younger than stableNewMin', () => {
    const store = createWindowHistoryStore({ db: getDb() });
    const pingStore = createContextPingStore({ db: getDb() });

    // Chrome long session, then iTerm current but only 2 min old.
    seedSession(store, 'Chrome', T0, T0 + 35 * MIN);
    const currentStart = T0 + 35 * MIN + 30_000;
    seedSession(store, 'iTerm', currentStart, currentStart);
    const now = currentStart + 2 * MIN;

    expect(
      detectContextSwitch({ now, store, pingStore, ...THRESHOLDS }),
    ).toBeNull();
  });

  it('fires when a long away session is followed by a stable return', () => {
    const store = createWindowHistoryStore({ db: getDb() });
    const pingStore = createContextPingStore({ db: getDb() });

    const chromeStart = T0;
    const chromeEnd = T0 + 35 * MIN;
    seedSession(store, 'Chrome', chromeStart, chromeEnd);

    const currentStart = chromeEnd + 30_000; // 30s gap < switchGapMin
    seedSession(store, 'iTerm', currentStart, currentStart);
    const now = currentStart + 6 * MIN; // stable for 6 min > stableNewMin

    const event = detectContextSwitch({ now, store, pingStore, ...THRESHOLDS });
    expect(event).toEqual({
      away_app: 'Chrome',
      away_session_started_at: chromeStart,
      away_session_ended_at: chromeEnd,
      current_app: 'iTerm',
    });
  });

  it('honors the intervening-long-session shape (iTerm 1h → Chrome → iTerm)', () => {
    // The away run is the contiguous foreign-app block immediately before
    // current; earlier same-as-current history stops the run.
    const store = createWindowHistoryStore({ db: getDb() });
    const pingStore = createContextPingStore({ db: getDb() });

    seedSession(store, 'iTerm', T0, T0 + 60 * MIN); // earlier long iTerm work
    const chromeStart = T0 + 60 * MIN + 30_000;
    const chromeEnd = chromeStart + 12 * MIN;
    seedSession(store, 'Chrome', chromeStart, chromeEnd);
    const currentStart = chromeEnd + 30_000;
    seedSession(store, 'iTerm', currentStart, currentStart);
    const now = currentStart + 6 * MIN;

    const event = detectContextSwitch({
      now,
      store,
      pingStore,
      ...THRESHOLDS,
      longSessionMin: 10, // Chrome diversion of 12 min qualifies
    });
    expect(event).not.toBeNull();
    expect(event!.away_app).toBe('Chrome');
    expect(event!.away_session_started_at).toBe(chromeStart);
    expect(event!.away_session_ended_at).toBe(chromeEnd);
    expect(event!.current_app).toBe('iTerm');
  });

  it('returns null when the away session is shorter than longSessionMin', () => {
    const store = createWindowHistoryStore({ db: getDb() });
    const pingStore = createContextPingStore({ db: getDb() });

    seedSession(store, 'Chrome', T0, T0 + 20 * MIN); // only 20 min < 30
    const currentStart = T0 + 20 * MIN + 30_000;
    seedSession(store, 'iTerm', currentStart, currentStart);
    const now = currentStart + 6 * MIN;

    expect(
      detectContextSwitch({ now, store, pingStore, ...THRESHOLDS }),
    ).toBeNull();
  });

  it('returns null when the gap before return exceeds switchGapMin (sleep scenario)', () => {
    const store = createWindowHistoryStore({ db: getDb() });
    const pingStore = createContextPingStore({ db: getDb() });

    const chromeEnd = T0 + 35 * MIN;
    seedSession(store, 'Chrome', T0, chromeEnd);
    const currentStart = chromeEnd + 2 * HOUR; // 2h gap >> switchGapMin
    seedSession(store, 'iTerm', currentStart, currentStart);
    const now = currentStart + 6 * MIN;

    expect(
      detectContextSwitch({ now, store, pingStore, ...THRESHOLDS }),
    ).toBeNull();
  });

  it('returns null when there is no foreign app before the current session', () => {
    const store = createWindowHistoryStore({ db: getDb() });
    const pingStore = createContextPingStore({ db: getDb() });

    // Only a single (current) iTerm session, stable.
    seedSession(store, 'iTerm', T0, T0 + 6 * MIN);
    const now = T0 + 6 * MIN;

    expect(
      detectContextSwitch({ now, store, pingStore, ...THRESHOLDS }),
    ).toBeNull();
  });

  it('returns null when a recent ping for the away app already exists', () => {
    const store = createWindowHistoryStore({ db: getDb() });
    const pingStore = createContextPingStore({ db: getDb() });

    const chromeEnd = T0 + 35 * MIN;
    seedSession(store, 'Chrome', T0, chromeEnd);
    const currentStart = chromeEnd + 30_000;
    seedSession(store, 'iTerm', currentStart, currentStart);
    const now = currentStart + 6 * MIN;

    pingStore.recordPing({
      away_app: 'Chrome',
      away_session_started_at: T0,
      away_session_ended_at: chromeEnd,
      pinged_at: now - 1 * MIN, // within the 8h dedupe window
    });

    expect(
      detectContextSwitch({ now, store, pingStore, ...THRESHOLDS }),
    ).toBeNull();
  });

  it('fires when the existing ping is older than the dedupe window', () => {
    const store = createWindowHistoryStore({ db: getDb() });
    const pingStore = createContextPingStore({ db: getDb() });

    const chromeEnd = T0 + 35 * MIN;
    seedSession(store, 'Chrome', T0, chromeEnd);
    const currentStart = chromeEnd + 30_000;
    seedSession(store, 'iTerm', currentStart, currentStart);
    const now = currentStart + 6 * MIN;

    pingStore.recordPing({
      away_app: 'Chrome',
      away_session_started_at: T0 - 10 * HOUR,
      away_session_ended_at: T0 - 9 * HOUR,
      pinged_at: now - 9 * HOUR, // older than 8h dedupe window
    });

    const event = detectContextSwitch({ now, store, pingStore, ...THRESHOLDS });
    expect(event).not.toBeNull();
    expect(event!.away_app).toBe('Chrome');
  });
});
