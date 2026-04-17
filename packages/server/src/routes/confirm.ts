import { Router, type Request, type Response } from 'express';
import type { PermissionService } from '../services/permission-service.js';

export interface ConfirmResponse {
  allowed: boolean;
  remember: boolean;
}

export type PendingConfirms = Map<string, (response: ConfirmResponse) => void>;

interface Deps {
  service: PermissionService;
}

export function createConfirmRouter(deps: Deps): Router {
  const router = Router();
  const { service } = deps;

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

    const result = service.resolveConfirm(callId, allowed, !!remember);
    if (!result.ok) {
      res.status(404).json({ error: `Pending confirm "${callId}" not found` });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
