import { Router, type Request, type Response } from 'express';
import type { EventEmitter } from 'node:events';
import type { ReminderStore } from '../reminders/store.js';

interface ReminderRouterDeps {
  store: ReminderStore;
  bus: EventEmitter;
}

export function createReminderRouter(deps: ReminderRouterDeps): Router {
  const { store, bus } = deps;
  const router = Router();

  router.post('/dismiss', (req: Request, res: Response) => {
    const id = Number((req.body ?? {}).id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const existed = store.getById(id);
    if (!existed || !existed.active || (existed.cycle_stage !== 'ringing' && existed.cycle_stage !== 'paused')) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    store.dismiss(id, Date.now());
    bus.emit('push', { type: 'reminder_stop_ring', id });
    bus.emit('push', { type: 'reminder_dismissed', id });
    res.json({ ok: true });
  });

  router.post('/snooze', (req: Request, res: Response) => {
    const id = Number((req.body ?? {}).id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const existed = store.getById(id);
    if (!existed || !existed.active || (existed.cycle_stage !== 'ringing' && existed.cycle_stage !== 'paused')) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const snoozedId = store.snooze(id, Date.now());
    bus.emit('push', { type: 'reminder_stop_ring', id });
    res.json({ ok: true, snoozedId });
  });

  return router;
}
