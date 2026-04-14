import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createReminderStore } from '../store.js';
import type { Schedule } from '@r2/tool-reminder/src/schedule-types.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      next_fire_at_ms INTEGER NOT NULL,
      cycle_stage TEXT NOT NULL DEFAULT 'idle',
      cycle_num INTEGER NOT NULL DEFAULT 0,
      cycle_stage_ends_at_ms INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `);
  return db;
}

describe('ReminderStore', () => {
  let db: Database.Database;
  const fakeNow = 1_700_000_000_000;

  beforeEach(() => {
    db = freshDb();
  });

  it('create: inserts a row and computes next_fire_at_ms', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const schedule: Schedule = { kind: 'once', at_iso: new Date(fakeNow + 60_000).toISOString() };
    const id = store.create('выпить воды', schedule);
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.text).toBe('выпить воды');
    expect(row.active).toBe(1);
    expect(row.cycle_stage).toBe('idle');
    expect(row.next_fire_at_ms).toBe(fakeNow + 60_000);
  });

  it('create: rejects a schedule with no future fire', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const schedule: Schedule = { kind: 'once', at_iso: new Date(fakeNow - 60_000).toISOString() };
    expect(() => store.create('past', schedule)).toThrow(/no future fire/);
  });

  it('list: returns only active reminders', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const id1 = store.create('a', { kind: 'once', at_iso: new Date(fakeNow + 60_000).toISOString() });
    const id2 = store.create('b', { kind: 'once', at_iso: new Date(fakeNow + 120_000).toISOString() });
    store.delete(id1);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id2);
    expect(list[0].text).toBe('b');
  });

  it('delete: sets active=0 and returns true for existing, false for missing', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const id = store.create('a', { kind: 'once', at_iso: new Date(fakeNow + 60_000).toISOString() });
    expect(store.delete(id)).toBe(true);
    expect(store.delete(9999)).toBe(false);
    const row = db.prepare('SELECT active FROM reminders WHERE id = ?').get(id) as any;
    expect(row.active).toBe(0);
  });

  it('findDue: returns idle reminders whose next_fire is <= now', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    store.create('past', { kind: 'once', at_iso: new Date(fakeNow + 1).toISOString() });
    store.create('future', { kind: 'once', at_iso: new Date(fakeNow + 600_000).toISOString() });

    const due = store.findDueIdle(fakeNow + 10_000);
    expect(due).toHaveLength(1);
    expect(due[0].text).toBe('past');
  });

  it('beginRing: transitions idle → ringing and sets cycle_stage_ends_at', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const id = store.create('a', { kind: 'once', at_iso: new Date(fakeNow + 1000).toISOString() });
    store.beginRing(id, fakeNow + 1000);
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.cycle_stage).toBe('ringing');
    expect(row.cycle_num).toBe(0);
    expect(row.cycle_stage_ends_at_ms).toBe(fakeNow + 1000 + 60_000);
  });

  it('advanceRinging: transitions ringing → paused after 60s', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const id = store.create('a', { kind: 'once', at_iso: new Date(fakeNow + 1000).toISOString() });
    store.beginRing(id, fakeNow + 1000);
    store.advanceRingingToPaused(id, fakeNow + 61_000);
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.cycle_stage).toBe('paused');
    expect(row.cycle_stage_ends_at_ms).toBe(fakeNow + 61_000 + 120_000);
  });

  it('advancePausedToRinging: increments cycle_num', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const id = store.create('a', { kind: 'once', at_iso: new Date(fakeNow + 1000).toISOString() });
    store.beginRing(id, fakeNow + 1000);
    store.advanceRingingToPaused(id, fakeNow + 61_000);
    store.advancePausedToRinging(id, fakeNow + 181_000);
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.cycle_stage).toBe('ringing');
    expect(row.cycle_num).toBe(1);
  });

  it('finishCycle: one-shot reminder is deactivated', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const id = store.create('a', { kind: 'once', at_iso: new Date(fakeNow + 1000).toISOString() });
    store.finishCycle(id, fakeNow + 10_000);
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.active).toBe(0);
    expect(row.cycle_stage).toBe('done');
  });

  it('finishCycle: daily reminder rolls to next fire and returns to idle', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const anchor = new Date(fakeNow);
    const schedule: Schedule = { kind: 'daily', hour: anchor.getHours(), minute: (anchor.getMinutes() + 1) % 60 };
    const id = store.create('daily', schedule);
    store.finishCycle(id, fakeNow + 10_000);
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.active).toBe(1);
    expect(row.cycle_stage).toBe('idle');
    expect(row.cycle_num).toBe(0);
    expect(row.next_fire_at_ms).toBeGreaterThan(fakeNow + 10_000);
  });

  it('dismiss: stops current ring and recomputes next_fire for recurring', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const schedule: Schedule = { kind: 'daily', hour: 9, minute: 0 };
    const id = store.create('a', schedule);
    store.beginRing(id, fakeNow + 1000);
    store.dismiss(id, fakeNow + 5000);
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.cycle_stage).toBe('idle');
    expect(row.active).toBe(1);
    expect(row.next_fire_at_ms).toBeGreaterThan(fakeNow + 5000);
  });

  it('dismiss: deactivates one-shot', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const schedule: Schedule = { kind: 'once', at_iso: new Date(fakeNow + 1000).toISOString() };
    const id = store.create('a', schedule);
    store.beginRing(id, fakeNow + 1000);
    store.dismiss(id, fakeNow + 5000);
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.active).toBe(0);
  });

  it('snooze: creates a new one-shot 10 min later with the same text', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const schedule: Schedule = { kind: 'daily', hour: 9, minute: 0 };
    const id = store.create('выпить воды', schedule);
    store.beginRing(id, fakeNow + 1000);
    const newId = store.snooze(id, fakeNow + 5000);
    expect(newId).not.toBe(id);
    const snoozed = db.prepare('SELECT * FROM reminders WHERE id = ?').get(newId) as any;
    expect(snoozed.text).toBe('выпить воды');
    expect(JSON.parse(snoozed.schedule_json).kind).toBe('once');
    expect(snoozed.next_fire_at_ms).toBe(fakeNow + 5000 + 10 * 60_000);
    const original = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(original.active).toBe(1);
    expect(original.cycle_stage).toBe('idle');
  });
});
