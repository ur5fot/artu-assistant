import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, closeDb, getDb } from '../../../db.js';
import { buttonsOf } from '../../types.js';
import { createWindowHistoryStore } from '../../../observers/window-history-store.js';
import { createDistractionEvalStore } from '../../../observers/distraction-eval-store.js';
import { createDistractionHandler, type DistractionJudge } from '../../handlers/distractionPullback.js';
import type { JudgeResult } from '../../handlers/distractionPullback.judge.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

const MIN = 60_000;
const T0 = 1_700_000_000_000;

const THRESHOLDS = {
  dwellMin: 25,
  workLookbackMin: 120,
  judgeLookbackMin: 60,
  dedupeH: 3,
  reevalMin: 30,
  confidencePct: 70,
  dailyCap: 40,
};

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

// "Worked in iTerm then drifted into Chrome and got stuck" — the standard shape
// that makes the filter yield a Chrome candidate at `now`.
function seedDriftIntoChrome(store: ReturnType<typeof createWindowHistoryStore>) {
  seedSession(store, 'iTerm', T0, T0 + 40 * MIN);
  const chromeStart = T0 + 40 * MIN + 30_000;
  seedSession(store, 'Chrome', chromeStart, chromeStart);
  const now = chromeStart + 30 * MIN; // 30 min into Chrome > dwellMin
  return { chromeStart, now };
}

function mkHandler(judge: DistractionJudge) {
  const store = createWindowHistoryStore({ db: getDb() });
  const evalStore = createDistractionEvalStore({ db: getDb() });
  const handler = createDistractionHandler({
    store,
    evalStore,
    anthropic: {} as never, // unused — judge is injected
    model: 'test-model',
    judge,
    ...THRESHOLDS,
  });
  return { store, evalStore, handler };
}

function mkCtx(firedAt: number) {
  return { db: getDb(), firedAt, signal: new AbortController().signal };
}

const VERDICT_DISTRACTED: JudgeResult = {
  verdict: 'distracted',
  confidence: 90,
  reason: 'дрейф в YouTube',
  work_summary: 'писал сервер',
};

describe('createDistractionHandler.trigger', () => {
  it('returns false on empty history', async () => {
    const judge = vi.fn<DistractionJudge>();
    const { handler } = mkHandler(judge);
    const fire = await handler.trigger(
      { now: T0, lastFiredAt: null, lastResult: null },
      { db: getDb() },
    );
    expect(fire).toBe(false);
    expect(judge).not.toHaveBeenCalled();
  });

  it('returns true when the filter yields a candidate', async () => {
    const judge = vi.fn<DistractionJudge>();
    const { store, handler } = mkHandler(judge);
    const { now } = seedDriftIntoChrome(store);
    const fire = await handler.trigger(
      { now, lastFiredAt: null, lastResult: null },
      { db: getDb() },
    );
    expect(fire).toBe(true);
  });

  it('does not fire on a stale current session when freshnessMs is set', async () => {
    const judge = vi.fn<DistractionJudge>();
    const store = createWindowHistoryStore({ db: getDb() });
    const evalStore = createDistractionEvalStore({ db: getDb() });
    const handler = createDistractionHandler({
      store,
      evalStore,
      anthropic: {} as never,
      model: 'test-model',
      judge,
      freshnessMs: 90_000, // 90s
      ...THRESHOLDS,
    });
    // Chrome last observed 10 min before `now` — logger went blind/stopped.
    seedSession(store, 'iTerm', T0, T0 + 40 * MIN);
    const chromeStart = T0 + 40 * MIN + 30_000;
    seedSession(store, 'Chrome', chromeStart, chromeStart + 20 * MIN);
    const now = chromeStart + 30 * MIN;

    const fire = await handler.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('createDistractionHandler.run', () => {
  it('skips without calling the judge when there is no candidate', async () => {
    const judge = vi.fn<DistractionJudge>();
    const { handler } = mkHandler(judge);
    const res = await handler.run(mkCtx(T0));
    expect(res).toEqual({ skip: true, reason: 'no distraction candidate' });
    expect(judge).not.toHaveBeenCalled();
  });

  it('publishes a pullback on distracted + high confidence and records a pinged eval', async () => {
    const judge = vi.fn<DistractionJudge>(async () => VERDICT_DISTRACTED);
    const { store, evalStore, handler } = mkHandler(judge);
    const { chromeStart, now } = seedDriftIntoChrome(store);

    const res = await handler.run(mkCtx(now));
    if (!('publish' in res)) throw new Error('expected publish');
    expect(res.publish).toBe(true);
    expect(res.content).toBe('🧲 Ты ~30 мин в Chrome: Chrome window. До этого: писал сервер. Вернёшься?');

    const buttons = buttonsOf(res.components?.[0]);
    expect(buttons.map((b) => b.customId)).toEqual([
      `distract:back:${chromeStart}`,
      `distract:work:Chrome:${chromeStart}`,
      `distract:done:Chrome:${chromeStart}`,
      `distract:snooze:Chrome:${chromeStart}`,
    ]);

    // The judge ran with the timeline + current dwell.
    expect(judge).toHaveBeenCalledOnce();
    const [timeline, current] = judge.mock.calls[0];
    expect(current).toEqual({ app: 'Chrome', title: 'Chrome window', dwellMin: 30 });
    expect(timeline.length).toBeGreaterThan(0);

    // Nothing pinged until the publish channel confirms.
    expect(evalStore.findRecentPing('Chrome', now - 1)).toBeNull();
    await res.onPublished?.();
    const ping = evalStore.findRecentPing('Chrome', now - 1);
    expect(ping?.pinged).toBe(1);
    expect(ping?.verdict).toBe('distracted');
    expect(ping?.dwell_started_at).toBe(chromeStart);
  });

  it('skips on distracted but low confidence, recording the eval so the filter quiets', async () => {
    const judge = vi.fn<DistractionJudge>(async () => ({
      ...VERDICT_DISTRACTED,
      confidence: 50, // below confidencePct (70)
    }));
    const { store, evalStore, handler } = mkHandler(judge);
    const { chromeStart, now } = seedDriftIntoChrome(store);

    const res = await handler.run(mkCtx(now));
    expect('skip' in res && res.skip).toBe(true);

    const latest = evalStore.findLatestEvalForDwell('Chrome', chromeStart);
    expect(latest?.verdict).toBe('distracted');
    expect(latest?.confidence).toBe(50);
    expect(latest?.pinged).toBe(0);
  });

  it('skips on a working/break verdict, recording the eval', async () => {
    const judge = vi.fn<DistractionJudge>(async () => ({
      verdict: 'working',
      confidence: 95,
      reason: 'это работа',
      work_summary: '',
    }));
    const { store, evalStore, handler } = mkHandler(judge);
    const { chromeStart, now } = seedDriftIntoChrome(store);

    const res = await handler.run(mkCtx(now));
    expect('skip' in res && res.skip).toBe(true);

    const latest = evalStore.findLatestEvalForDwell('Chrome', chromeStart);
    expect(latest?.verdict).toBe('working');
    expect(latest?.pinged).toBe(0);
  });

  it('skips on an unknown verdict, recording the eval and never publishing', async () => {
    // High confidence on purpose: `unknown` must never ping regardless of
    // confidence (the gate is verdict==='distracted' && conf>=cutoff).
    const judge = vi.fn<DistractionJudge>(async () => ({
      verdict: 'unknown',
      confidence: 95,
      reason: 'заголовки пустые',
      work_summary: '',
    }));
    const { store, evalStore, handler } = mkHandler(judge);
    const { chromeStart, now } = seedDriftIntoChrome(store);

    const res = await handler.run(mkCtx(now));
    expect('skip' in res && res.skip).toBe(true);
    if (!('skip' in res)) throw new Error('expected skip');
    expect(res.reason).toContain('unknown');

    const latest = evalStore.findLatestEvalForDwell('Chrome', chromeStart);
    expect(latest?.verdict).toBe('unknown');
    expect(latest?.pinged).toBe(0);
    expect(evalStore.findRecentPing('Chrome', now - 1)).toBeNull();
  });

  it('never publishes when the judge throws — records verdict=error and skips', async () => {
    const judge = vi.fn<DistractionJudge>(async () => {
      throw new Error('boom');
    });
    const { store, evalStore, handler } = mkHandler(judge);
    const { chromeStart, now } = seedDriftIntoChrome(store);

    const res = await handler.run(mkCtx(now));
    expect('skip' in res && res.skip).toBe(true);
    if (!('skip' in res)) throw new Error('expected skip');
    expect(res.reason).toContain('boom');

    const latest = evalStore.findLatestEvalForDwell('Chrome', chromeStart);
    expect(latest?.verdict).toBe('error');
    expect(latest?.pinged).toBe(0);
  });
});
