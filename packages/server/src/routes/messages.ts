import { Router } from 'express';
import type { Request, Response } from 'express';
import { getMessages, clearMessages } from '../db.js';

export function createMessagesRouter(): Router {
  const router = Router();

  router.get('/messages', (_req: Request, res: Response) => {
    try {
      const messages = getMessages();
      res.json(messages);
    } catch (err) {
      console.error('Failed to get messages:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Failed to load messages' });
    }
  });

  router.delete('/messages', (_req: Request, res: Response) => {
    try {
      clearMessages();
      res.json({ ok: true });
    } catch (err) {
      console.error('Failed to clear messages:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Failed to clear messages' });
    }
  });

  return router;
}
