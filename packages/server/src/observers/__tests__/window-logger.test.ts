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

  it('treats a recordSample() throw as onError, not blindness', async () => {
    const snap: WindowSnapshot = { app_name: 'Chrome', window_title: 'Gmail' };
    const provider = mockProvider(vi.fn(async () => snap));
    const dbErr = new Error('database is locked');
    const store = createWindowHistoryStore({ db: getDb() });
    vi.spyOn(store, 'recordSample').mockImplementation(() => { throw dbErr; });
    const onError = vi.fn();
    const onBlind = vi.fn();

    const stop = startWindowLogger({ store, provider, intervalMs: 30_000, blindAlertAfter: 1, onError, onBlind });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    // Storage failures surface through onError every tick...
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledWith(dbErr);
    // ...but the provider is healthy, so the observer is never "blind".
    expect(onBlind).not.toHaveBeenCalled();
    stop();
  });

  it('fires onBlind once at the threshold on a null streak and does not spam', async () => {
    const provider = mockProvider(vi.fn(async () => null));
    const store = createWindowHistoryStore({ db: getDb() });
    const onBlind = vi.fn();

    const stop = startWindowLogger({ store, provider, intervalMs: 30_000, blindAlertAfter: 3, onBlind });
    await vi.advanceTimersByTimeAsync(0); // tick 1
    await vi.advanceTimersByTimeAsync(30_000); // tick 2
    await vi.advanceTimersByTimeAsync(30_000); // tick 3 → threshold

    expect(onBlind).toHaveBeenCalledTimes(1);
    expect(onBlind).toHaveBeenCalledWith({ consecutive: 3 });

    // two more blind ticks → still only one alert (no spam)
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onBlind).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([]);
    stop();
  });

  it('fires onBlind on the very first blind tick when blindAlertAfter is 1', async () => {
    const provider = mockProvider(vi.fn(async () => null));
    const store = createWindowHistoryStore({ db: getDb() });
    const onBlind = vi.fn();

    const stop = startWindowLogger({ store, provider, intervalMs: 30_000, blindAlertAfter: 1, onBlind });
    await vi.advanceTimersByTimeAsync(0); // tick 1 → threshold

    expect(onBlind).toHaveBeenCalledTimes(1);
    expect(onBlind).toHaveBeenCalledWith({ consecutive: 1 });
    stop();
  });

  it('never fires onBlind when blindAlertAfter is 0 (guard)', async () => {
    const provider = mockProvider(vi.fn(async () => null));
    const store = createWindowHistoryStore({ db: getDb() });
    const onBlind = vi.fn();

    const stop = startWindowLogger({ store, provider, intervalMs: 30_000, blindAlertAfter: 0, onBlind });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(onBlind).not.toHaveBeenCalled();
    stop();
  });

  it('keeps ticking when onBlind throws', async () => {
    const provider = mockProvider(vi.fn(async () => null));
    const store = createWindowHistoryStore({ db: getDb() });
    const onBlind = vi.fn(() => { throw new Error('callback boom'); });

    const stop = startWindowLogger({ store, provider, intervalMs: 30_000, blindAlertAfter: 1, onBlind });
    await vi.advanceTimersByTimeAsync(0); // tick 1 → onBlind throws
    await vi.advanceTimersByTimeAsync(30_000); // loop must survive and tick again

    expect(provider.getActive).toHaveBeenCalledTimes(2);
    stop();
  });

  it('counts a throw as blind: onError every tick, onBlind once at threshold', async () => {
    const provider = mockProvider(vi.fn(async () => { throw new Error('boom'); }));
    const store = createWindowHistoryStore({ db: getDb() });
    const onError = vi.fn();
    const onBlind = vi.fn();

    const stop = startWindowLogger({ store, provider, intervalMs: 30_000, blindAlertAfter: 3, onError, onBlind });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(onError).toHaveBeenCalledTimes(3);
    expect(onBlind).toHaveBeenCalledTimes(1);
    expect(onBlind).toHaveBeenCalledWith({ consecutive: 3 });
    stop();
  });

  it('counts a mixed null+throw streak as blind and fires once at threshold', async () => {
    const getActive = vi
      .fn<WindowSnapshotProvider['getActive']>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(null);
    const provider = mockProvider(getActive);
    const store = createWindowHistoryStore({ db: getDb() });
    const onBlind = vi.fn();

    const stop = startWindowLogger({ store, provider, intervalMs: 30_000, blindAlertAfter: 3, onBlind });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(onBlind).toHaveBeenCalledTimes(1);
    expect(onBlind).toHaveBeenCalledWith({ consecutive: 3 });
    stop();
  });

  it('resets the counter on a good sample and can re-arm for the next streak', async () => {
    const snap: WindowSnapshot = { app_name: 'Chrome', window_title: 'Gmail' };
    const getActive = vi
      .fn<WindowSnapshotProvider['getActive']>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(snap)
      .mockResolvedValue(null);
    const provider = mockProvider(getActive);
    const store = createWindowHistoryStore({ db: getDb() });
    const onBlind = vi.fn();

    const stop = startWindowLogger({ store, provider, intervalMs: 30_000, blindAlertAfter: 3, onBlind });
    await vi.advanceTimersByTimeAsync(0); // null (1)
    await vi.advanceTimersByTimeAsync(30_000); // null (2)
    await vi.advanceTimersByTimeAsync(30_000); // good → reset
    expect(onBlind).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000); // null (1)
    await vi.advanceTimersByTimeAsync(30_000); // null (2)
    await vi.advanceTimersByTimeAsync(30_000); // null (3) → threshold

    expect(onBlind).toHaveBeenCalledTimes(1);
    expect(onBlind).toHaveBeenCalledWith({ consecutive: 3 });
    expect(rows()).toEqual([{ app_name: 'Chrome', window_title: 'Gmail', sample_count: 1 }]);
    stop();
  });

  it('fires onRecover once after an alert, not on subsequent good samples', async () => {
    const snap: WindowSnapshot = { app_name: 'Chrome', window_title: 'Gmail' };
    const getActive = vi
      .fn<WindowSnapshotProvider['getActive']>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(snap);
    const provider = mockProvider(getActive);
    const store = createWindowHistoryStore({ db: getDb() });
    const onBlind = vi.fn();
    const onRecover = vi.fn();

    const stop = startWindowLogger({ store, provider, intervalMs: 30_000, blindAlertAfter: 3, onBlind, onRecover });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000); // threshold → onBlind
    await vi.advanceTimersByTimeAsync(30_000); // good → onRecover

    expect(onBlind).toHaveBeenCalledTimes(1);
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(onRecover).toHaveBeenCalledWith({ blindFor: 3 });

    await vi.advanceTimersByTimeAsync(30_000); // good again → no repeat
    expect(onRecover).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stays inert without blind params (backward-compat) on a null streak', async () => {
    const provider = mockProvider(vi.fn(async () => null));
    const store = createWindowHistoryStore({ db: getDb() });

    const stop = startWindowLogger({ store, provider, intervalMs: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(rows()).toEqual([]);
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
