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
      storedHash = await run('git', ['rev-parse', `origin/${params.branch}`], params.repoPath);
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
        storedHash = newHash;
        return;
      }
      if (newHash === storedHash) return;

      const head = await currentBranch();
      if (head !== params.branch) {
        console.error(
          `[git-watcher] New commit on ${params.branch} but HEAD is on ${head}; skipping pull`,
        );
        storedHash = newHash;
        return;
      }

      await run('git', ['pull', 'origin', params.branch, '--ff-only'], params.repoPath);
      storedHash = newHash;
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
  initialize().then(() => {
    if (stopped) return;
    timer = setInterval(poll, params.intervalMs);
  });

  return () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
