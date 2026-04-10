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
        res.status(500).json({ error: 'merge failed without conflicts' });
        return;
      }

      try {
        await run('git', ['push', 'origin', masterBranch], cwd);
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? `push failed: ${err.message}` : 'push failed',
        });
        return;
      }

      const commit = await run('git', ['rev-parse', 'HEAD'], cwd);
      const shortstat = await run('git', ['diff', '--shortstat', 'HEAD~1..HEAD'], cwd);
      const filesChangedMatch = shortstat.match(/(\d+) files? changed/);
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
