import { Router, type Request, type Response } from 'express';
import type { MemoryConfirmResponse } from '@r2/shared';
import type { MemoryConfirmService } from '../services/memory-confirm-service.js';

export type { MemoryConfirmResponse };
export type PendingMemoryConfirms = Map<string, (response: MemoryConfirmResponse) => void>;

interface Deps {
  service: MemoryConfirmService;
}

export function createMemoryConfirmRouter(deps: Deps): Router {
  const router = Router();
  const { service } = deps;

  router.post('/memory-confirm', (req: Request, res: Response) => {
    const { callId, approved, editedParams } = req.body;

    if (!callId || typeof callId !== 'string') {
      res.status(400).json({ error: 'callId (string) required' });
      return;
    }
    if (typeof approved !== 'boolean') {
      res.status(400).json({ error: 'approved (boolean) required' });
      return;
    }

    const edited =
      editedParams !== null && typeof editedParams === 'object' && !Array.isArray(editedParams)
        ? (editedParams as Record<string, unknown>)
        : undefined;

    const result = service.resolve(callId, approved, edited);
    if (!result.ok) {
      res.status(404).json({ error: `Pending memory confirm "${callId}" not found` });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
