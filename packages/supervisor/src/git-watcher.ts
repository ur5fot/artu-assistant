import { run } from './shell.js';

export interface GitWatcherParams {
  repoPath: string;
  branch: string;
  intervalMs: number;
  onNewCommit: (hash: string) => void;
}

export function startGitWatcher(params: GitWatcherParams): () => void {
  let storedHash: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let running = false;

  const currentBranch = async (): Promise<string | null> => {
    try {
      return await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], params.repoPath);
    } catch {
      return null;
    }
  };

  const initialize = async () => {
    try {
      await run('git', ['fetch', 'origin', params.branch, '--quiet'], params.repoPath);
      // Seed from local branch, not origin/branch: if local is behind origin
      // at startup (e.g. supervisor was stopped when an external push landed),
      // the first poll must detect the diff and pull — otherwise the worker
      // runs stale code until the next upstream commit.
      storedHash = await run('git', ['rev-parse', params.branch], params.repoPath);
    } catch (err) {
      console.error(
        '[git-watcher] Failed to read initial hash:',
        err instanceof Error ? err.message : err,
      );
    }
  };

  const poll = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await run('git', ['fetch', 'origin', params.branch, '--quiet'], params.repoPath);
      const newHash = await run(
        'git',
        ['rev-parse', `origin/${params.branch}`],
        params.repoPath,
      );

      if (!storedHash) {
        // initialize() failed earlier (e.g. transient fetch error). Re-seed
        // from the LOCAL branch so a "local behind origin" diff is still
        // detected on the next poll; fall back to origin only if local
        // rev-parse also fails.
        try {
          storedHash = await run('git', ['rev-parse', params.branch], params.repoPath);
        } catch {
          storedHash = newHash;
        }
        return;
      }
      if (newHash === storedHash) return;

      const head = await currentBranch();
      if (head !== params.branch) {
        console.error(
          `[git-watcher] New commit on ${params.branch} but HEAD is on ${head}; skipping pull, will retry`,
        );
        return;
      }

      await run('git', ['pull', 'origin', params.branch, '--ff-only'], params.repoPath);
      storedHash = newHash;
      if (stopped) return;
      params.onNewCommit(newHash);
    } catch (err) {
      console.error(
        '[git-watcher] Poll error:',
        err instanceof Error ? err.message : err,
      );
    } finally {
      running = false;
    }
  };

  // Seed baseline then start interval; stop() is safe during initialize().
  initialize()
    .then(() => {
      if (stopped) return;
      timer = setInterval(poll, params.intervalMs);
    })
    .catch((err) => {
      console.error(
        '[git-watcher] initialize failed:',
        err instanceof Error ? err.message : err,
      );
    });

  return () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
