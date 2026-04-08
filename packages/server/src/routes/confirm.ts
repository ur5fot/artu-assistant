import { Router } from 'express';
import type { Request, Response } from 'express';

export interface ConfirmResponse {
  allowed: boolean;
  remember: boolean;
}

export type PendingConfirms = Map<string, (response: ConfirmResponse) => void>;

export function createConfirmRouter(pendingConfirms: PendingConfirms): Router {
  const router = Router();

  router.post('/confirm', (req: Request, res: Response) => {
    const { callId, allowed, remember } = req.body;

    if (!callId || typeof callId !== 'string') {
      res.status(400).json({ error: 'callId (string) required' });
      return;
    }

    if (typeof allowed !== 'boolean') {
      res.status(400).json({ error: 'allowed (boolean) required' });
      return;
    }

    const resolve = pendingConfirms.get(callId);
    if (!resolve) {
      res.status(404).json({ error: `Pending confirm "${callId}" not found` });
      return;
    }

    pendingConfirms.delete(callId);

    resolve({ allowed: !!allowed, remember: !!remember });
    res.json({ ok: true });
  });

  return router;
}
