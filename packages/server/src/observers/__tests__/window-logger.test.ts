import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb, closeDb } from '../../db.js';
import { createWindowHistoryStore } from '../window-history-store.js';
import { startWindowLogger } from '../window-logger.js';
import type { WindowSnapshot, WindowSnapshotProvider } from '../window-snapshot.js';

beforeEach(() => {
  vi.useFakeTimers();
  initDb(':memory:');
});
afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

function mockProvider(getActive: WindowSnapshotProvider['getActive']): WindowSnapshotProvider {
  return { getActive };
}

function rows() {
  return getDb()
    .prepare('SELECT app_name, window_title, sample_count FROM window_history ORDER BY id')
    .all() as Array<{ app_name: string; window_title: string; sample_count: number }>;
}

describe('startWindowLogger', () => {
  it('records one row after the first tick with a snapshot', async () => {
    const snap: WindowSnapshot = { app_name: 'Chrome', window_title: 'Gmail' };
    const provider = mockProvider(vi.fn(async () => snap));
    const store = createWindowHistoryStore({ db: getDb() });

    const stop = startWindowLogger({ store, provider, intervalMs: 30_000 });
    await vi.advanceTimersByTimeAsync(0);

    expect(rows()).toEqual([{ app_name: 'Chrome', window_title: 'Gmail', sample_count: 1 }]);
    stop();
  });

  it('coalesces two identical ticks into one row with sample_count=2', async () => {
    const snap: WindowSnapshot = { app_name: 'Chrome', window_title: 'Gmail' };
    const provider = mockProvider(vi.fn(async () => snap));
    const store = createWindowHistoryStore({ db: getDb() });

    const stop = startWindowLogger({ store, provider, intervalMs: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(rows()).toEqual([{ app_name: 'Chrome', window_title: 'Gmail', sample_count: 2 }]);
    stop();
  });

  it('inserts no row when the provider returns null', async () => {
    const provider = mockProvider(vi.fn(async () => null));
    const store = createWindowHistoryStore({ db: getDb() });

    const stop = startWindowLogger({ store, provider, intervalMs: 30_000 });
    await vi.advanceTimersByTimeAsync(0);

    expect(rows()).toEqual([]);
    stop();
  });

  it('calls onError when the provider throws, inserts no row, and keeps ticking', async () => {
    const err = new Error('boom');
    const getActive = vi
      .fn<WindowSnapshotProvider['getActive']>()
      .mockRejectedValueOnce(err)
      .mockResolvedValue({ app_name: 'iTerm', window_title: 'zsh' });
    const provider = mockProvider(getActive);
    const store = createWindowHistoryStore({ db: getDb() });
    const onError = vi.fn();

    const stop = startWindowLogger({ store, provider, intervalMs: 30_000, onError });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
    expect(rows()).toEqual([]);

    // next tick still fires and records the recovered snapshot
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rows()).toEqual([{ app_name: 'iTerm', window_title: 'zsh', sample_count: 1 }]);
    stop();
  });

  it('does not fire further ticks after stop is called', async () => {
    const getActive = vi
      .fn<WindowSnapshotProvider['getActive']>()
      .mockResolvedValue({ app_name: 'Chrome', window_title: 'Gmail' });
    const provider = mockProvider(getActive);
    const store = createWindowHistoryStore({ db: getDb() });

    const stop = startWindowLogger({ store, provider, intervalMs: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterFirst = getActive.mock.calls.length;

    stop();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(getActive.mock.calls.length).toBe(callsAfterFirst);
    expect(rows()).toEqual([{ app_name: 'Chrome', window_title: 'Gmail', sample_count: 1 }]);
  });
});
