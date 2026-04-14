import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createReminderStore } from '../store.js';
import { advanceScheduler } from '../scheduler.js';
import { reminderBus, type ReminderPushEvent } from '../bus.js';
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
    );
    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      pii_entities TEXT,
      timestamp INTEGER NOT NULL,
      source TEXT
    );
  `);
  return db;
}

describe('advanceScheduler', () => {
  let db: Database.Database;
  let events: ReminderPushEvent[];
  let listener: (e: ReminderPushEvent) => void;
  const t0 = 1_700_000_000_000;

  beforeEach(() => {
    db = freshDb();
    events = [];
    listener = (e) => events.push(e);
    reminderBus.on('push', listener);
  });

  afterEach(() => {
    reminderBus.off('push', listener);
  });

  function runTick(now: number) {
    const store = createReminderStore({ db, now: () => now });
    advanceScheduler({ store, db, now, bus: reminderBus });
  }

  it('idle → ringing: fires at the scheduled time and emits reminder_ring', () => {
    const store = createReminderStore({ db, now: () => t0 });
    const schedule: Schedule = { kind: 'once', at_iso: new Date(t0 + 1000).toISOString() };
    const id = store.create('drink water', schedule);

    runTick(t0 + 2000);

    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.cycle_stage).toBe('ringing');
    expect(events).toEqual([{ type: 'reminder_ring', id, text: 'drink water' }]);

    const msgs = db.prepare('SELECT content FROM chat_messages ORDER BY id').all() as any[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('⏰ drink water');
  });

  it('ringing → paused after 60s', () => {
    const store = createReminderStore({ db, now: () => t0 });
    store.create('a', { kind: 'once', at_iso: new Date(t0 + 1000).toISOString() });

    runTick(t0 + 2000);
    events.length = 0;
    runTick(t0 + 2000 + 60_001);

    const row = db.prepare('SELECT * FROM reminders').get() as any;
    expect(row.cycle_stage).toBe('paused');
    expect(events).toEqual([{ type: 'reminder_stop_ring', id: row.id }]);
  });

  it('paused → ringing cycle 1, then cycle 2, then done', () => {
    const store = createReminderStore({ db, now: () => t0 });
    store.create('a', { kind: 'once', at_iso: new Date(t0 + 1000).toISOString() });

    let t = t0 + 2000;
    runTick(t);
    t += 60_001;
    runTick(t);
    t += 120_001;
    runTick(t);
    const rowCycle1 = db.prepare('SELECT cycle_num, cycle_stage FROM reminders').get() as any;
    expect(rowCycle1).toEqual({ cycle_num: 1, cycle_stage: 'ringing' });

    t += 60_001;
    runTick(t);
    t += 120_001;
    runTick(t);
    const rowCycle2 = db.prepare('SELECT cycle_num, cycle_stage FROM reminders').get() as any;
    expect(rowCycle2).toEqual({ cycle_num: 2, cycle_stage: 'ringing' });

    t += 60_001;
    runTick(t);
    t += 120_001;
    runTick(t);

    const finalRow = db.prepare('SELECT active, cycle_stage FROM reminders').get() as any;
    expect(finalRow.active).toBe(0);
    expect(finalRow.cycle_stage).toBe('done');
    const doneEvt = events.find((e) => e.type === 'reminder_done');
    expect(doneEvt).toBeTruthy();
  });

  it('daily reminder: after done, next_fire rolls to tomorrow and returns to idle', () => {
    const store = createReminderStore({ db, now: () => t0 });
    const d = new Date(t0);
    const schedule: Schedule = {
      kind: 'daily',
      hour: d.getHours(),
      minute: (d.getMinutes() + 1) % 60,
    };
    store.create('daily', schedule);

    let t = t0 + 60_000 + 1000;
    for (let i = 0; i < 10; i++) {
      runTick(t);
      t += 60_001;
    }
    const row = db.prepare('SELECT * FROM reminders').get() as any;
    expect(row.active).toBe(1);
    expect(row.cycle_stage).toBe('idle');
    expect(row.next_fire_at_ms).toBeGreaterThan(t);
  });

  it('is idempotent on restart: stale ringing row advances on next tick', () => {
    const staleEnd = t0 - 1000;
    db.prepare(`
      INSERT INTO reminders (text, schedule_json, next_fire_at_ms, cycle_stage, cycle_num, cycle_stage_ends_at_ms, active, created_at)
      VALUES (?, ?, ?, 'ringing', 0, ?, 1, ?)
    `).run('crashed', JSON.stringify({ kind: 'once', at_iso: new Date(t0 - 60_000).toISOString() }), t0 - 60_000, staleEnd, t0 - 60_000);

    runTick(t0);

    const row = db.prepare('SELECT cycle_stage FROM reminders').get() as any;
    expect(row.cycle_stage).toBe('paused');
  });
});
