import fs from 'node:fs';
import { run, tryRun } from './shell.js';

export function validateWorktreePath(path: string): void {
  const prefix = process.env.R2_DEV_WORKTREE_PREFIX || '/tmp/r2-dev-';
  if (!path.startsWith(prefix)) {
    throw new Error(`Worktree path must start with ${prefix}`);
  }
  if (path.includes('..') || path.includes('~') || path === '/') {
    throw new Error('Invalid worktree path');
  }
}

export async function ensureWorktree(path: string, branch: string): Promise<void> {
  validateWorktreePath(path);

  if (fs.existsSync(path)) {
    await tryRun('git', ['worktree', 'remove', '--force', path]);
    if (fs.existsSync(path)) {
      fs.rmSync(path, { recursive: true, force: true });
    }
  }

  await run('git', ['worktree', 'add', '--detach', path, `origin/${branch}`]);
}

export async function removeWorktree(path: string): Promise<void> {
  validateWorktreePath(path);

  await tryRun('git', ['worktree', 'remove', '--force', path]);

  if (fs.existsSync(path)) {
    fs.rmSync(path, { recursive: true, force: true });
  }

  // Prune dangling worktree entries
  await tryRun('git', ['worktree', 'prune']);
}

export async function getStagedFiles(path: string): Promise<Array<{ file: string; mode: string }>> {
  validateWorktreePath(path);
  const { stdout: rawDiff } = await tryRun('git', ['diff', '--cached', '--raw'], path);
  return rawDiff
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      // Format: ":100644 100644 <src> <dst> M\tfilename"
      const match = line.match(/^:(\d+) (\d+) \S+ \S+ \S+\t(.+)$/);
      if (!match) return null;
      return { file: match[3], mode: match[2] }; // destination mode
    })
    .filter((x): x is { file: string; mode: string } => x !== null);
}

export async function unstageFile(path: string, file: string): Promise<void> {
  validateWorktreePath(path);
  await run('git', ['restore', '--staged', file], path);
}

export async function commitChanges(path: string, message: string): Promise<string> {
  validateWorktreePath(path);

  const diffCheck = await tryRun('git', ['diff', '--cached', '--quiet'], path);
  if (diffCheck.ok) {
    return ''; // exit 0 = no staged changes
  }

  await run('git', ['commit', '-m', message], path);
  const hash = await run('git', ['rev-parse', 'HEAD'], path);
  return hash;
}
