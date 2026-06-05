import { describe, it, expect, vi } from 'vitest';
import { computeBackoff, startReconnectLoop, guardOnce } from './reconnect-loop.js';

/** Deterministic "full jitter" — no randomness in tests. */
const noJitter = () => 1;

/**
 * A sleep the test drives by hand: each `await sleep()` parks until `tick()` is
 * called. This bounds the retry loop to exactly one attempt per tick — without it
 * an immediate-resolving sleep spins millions of times and OOMs the vi.fn history.
 */
function manualSleeper() {
  let pending: Array<() => void> = [];
  return {
    sleep: () => new Promise<void>((resolve) => pending.push(resolve)),
    async tick() {
      const waiters = pending;
      pending = [];
      waiters.forEach((r) => r());
      // Let the loop run the next connect()/await before we inspect anything.
      await new Promise((r) => setTimeout(r, 0));
    },
    pendingCount: () => pending.length,
  };
}

/** Flush pending microtasks/timers so the detached loop advances one step. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('computeBackoff', () => {
  it('grows exponentially from the base', () => {
    expect(computeBackoff(0, 5000, 300_000, noJitter)).toBe(5000);
    expect(computeBackoff(1, 5000, 300_000, noJitter)).toBe(10_000);
    expect(computeBackoff(2, 5000, 300_000, noJitter)).toBe(20_000);
    expect(computeBackoff(3, 5000, 300_000, noJitter)).toBe(40_000);
  });

  it('caps at capMs and never exceeds it', () => {
    expect(computeBackoff(20, 5000, 300_000, noJitter)).toBe(300_000);
    expect(computeBackoff(50, 5000, 300_000, noJitter)).toBe(300_000);
  });

  it('applies full jitter within [0, capped]', () => {
    expect(computeBackoff(2, 5000, 300_000, () => 0)).toBe(0);
    expect(computeBackoff(2, 5000, 300_000, () => 0.5)).toBe(10_000);
    expect(computeBackoff(2, 5000, 300_000, () => 1)).toBe(20_000);
  });
});

describe('startReconnectLoop', () => {
  it('retries until connect succeeds, then runs onConnect once', async () => {
    let calls = 0;
    const connect = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('handshake timeout'), { code: 'ETIMEDOUT' });
      return 'bot';
    });
    const onConnect = vi.fn();
    const clock = manualSleeper();

    startReconnectLoop({
      connect, onConnect, baseMs: 5000, capMs: 300_000, sleep: clock.sleep, jitter: noJitter,
    });

    await flush();                       // first attempt → fails → parks in sleep
    expect(connect).toHaveBeenCalledTimes(1);
    await clock.tick();                  // retry → fails → parks again
    expect(connect).toHaveBeenCalledTimes(2);
    await clock.tick();                  // retry → succeeds → onConnect
    expect(connect).toHaveBeenCalledTimes(3);
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect).toHaveBeenCalledWith('bot');
  });

  it('returns synchronously without blocking (degraded bootstrap continues)', () => {
    const connect = vi.fn(() => new Promise<string>(() => {})); // never resolves
    const stop = startReconnectLoop({
      connect, onConnect: vi.fn(), baseMs: 5000, capMs: 300_000, sleep: manualSleeper().sleep,
    });
    expect(typeof stop).toBe('function'); // we got control back immediately
  });

  it('stops retrying after stop() is called', async () => {
    const connect = vi.fn(async () => { throw new Error('still down'); });
    const clock = manualSleeper();
    const stop = startReconnectLoop({
      connect, onConnect: vi.fn(), baseMs: 5000, capMs: 300_000, sleep: clock.sleep, jitter: noJitter,
    });

    await flush();                       // attempt 1 fails, parked
    expect(connect).toHaveBeenCalledTimes(1);
    stop();
    await clock.tick();                  // released, but stopped → no more attempts
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('does not register if shut down mid-connect', async () => {
    let resolveConnect: (v: string) => void = () => {};
    const connect = vi.fn(() => new Promise<string>((res) => { resolveConnect = res; }));
    const onConnect = vi.fn();
    const stop = startReconnectLoop({
      connect, onConnect, baseMs: 5000, capMs: 300_000, sleep: manualSleeper().sleep,
    });
    stop();
    resolveConnect('bot');
    await flush();
    expect(onConnect).not.toHaveBeenCalled();
  });
});

describe('guardOnce', () => {
  it('runs the wrapped fn at most once across many calls', async () => {
    const fn = vi.fn();
    const guarded = guardOnce(fn);
    await guarded();
    await guarded();
    await guarded();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('forwards args on the first call', async () => {
    const fn = vi.fn();
    const guarded = guardOnce(fn);
    await guarded('a', 1);
    await guarded('b', 2);
    expect(fn).toHaveBeenCalledWith('a', 1);
  });
});
