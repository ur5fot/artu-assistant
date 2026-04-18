import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../db.js';
import { createCognitionStore } from '../store.js';
import { startHeartbeat, HEARTBEAT_TICK_MS } from '../heartbeat.js';
import type { Dispatcher } from '../dispatcher.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => vi.useRealTimers());

describe('Heartbeat', () => {
  it('fires runTick every tick interval and records ticks', async () => {
    vi.useFakeTimers();
    const store = createCognitionStore({ db: getDb() });
    const runTick = vi.fn().mockResolvedValue(undefined);
    const dispatcher: Dispatcher = { runTick };
    const hb = startHeartbeat({ dispatcher, store });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TICK_MS * 2);
    expect(runTick).toHaveBeenCalledTimes(2);
    expect(store.getLastTickAt()).not.toBeNull();
    hb.stop();
  });

  it('paused state skips runTick AND skips recordTick', async () => {
    vi.useFakeTimers();
    const store = createCognitionStore({ db: getDb() });
    store.pause(0);
    const runTick = vi.fn().mockResolvedValue(undefined);
    const dispatcher: Dispatcher = { runTick };
    const hb = startHeartbeat({ dispatcher, store });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TICK_MS * 2);
    expect(runTick).not.toHaveBeenCalled();
    expect(store.getLastTickAt()).toBeNull();
    hb.stop();
  });

  it('stop clears the timer', async () => {
    vi.useFakeTimers();
    const store = createCognitionStore({ db: getDb() });
    const runTick = vi.fn().mockResolvedValue(undefined);
    const hb = startHeartbeat({ dispatcher: { runTick }, store });
    hb.stop();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TICK_MS * 5);
    expect(runTick).not.toHaveBeenCalled();
  });

  it('re-entrancy guard: overlapping interval fires do not double-invoke runTick', async () => {
    vi.useFakeTimers();
    const store = createCognitionStore({ db: getDb() });
    let resolveFirst!: () => void;
    const runTick = vi.fn().mockImplementationOnce(
      () => new Promise<void>((r) => { resolveFirst = r; }),
    ).mockResolvedValue(undefined);
    const hb = startHeartbeat({ dispatcher: { runTick }, store });
    // Advance past multiple tick intervals while the first tick is still
    // awaiting — with the guard, re-entrant fires are skipped.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TICK_MS * 3);
    expect(runTick).toHaveBeenCalledTimes(1);
    // Let the first tick finish; subsequent interval fires now proceed.
    resolveFirst();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TICK_MS);
    expect(runTick).toHaveBeenCalledTimes(2);
    hb.stop();
  });
});
