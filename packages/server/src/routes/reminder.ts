import { Router, type Request, type Response } from 'express';
import type { ReminderService } from '../services/reminder-service.js';

interface Deps {
  service: ReminderService;
}

export function createReminderRouter(deps: Deps): Router {
  const { service } = deps;
  const router = Router();

  router.post('/dismiss', (req: Request, res: Response) => {
    const id = Number((req.body ?? {}).id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const result = service.dismiss(id);
    if (!result.ok) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/snooze', (req: Request, res: Response) => {
    const id = Number((req.body ?? {}).id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const result = service.snooze(id);
    if (!result.ok) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ ok: true, snoozedId: result.snoozedId });
  });

  return router;
}
