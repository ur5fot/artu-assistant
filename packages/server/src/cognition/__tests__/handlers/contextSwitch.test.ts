import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, closeDb, getDb } from '../../../db.js';
import { createWindowHistoryStore } from '../../../observers/window-history-store.js';
import { createContextPingStore } from '../../../observers/context-switch-detector.js';
import { createContextSwitchHandler } from '../../handlers/contextSwitch.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

const MIN = 60_000;

const THRESHOLDS = {
  longSessionMin: 30,
  switchGapMin: 5,
  stableNewMin: 5,
  dedupeWindowH: 8,
};

// Seeds: a 60-min Chrome away-session, then a stable iTerm return, so the
// detector fires for away_app=Chrome at `now`.
function seedSwitch(db: ReturnType<typeof getDb>, now: number) {
  const chromeStart = now - 70 * MIN;
  const chromeEnd = now - 10 * MIN;
  const itermStart = now - 8 * MIN; // 8 min ago → past stableNewMin (5)
  db.prepare(
    `INSERT INTO window_history (app_name, window_title, started_at, last_seen_at, sample_count)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('Chrome', 'Gmail', chromeStart, chromeEnd, 120);
  db.prepare(
    `INSERT INTO window_history (app_name, window_title, started_at, last_seen_at, sample_count)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('iTerm', 'zsh', itermStart, now, 16);
  return { chromeStart, chromeEnd, itermStart };
}

function mkCtx(firedAt: number) {
  return { db: getDb(), firedAt, signal: new AbortController().signal };
}

describe('createContextSwitchHandler.trigger', () => {
  it('returns false when there is no switch', async () => {
    const store = createWindowHistoryStore({ db: getDb() });
    const pingStore = createContextPingStore({ db: getDb() });
    const h = createContextSwitchHandler({ store, pingStore, ...THRESHOLDS });
    const now = 10_000_000;
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);
  });

  it('returns true when the detector finds a switch', async () => {
    const now = 100_000_000;
    seedSwitch(getDb(), now);
    const store = createWindowHistoryStore({ db: getDb() });
    const pingStore = createContextPingStore({ db: getDb() });
    const h = createContextSwitchHandler({ store, pingStore, ...THRESHOLDS });
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(true);
  });
});

describe('createContextSwitchHandler.run', () => {
  it('skips when the switch is gone by run time', async () => {
    const store = createWindowHistoryStore({ db: getDb() });
    const pingStore = createContextPingStore({ db: getDb() });
    const h = createContextSwitchHandler({ store, pingStore, ...THRESHOLDS });
    const res = await h.run(mkCtx(10_000_000));
    expect(res).toEqual({ skip: true, reason: 'no context switch' });
  });

  it('publishes an embed + content with the right shape', async () => {
    const now = 100_000_000;
    seedSwitch(getDb(), now);
    const store = createWindowHistoryStore({ db: getDb() });
    const pingStore = createContextPingStore({ db: getDb() });
    const h = createContextSwitchHandler({ store, pingStore, ...THRESHOLDS });

    const res = await h.run(mkCtx(now));
    if (!('publish' in res)) throw new Error('expected publish');
    expect(res.publish).toBe(true);

    expect(res.content).toBe("🔁 You're back at iTerm after ~60min on Chrome");
    expect(res.embed?.title).toBe('🔁 Restore context?');
    const wasOn = res.embed?.fields?.find((f) => f.name === 'Was on');
    expect(wasOn?.value).toBe('Chrome');
    const forField = res.embed?.fields?.find((f) => f.name === 'For');
    expect(forField?.value).toBe('~60min');
    const nowOn = res.embed?.fields?.find((f) => f.name === 'Now on');
    expect(nowOn?.value).toBe('iTerm');

    const btn = res.components?.[0]?.buttons?.[0];
    expect(btn?.label).toBe('Show titles');
    // customId encodes away_app + the two session timestamps.
    expect(btn?.customId.startsWith('window:show:Chrome:')).toBe(true);
    const parts = btn!.customId.split(':');
    expect(Number(parts[parts.length - 2])).toBe(now - 70 * MIN);
    expect(Number(parts[parts.length - 1])).toBe(now - 10 * MIN);
  });

  it('onPublished records a ping with the away-session shape', async () => {
    const now = 100_000_000;
    const seed = seedSwitch(getDb(), now);
    const store = createWindowHistoryStore({ db: getDb() });
    const pingStore = createContextPingStore({ db: getDb() });
    const recordPing = vi.spyOn(pingStore, 'recordPing');
    const h = createContextSwitchHandler({ store, pingStore, ...THRESHOLDS });

    vi.useFakeTimers();
    vi.setSystemTime(now);

    const res = await h.run(mkCtx(now));
    if (!('publish' in res)) throw new Error('expected publish');
    await res.onPublished?.();

    expect(recordPing).toHaveBeenCalledWith({
      away_app: 'Chrome',
      away_session_started_at: seed.chromeStart,
      away_session_ended_at: seed.chromeEnd,
      pinged_at: now,
    });
  });
});
