import { Router } from 'express';
import type { Request, Response } from 'express';
import type { PiiVault } from '../pii/vault.js';

export function createPiiRouter(vault: PiiVault): Router {
  const router = Router();

  router.delete('/pii-tokens', (_req: Request, res: Response) => {
    vault.clearAll();
    res.json({ ok: true });
  });

  return router;
}
