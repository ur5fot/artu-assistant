import { Router } from 'express';
import type { Request, Response } from 'express';
import { run, tryRun } from '@r2/tool-code-task';

// Serialize deploys: concurrent /api/merge requests would interleave git
// state mutations on the same worktree.
let deployInFlight: Promise<void> | null = null;

export function createMergeRouter(): Router {
  const router = Router();

  router.post('/merge', async (_req: Request, res: Response) => {
    if (deployInFlight) {
      res.status(409).json({ error: 'deploy already in progress' });
      return;
    }

    let release!: () => void;
    deployInFlight = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await handleMerge(res);
    } finally {
      release();
      deployInFlight = null;
    }
  });

  return router;
}

async function handleMerge(res: Response): Promise<void> {
  const cwd = process.env.R2_GIT_REPO_PATH || process.cwd();
  const devBranch = process.env.R2_DEV_BRANCH || 'dev';
  const masterBranch = process.env.R2_GIT_WATCH_BRANCH || 'master';

  try {
    // Refuse to deploy over a dirty worktree — the rollback path would
    // otherwise wipe uncommitted tracked changes.
    const status = await tryRun('git', ['status', '--porcelain'], cwd);
    if (status.ok && status.stdout.trim().length > 0) {
      res.status(409).json({ error: 'working tree not clean; commit or stash changes before deploying' });
      return;
    }

    await run('git', ['fetch', 'origin'], cwd);
    await run('git', ['checkout', masterBranch], cwd);
    await run('git', ['pull', 'origin', masterBranch, '--ff-only'], cwd);

    // Capture HEAD before merge so we can detect no-op merges and safely
    // roll back on push failure. Failure here is fatal — without a known
    // pre-merge SHA we cannot safely roll back.
    const headBeforeResult = await tryRun('git', ['rev-parse', 'HEAD'], cwd);
    if (!headBeforeResult.ok) {
      res.status(500).json({ error: 'failed to read HEAD before merge' });
      return;
    }
    const headBefore = headBeforeResult.stdout;

    const timestamp = new Date().toISOString();
    const mergeResult = await tryRun(
      'git',
      ['merge', '--no-ff', devBranch, '-m', `deploy: ${timestamp}`],
      cwd,
    );

    if (!mergeResult.ok) {
      const conflictResult = await tryRun(
        'git',
        ['diff', '--name-only', '--diff-filter=U'],
        cwd,
      );
      const conflicts = conflictResult.stdout.split('\n').filter(Boolean);
      await tryRun('git', ['merge', '--abort'], cwd);

      if (conflicts.length > 0) {
        res.status(409).json({ error: 'merge conflicts', conflicts });
        return;
      }
      res.status(500).json({ error: 'merge failed' });
      return;
    }

    const headAfterResult = await tryRun('git', ['rev-parse', 'HEAD'], cwd);
    if (!headAfterResult.ok) {
      res.status(500).json({ error: 'failed to read HEAD after merge' });
      return;
    }
    const headAfter = headAfterResult.stdout;
    const mergeCreatedCommit = headBefore !== headAfter;

    if (mergeCreatedCommit) {
      try {
        await run('git', ['push', 'origin', masterBranch], cwd);
      } catch (err) {
        // Roll back the merge commit we just created. Re-check clean state
        // before reset --hard to avoid wiping files modified during the
        // request, and reset to the captured pre-merge SHA rather than HEAD~1
        // so concurrent commits can't shift the target.
        const rollbackStatus = await tryRun('git', ['status', '--porcelain'], cwd);
        if (!rollbackStatus.ok) {
          console.error('[merge] push failed and cleanliness check failed; skipping rollback to avoid data loss. Manual recovery required. headBefore=', headBefore, 'status error:', rollbackStatus.stderr);
        } else if (rollbackStatus.stdout.trim().length > 0) {
          console.error('[merge] push failed and worktree became dirty; skipping rollback to avoid data loss. Manual recovery required. headBefore=', headBefore);
        } else {
          const resetResult = await tryRun('git', ['reset', '--hard', headBefore], cwd);
          if (!resetResult.ok) {
            console.error('[merge] push failed and rollback reset --hard failed; repo may be drifted. Manual recovery required. headBefore=', headBefore, 'reset error:', resetResult.stderr);
          }
        }
        console.error('[merge] push failed:', err instanceof Error ? err.message : err);
        res.status(500).json({ error: 'push failed' });
        return;
      }
    }

    // Post-push: never fail the response — the deploy already succeeded.
    const commit = headAfter;
    let filesChanged = 0;
    if (mergeCreatedCommit) {
      const shortstatResult = await tryRun(
        'git',
        ['diff', '--shortstat', 'HEAD~1..HEAD'],
        cwd,
      );
      const filesChangedMatch = shortstatResult.ok
        ? shortstatResult.stdout.match(/(\d+) files? changed/)
        : null;
      filesChanged = filesChangedMatch ? parseInt(filesChangedMatch[1], 10) : 0;
    }

    res.json({
      ok: true,
      commit,
      filesChanged,
      message: mergeCreatedCommit
        ? `Deployed ${commit.slice(0, 7)} (${filesChanged} files)`
        : `Already up to date (${commit.slice(0, 7)})`,
    });
  } catch (err) {
    console.error('[merge] error:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'merge failed' });
  }
}
