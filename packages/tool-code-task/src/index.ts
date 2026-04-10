import type { ToolDefinition, ToolContext, ToolResult } from '@r2/shared';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureWorktree, removeWorktree, commitChanges, getStagedFiles, unstageFile, preserveCommit } from './worktree.js';
import { runAgent } from './agent-sdk.js';
import { runRalphex } from './ralphex.js';
import { parseDiffStats, truncateDiff, summarizeDiff } from './diff.js';
import { run } from './shell.js';
import { isDestructive } from './destructive-check.js';

export { isDestructive } from './destructive-check.js';

const DENYLIST_PATTERNS = [
  /(^|\/)\.env(\.|$)/,
  /\.(key|pem|p12|pfx|asc|gpg)$/,
  /(^|\/)id_rsa(\.|$)/,
  /(^|\/)id_ed25519(\.|$)/,
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\//,
  /(^|\/)\.kube\//,
];

const MAX_FILE_SIZE = 1024 * 1024;
const SYMLINK_MODE = '120000';

async function filterStagedFiles(workdir: string): Promise<string[]> {
  const staged = await getStagedFiles(workdir);
  const blocked: string[] = [];

  for (const { file, mode } of staged) {
    let block = false;

    if (DENYLIST_PATTERNS.some((p) => p.test(file))) {
      block = true;
    } else if (mode === SYMLINK_MODE) {
      block = true;
    } else {
      try {
        const stats = fs.statSync(path.join(workdir, file));
        if (stats.size > MAX_FILE_SIZE) block = true;
      } catch {
        // file might not exist (deletion) — allow
      }
    }

    if (block) {
      await unstageFile(workdir, file);
      blocked.push(file);
    }
  }

  return blocked;
}

export const codeTaskTool: ToolDefinition = {
  name: 'code_task',
  description: 'Execute a coding task on R2 dev branch. Use for modifications to R2 source code itself. Runs Claude Code or ralphex in an isolated git worktree.',
  permissionLevel: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Specific task description' },
      context: { type: 'string', description: 'Optional: files, requirements, constraints' },
    },
    required: ['task'],
  },

  preCheck: async (input) => {
    const task = typeof input.task === 'string' ? input.task : '';
    const context = typeof input.context === 'string' ? input.context : undefined;
    return isDestructive(task, context);
  },

  async handler(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const task = params.task;
    if (typeof task !== 'string' || task.trim().length === 0) {
      return { success: false, error: 'task parameter is required' };
    }
    const context = typeof params.context === 'string' ? params.context : undefined;
    const onProgress = ctx?.onProgress ?? (() => {});
    const signal = ctx?.signal;
    const rawCallId = ctx?.meta?.callId ?? crypto.randomBytes(4).toString('hex');
    // Sanitize callId before using it as a filesystem path suffix. block.id
    // comes from Claude and is not guaranteed to be shell/path-safe; even
    // though validateWorktreePath rejects `..`/`~`, it allows slashes which
    // would let a malformed id create nested subdirs under the prefix and
    // collide with sibling worktrees. Keep only [a-zA-Z0-9_-].
    const callId = rawCallId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const autoMode = ctx?.meta?.autoMode === true;

    const prefix = process.env.R2_DEV_WORKTREE_PREFIX || '/tmp/r2-dev-';
    const workdir = `${prefix}${callId}`;
    const branch = process.env.R2_DEV_BRANCH || 'dev';
    const baseBranch = process.env.R2_DEV_BASE_BRANCH || 'master';
    const startTime = Date.now();

    if (autoMode && !ctx?.requestPlanReview) {
      return { success: false, error: 'Plan review callback required for auto mode' };
    }

    let worktreeCreated = false;
    let baseSha = '';
    let commit = '';
    try {
      onProgress('Preparing worktree...');
      baseSha = await ensureWorktree(workdir, branch, baseBranch);
      worktreeCreated = true;

      onProgress(`Running ${autoMode ? 'ralphex' : 'agent'}...`);
      if (autoMode) {
        await runRalphex({
          workdir,
          task,
          context,
          onProgress,
          requestPlanReview: ctx!.requestPlanReview!,
          signal,
        });
      } else {
        await runAgent({ workdir, task, context, onProgress, signal });
      }

      onProgress('Filtering files...');
      const blockedFiles = await filterStagedFiles(workdir);

      onProgress('Committing...');
      commit = await commitChanges(workdir, `r2: ${task}`);

      onProgress('Computing diff...');
      let files: ReturnType<typeof parseDiffStats> = [];
      let fullDiff = '';
      let diffError = false;
      try {
        // Diff against the exact SHA the worktree was created from rather
        // than a potentially-unrelated base branch ref; otherwise the diff
        // may include commits that existed on the base before this task ran.
        const range = `${baseSha}..HEAD`;
        const numstat = await run('git', ['diff', '--numstat', range], workdir);
        files = parseDiffStats(numstat);
        fullDiff = await run('git', ['diff', range], workdir);
      } catch {
        // Diff failed — don't lose the commit
        diffError = true;
        onProgress('Diff parsing failed, continuing with commit hash only');
      }

      const commitShort = commit ? commit.slice(0, 7) : 'no-commit';
      const summary = diffError
        ? `Commit ${commitShort} created; diff unavailable`
        : summarizeDiff(files, commit || 'no-commit');
      const shortDiff = truncateDiff(fullDiff, 50);

      return {
        success: true,
        data: {
          summary,
          files,
          shortDiff,
          fullDiff,
          commit,
          mode: autoMode ? 'ralphex' : 'once',
          durationMs: Date.now() - startTime,
          blockedFiles,
        },
        display: {
          type: 'code',
          content: shortDiff,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error in code_task',
      };
    } finally {
      if (worktreeCreated) {
        // Pin the commit in the parent repo BEFORE removing the worktree so
        // it stays reachable after the detached HEAD goes away. Otherwise
        // `git gc` eventually drops it and the returned hash is useless.
        if (commit) {
          try {
            await preserveCommit(callId, commit);
          } catch (err) {
            // The commit hash was already returned to the caller; if
            // update-ref fails the commit will eventually be GC'd. Log so
            // operators can see broken hashes instead of discovering them
            // via a 404 later.
            console.error(
              'preserveCommit failed — returned commit hash may be unreachable after git gc:',
              err instanceof Error ? err.message : err,
            );
          }
        }
        try { await removeWorktree(workdir); } catch {}
      }
    }
  },
};

export default codeTaskTool;
