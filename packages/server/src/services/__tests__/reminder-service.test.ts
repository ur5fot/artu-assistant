import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createReminderService } from '../reminder-service.js';
import type { ReminderStore, ReminderRow } from '../../reminders/store.js';

function makeStore(overrides: Partial<ReminderStore> = {}): ReminderStore {
  return {
    create: vi.fn(),
    list: vi.fn().mockReturnValue([] as ReminderRow[]),
    delete: vi.fn(),
    findDueIdle: vi.fn().mockReturnValue([]),
    findDueRinging: vi.fn().mockReturnValue([]),
    findDuePaused: vi.fn().mockReturnValue([]),
    beginRing: vi.fn(),
    advanceRingingToPaused: vi.fn(),
    advancePausedToRinging: vi.fn(),
    finishCycle: vi.fn().mockReturnValue({ nextFire: null }),
    dismiss: vi.fn(),
    snooze: vi.fn().mockReturnValue(0),
    getById: vi.fn(),
    ...overrides,
  } as ReminderStore;
}

describe('reminder-service', () => {
  it('dismiss: returns false when reminder does not exist', () => {
    const store = makeStore({ getById: vi.fn().mockReturnValue(null) });
    const bus = new EventEmitter();
    const service = createReminderService({ store, bus });
    expect(service.dismiss(42)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('dismiss: returns false when reminder is not ringing or paused', () => {
    const row = { id: 1, active: true, cycle_stage: 'idle' } as ReminderRow;
    const store = makeStore({ getById: vi.fn().mockReturnValue(row) });
    const bus = new EventEmitter();
    const service = createReminderService({ store, bus });
    expect(service.dismiss(1)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('dismiss: calls store.dismiss and emits reminder_dismissed', () => {
    const row = { id: 1, active: true, cycle_stage: 'ringing' } as ReminderRow;
    const store = makeStore({ getById: vi.fn().mockReturnValue(row) });
    const bus = new EventEmitter();
    const events: any[] = [];
    bus.on('push', (e) => events.push(e));
    const service = createReminderService({ store, bus });
    expect(service.dismiss(1)).toEqual({ ok: true });
    expect(store.dismiss).toHaveBeenCalledWith(1, expect.any(Number));
    expect(events).toEqual([{ type: 'reminder_dismissed', id: 1 }]);
  });

  it('snooze: returns snoozedId and emits reminder_stop_ring', () => {
    const row = { id: 1, active: true, cycle_stage: 'ringing' } as ReminderRow;
    const store = makeStore({
      getById: vi.fn().mockReturnValue(row),
      snooze: vi.fn().mockReturnValue(99),
    });
    const bus = new EventEmitter();
    const events: any[] = [];
    bus.on('push', (e) => events.push(e));
    const service = createReminderService({ store, bus });
    expect(service.snooze(1)).toEqual({ ok: true, snoozedId: 99 });
    expect(events).toEqual([{ type: 'reminder_stop_ring', id: 1 }]);
  });

  it('list: delegates to store.list', () => {
    const rows = [{ id: 1 } as ReminderRow];
    const store = makeStore({ list: vi.fn().mockReturnValue(rows) });
    const service = createReminderService({ store, bus: new EventEmitter() });
    expect(service.list()).toEqual(rows);
  });
});
