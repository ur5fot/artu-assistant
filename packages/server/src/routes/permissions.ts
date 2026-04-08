import { Router } from 'express';
import type { Request, Response } from 'express';
import { clearPermissionRules } from '../db.js';

export function createPermissionsRouter(): Router {
  const router = Router();

  router.delete('/permissions', (_req: Request, res: Response) => {
    clearPermissionRules();
    res.json({ ok: true });
  });

  return router;
}
