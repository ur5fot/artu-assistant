import { Router } from 'express';
import type { Request, Response } from 'express';
import { getMessages, clearMessages } from '../db.js';

export function createMessagesRouter(): Router {
  const router = Router();

  router.get('/messages', (_req: Request, res: Response) => {
    const messages = getMessages();
    res.json(messages);
  });

  router.delete('/messages', (_req: Request, res: Response) => {
    clearMessages();
    res.json({ ok: true });
  });

  return router;
}
