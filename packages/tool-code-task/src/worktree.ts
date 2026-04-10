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

/**
 * Resolve the first existing ref from a list of candidates.
 * Used so worktrees can be based on origin/<branch> in CI, local <branch>
 * on a dev machine without a configured remote, or falling back to the
 * base branch when the dev branch does not yet exist.
 */
export async function resolveBaseRef(branch: string, baseBranch: string): Promise<string> {
  const candidates = [
    `origin/${branch}`,
    branch,
    `origin/${baseBranch}`,
    baseBranch,
  ];
  for (const ref of candidates) {
    const r = await tryRun('git', ['rev-parse', '--verify', `${ref}^{commit}`]);
    if (r.ok) return ref;
  }
  throw new Error(
    `Cannot resolve base ref: tried ${candidates.join(', ')}. ` +
      `Create branch '${branch}' or set R2_DEV_BRANCH / R2_DEV_BASE_BRANCH.`,
  );
}

/**
 * Create a detached worktree at `path` based on the resolved branch ref.
 * Returns the commit SHA that the worktree was created from; callers should
 * use this SHA as the base for diffs instead of a separately-configured
 * base branch, otherwise the diff can include unrelated commits.
 */
export async function ensureWorktree(
  path: string,
  branch: string,
  baseBranch: string = 'master',
): Promise<string> {
  validateWorktreePath(path);

  if (fs.existsSync(path)) {
    await tryRun('git', ['worktree', 'remove', '--force', path]);
    if (fs.existsSync(path)) {
      fs.rmSync(path, { recursive: true, force: true });
    }
  }

  const baseRef = await resolveBaseRef(branch, baseBranch);
  await run('git', ['worktree', 'add', '--detach', path, baseRef]);
  // Capture the exact commit SHA so diff comparisons are stable even if the
  // underlying ref moves while the agent is working.
  const baseSha = await run('git', ['rev-parse', 'HEAD'], path);
  return baseSha;
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

/**
 * Update a ref in the parent repo so the commit made inside the (detached,
 * about-to-be-removed) worktree stays reachable after cleanup. Without this,
 * `git gc` eventually drops the commit and the returned hash becomes useless.
 */
export async function preserveCommit(callId: string, commitSha: string): Promise<void> {
  if (!commitSha) return;
  // Sanitize callId for use in a ref path. Git refuses refs containing ..
  // or control characters; be strict and only allow [a-zA-Z0-9_-].
  const safe = callId.replace(/[^a-zA-Z0-9_-]/g, '_');
  await tryRun('git', ['update-ref', `refs/r2-dev/${safe}`, commitSha]);
}

/**
 * Parse `git diff --cached --raw -z` output into { file, mode } records.
 *
 * With -z the format is NUL-separated:
 *   ":<src_mode> <dst_mode> <src_sha> <dst_sha> <STATUS>\0<path>\0"
 * For rename/copy (status R/C), two paths follow:
 *   ":... R100\0<src_path>\0<dst_path>\0"
 *
 * Earlier versions used a tab-based regex that captured "old\tnew" as a
 * single string for renames, letting a rename of a secret slip past the
 * denylist. This implementation always returns the destination path.
 */
export function parseRawDiffZ(rawZ: string): Array<{ file: string; mode: string }> {
  const results: Array<{ file: string; mode: string }> = [];
  const tokens = rawZ.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const header = tokens[i];
    if (!header || !header.startsWith(':')) {
      i++;
      continue;
    }
    const parts = header.slice(1).split(' '); // drop leading ':'
    if (parts.length < 5) {
      i++;
      continue;
    }
    const dstMode = parts[1];
    const status = parts[4];
    const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
    const firstPath = tokens[i + 1];
    if (isRenameOrCopy) {
      const dstPath = tokens[i + 2];
      if (dstPath) results.push({ file: dstPath, mode: dstMode });
      i += 3;
    } else {
      if (firstPath) results.push({ file: firstPath, mode: dstMode });
      i += 2;
    }
  }
  return results;
}

export async function getStagedFiles(path: string): Promise<Array<{ file: string; mode: string }>> {
  validateWorktreePath(path);
  // Use run (throws on failure) instead of tryRun so a transient git error
  // never silently returns an empty list, which would let the denylist
  // enforcement in filterStagedFiles be bypassed and commit the staged tree
  // unchecked. The caller (code_task handler) catches and fails the tool.
  const rawDiff = await run('git', ['diff', '--cached', '--raw', '-z'], path);
  return parseRawDiffZ(rawDiff);
}

export async function unstageFile(path: string, file: string): Promise<void> {
  validateWorktreePath(path);
  // Use `--` to prevent git from interpreting filenames starting with '-'
  await run('git', ['restore', '--staged', '--', file], path);
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
