import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db.js';

export function createPiiRouter(): Router {
  const router = Router();

  router.delete('/pii-tokens', (_req: Request, res: Response) => {
    const db = getDb();
    db.prepare('DELETE FROM pii_tokens').run();
    res.json({ ok: true });
  });

  return router;
}
