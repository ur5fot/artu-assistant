import { run } from './shell.js';

export interface GitWatcherParams {
  repoPath: string;
  branch: string;
  intervalMs: number;
  onNewCommit: (hash: string) => void;
}

export function startGitWatcher(params: GitWatcherParams): () => void {
  let storedHash: string | null = null;
  let initialized = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const poll = async () => {
    if (stopped) return;
    if (!initialized) {
      try {
        storedHash = await run('git', ['rev-parse', `origin/${params.branch}`], params.repoPath);
      } catch (err) {
        console.error('[git-watcher] Failed to read initial hash:', err instanceof Error ? err.message : err);
      }
      initialized = true;
      return;
    }
    try {
      await run('git', ['fetch', 'origin', params.branch, '--quiet'], params.repoPath);
      const newHash = await run('git', ['rev-parse', `origin/${params.branch}`], params.repoPath);

      if (storedHash && newHash !== storedHash) {
        await run('git', ['pull', 'origin', params.branch, '--ff-only'], params.repoPath);
        storedHash = newHash;
        params.onNewCommit(newHash);
      } else if (!storedHash) {
        storedHash = newHash;
      }
    } catch (err) {
      console.error('[git-watcher] Poll error:', err instanceof Error ? err.message : err);
    }
  };

  timer = setInterval(poll, params.intervalMs);

  return () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
