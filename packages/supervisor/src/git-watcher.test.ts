import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRun = vi.fn();
vi.mock('./shell.js', () => ({
  run: (...args: any[]) => mockRun(...args),
  tryRun: vi.fn(),
}));

import { startGitWatcher } from './git-watcher.js';

describe('startGitWatcher', () => {
  beforeEach(() => {
    mockRun.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads initial hash on start', async () => {
    mockRun.mockResolvedValueOnce('initial-hash');
    const onNewCommit = vi.fn();

    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(mockRun).toHaveBeenCalledWith('git', ['rev-parse', 'origin/master'], '/repo');
    expect(onNewCommit).not.toHaveBeenCalled();
    stop();
  });

  it('fires onNewCommit when hash changes', async () => {
    mockRun
      .mockResolvedValueOnce('hash-a') // initial rev-parse
      .mockResolvedValueOnce('')       // fetch
      .mockResolvedValueOnce('hash-b') // rev-parse after fetch
      .mockResolvedValueOnce('');      // pull

    const onNewCommit = vi.fn();

    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(1000);

    expect(onNewCommit).toHaveBeenCalledWith('hash-b');
    stop();
  });

  it('does not fire onNewCommit when hash is unchanged', async () => {
    mockRun
      .mockResolvedValueOnce('hash-a')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('hash-a');

    const onNewCommit = vi.fn();

    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(1000);

    expect(onNewCommit).not.toHaveBeenCalled();
    stop();
  });

  it('continues polling after an error', async () => {
    mockRun
      .mockResolvedValueOnce('hash-a')
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('hash-a');

    const onNewCommit = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(errorSpy).toHaveBeenCalled();
    stop();
    errorSpy.mockRestore();
  });

  it('cleanup function stops polling', async () => {
    mockRun.mockResolvedValue('hash-a');
    const onNewCommit = vi.fn();

    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.runOnlyPendingTimersAsync();
    stop();
    mockRun.mockClear();
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockRun).not.toHaveBeenCalled();
  });
});
