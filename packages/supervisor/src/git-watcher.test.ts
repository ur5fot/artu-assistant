import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRun = vi.fn();
vi.mock('./shell.js', () => ({
  run: (...args: any[]) => mockRun(...args),
  tryRun: vi.fn(),
}));

import { startGitWatcher } from './git-watcher.js';

// Route mockRun calls by subcommand so tests don't depend on call order.
function routeMock(map: {
  fetch?: () => Promise<string>;
  revParseRemote?: () => Promise<string>;
  headBranch?: () => Promise<string>;
  pull?: () => Promise<string>;
}) {
  mockRun.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[0] === 'fetch') return (await map.fetch?.()) ?? '';
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref')
      return (await map.headBranch?.()) ?? 'master';
    if (args[0] === 'rev-parse') return (await map.revParseRemote?.()) ?? '';
    if (args[0] === 'pull') return (await map.pull?.()) ?? '';
    return '';
  });
}

describe('startGitWatcher', () => {
  beforeEach(() => {
    mockRun.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('seeds initial hash via fetch+rev-parse before starting interval', async () => {
    routeMock({ revParseRemote: async () => 'initial-hash' });
    const onNewCommit = vi.fn();

    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockRun).toHaveBeenCalledWith('git', ['fetch', 'origin', 'master', '--quiet'], '/repo');
    expect(mockRun).toHaveBeenCalledWith('git', ['rev-parse', 'master'], '/repo');
    expect(onNewCommit).not.toHaveBeenCalled();
    stop();
  });

  it('detects and pulls when local branch is already behind origin at startup', async () => {
    // Regression: previously seeded storedHash from origin/branch, so if
    // local was behind origin at startup the first poll would see no diff
    // and skip the pull forever.
    mockRun.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'master';
      if (args[0] === 'rev-parse' && args[1] === 'master') return 'local-old';
      if (args[0] === 'rev-parse' && args[1] === 'origin/master') return 'remote-new';
      if (args[0] === 'pull') return '';
      return '';
    });

    const onNewCommit = vi.fn();
    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockRun).toHaveBeenCalledWith(
      'git',
      ['pull', 'origin', 'master', '--ff-only'],
      '/repo',
    );
    expect(onNewCommit).toHaveBeenCalledWith('remote-new');
    stop();
  });

  it('fires onNewCommit and pulls when remote hash changes and HEAD is on branch', async () => {
    let current = 'hash-a';
    routeMock({
      revParseRemote: async () => current,
      headBranch: async () => 'master',
    });

    const onNewCommit = vi.fn();
    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    current = 'hash-b';
    await vi.advanceTimersByTimeAsync(1000);

    expect(onNewCommit).toHaveBeenCalledWith('hash-b');
    expect(mockRun).toHaveBeenCalledWith(
      'git',
      ['pull', 'origin', 'master', '--ff-only'],
      '/repo',
    );
    stop();
  });

  it('does not fire when hash is unchanged', async () => {
    routeMock({ revParseRemote: async () => 'hash-a', headBranch: async () => 'master' });
    const onNewCommit = vi.fn();

    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    expect(onNewCommit).not.toHaveBeenCalled();
    stop();
  });

  it('skips pull and does not fire onNewCommit when HEAD is on another branch', async () => {
    let current = 'hash-a';
    routeMock({
      revParseRemote: async () => current,
      headBranch: async () => 'feature-x',
    });

    const onNewCommit = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    current = 'hash-b';
    await vi.advanceTimersByTimeAsync(1000);

    expect(onNewCommit).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalledWith(
      'git',
      ['pull', 'origin', 'master', '--ff-only'],
      '/repo',
    );
    expect(errorSpy).toHaveBeenCalled();
    stop();
    errorSpy.mockRestore();
  });

  it('continues polling after an error and detects later changes', async () => {
    let call = 0;
    let current = 'hash-a';
    mockRun.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'fetch') {
        call++;
        if (call === 2) throw new Error('network blip');
        return '';
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'master';
      if (args[0] === 'rev-parse') return current;
      return '';
    });

    const onNewCommit = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000); // error tick
    current = 'hash-b';
    await vi.advanceTimersByTimeAsync(1000); // recovery tick

    expect(errorSpy).toHaveBeenCalled();
    expect(onNewCommit).toHaveBeenCalledWith('hash-b');
    stop();
    errorSpy.mockRestore();
  });

  it('cleanup function stops polling', async () => {
    routeMock({ revParseRemote: async () => 'hash-a' });
    const onNewCommit = vi.fn();

    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    stop();
    mockRun.mockClear();
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockRun).not.toHaveBeenCalled();
  });
});
