import { Router } from 'express';
import type { Request, Response } from 'express';
import { run, tryRun } from '@r2/tool-code-task';

export function createMergeRouter(): Router {
  const router = Router();

  router.post('/merge', async (_req: Request, res: Response) => {
    const cwd = process.env.R2_GIT_REPO_PATH || process.cwd();
    const devBranch = process.env.R2_DEV_BRANCH || 'dev';
    const masterBranch = process.env.R2_GIT_WATCH_BRANCH || 'master';

    try {
      await run('git', ['fetch', 'origin'], cwd);
      await run('git', ['checkout', masterBranch], cwd);
      await run('git', ['pull', 'origin', masterBranch, '--ff-only'], cwd);

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
        res.status(500).json({
          error: mergeResult.stderr || 'merge failed without conflicts',
        });
        return;
      }

      try {
        await run('git', ['push', 'origin', masterBranch], cwd);
      } catch (err) {
        // Roll back local master so it doesn't drift ahead of origin;
        // next deploy attempt will start from a clean state.
        await tryRun('git', ['reset', '--hard', `origin/${masterBranch}`], cwd);
        res.status(500).json({
          error: err instanceof Error ? `push failed: ${err.message}` : 'push failed',
        });
        return;
      }

      // Post-push: never fail the response — the deploy already succeeded.
      const commitResult = await tryRun('git', ['rev-parse', 'HEAD'], cwd);
      const commit = commitResult.ok ? commitResult.stdout : '';
      const shortstatResult = await tryRun(
        'git',
        ['diff', '--shortstat', 'HEAD~1..HEAD'],
        cwd,
      );
      const filesChangedMatch = shortstatResult.ok
        ? shortstatResult.stdout.match(/(\d+) files? changed/)
        : null;
      const filesChanged = filesChangedMatch ? parseInt(filesChangedMatch[1], 10) : 0;

      res.json({
        ok: true,
        commit,
        filesChanged,
        message: `Deployed ${commit.slice(0, 7)} (${filesChanged} files)`,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'merge failed',
      });
    }
  });

  return router;
}
