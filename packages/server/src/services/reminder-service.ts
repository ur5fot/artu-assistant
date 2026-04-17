import type { EventEmitter } from 'node:events';
import type { ReminderStore, ReminderRow } from '../reminders/store.js';

export interface ReminderService {
  dismiss(id: number): { ok: true } | { ok: false; reason: 'not_found' };
  snooze(id: number): { ok: true; snoozedId: number } | { ok: false; reason: 'not_found' };
  list(): ReminderRow[];
}

interface Deps {
  store: ReminderStore;
  bus: EventEmitter;
  now?: () => number;
}

export function createReminderService(deps: Deps): ReminderService {
  const { store, bus } = deps;
  const now = deps.now ?? (() => Date.now());

  const isActionable = (row: ReminderRow | null): boolean =>
    !!row && row.active && (row.cycle_stage === 'ringing' || row.cycle_stage === 'paused');

  return {
    dismiss(id) {
      const row = store.getById(id);
      if (!isActionable(row)) return { ok: false, reason: 'not_found' };
      store.dismiss(id, now());
      bus.emit('push', { type: 'reminder_dismissed', id });
      return { ok: true };
    },
    snooze(id) {
      const row = store.getById(id);
      if (!isActionable(row)) return { ok: false, reason: 'not_found' };
      const snoozedId = store.snooze(id, now());
      // `reminder_stop_ring` keeps web audio parity (silences the alarm);
      // `reminder_snoozed` is a distinct signal so Discord can mark the embed
      // as snoozed without colliding with the scheduler's internal
      // ringing→paused transition, which also emits reminder_stop_ring.
      bus.emit('push', { type: 'reminder_stop_ring', id });
      bus.emit('push', { type: 'reminder_snoozed', id });
      return { ok: true, snoozedId };
    },
    list() {
      return store.list();
    },
  };
}
