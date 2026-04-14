import type Database from 'better-sqlite3';
import type { Schedule } from '@r2/tool-reminder/src/schedule-types.js';
import { computeNextFire } from './recurrence.js';

export interface ReminderRow {
  id: number;
  text: string;
  schedule: Schedule;
  next_fire_at_ms: number;
  cycle_stage: 'idle' | 'ringing' | 'paused' | 'done';
  cycle_num: number;
  cycle_stage_ends_at_ms: number | null;
  active: boolean;
  created_at: number;
}

export interface ReminderStore {
  create(text: string, schedule: Schedule): number;
  list(): ReminderRow[];
  delete(id: number): boolean;
  findDueIdle(now: number): ReminderRow[];
  findDueRinging(now: number): ReminderRow[];
  findDuePaused(now: number): ReminderRow[];
  beginRing(id: number, now: number): void;
  advanceRingingToPaused(id: number, now: number): void;
  advancePausedToRinging(id: number, now: number): void;
  finishCycle(id: number, now: number): { nextFire: number | null };
  dismiss(id: number, now: number): void;
  snooze(id: number, now: number): number;
  getById(id: number): ReminderRow | null;
}

const RING_DURATION_MS = 60_000;
const PAUSE_DURATION_MS = 120_000;
const SNOOZE_DELAY_MS = 10 * 60_000;

interface StoreDeps {
  db: Database.Database;
  now?: () => number;
}

function rowToReminder(raw: any): ReminderRow {
  return {
    id: raw.id,
    text: raw.text,
    schedule: JSON.parse(raw.schedule_json),
    next_fire_at_ms: raw.next_fire_at_ms,
    cycle_stage: raw.cycle_stage,
    cycle_num: raw.cycle_num,
    cycle_stage_ends_at_ms: raw.cycle_stage_ends_at_ms,
    active: raw.active === 1,
    created_at: raw.created_at,
  };
}

export function createReminderStore(deps: StoreDeps): ReminderStore {
  const { db } = deps;
  const now = deps.now ?? (() => Date.now());

  return {
    create(text, schedule) {
      const nowMs = now();
      const nextFire = computeNextFire(schedule, nowMs);
      if (nextFire === null) {
        throw new Error('Reminder has no future fire time');
      }
      const stmt = db.prepare(`
        INSERT INTO reminders (text, schedule_json, next_fire_at_ms, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const result = stmt.run(text, JSON.stringify(schedule), nextFire, nowMs);
      return Number(result.lastInsertRowid);
    },

    list() {
      const rows = db.prepare(`
        SELECT * FROM reminders WHERE active = 1 ORDER BY next_fire_at_ms ASC
      `).all();
      return rows.map(rowToReminder);
    },

    delete(id) {
      const result = db.prepare(`
        UPDATE reminders SET active = 0 WHERE id = ? AND active = 1
      `).run(id);
      return result.changes > 0;
    },

    findDueIdle(nowMs) {
      const rows = db.prepare(`
        SELECT * FROM reminders
        WHERE active = 1 AND cycle_stage = 'idle' AND next_fire_at_ms <= ?
      `).all(nowMs);
      return rows.map(rowToReminder);
    },

    findDueRinging(nowMs) {
      const rows = db.prepare(`
        SELECT * FROM reminders
        WHERE active = 1 AND cycle_stage = 'ringing' AND cycle_stage_ends_at_ms <= ?
      `).all(nowMs);
      return rows.map(rowToReminder);
    },

    findDuePaused(nowMs) {
      const rows = db.prepare(`
        SELECT * FROM reminders
        WHERE active = 1 AND cycle_stage = 'paused' AND cycle_stage_ends_at_ms <= ?
      `).all(nowMs);
      return rows.map(rowToReminder);
    },

    beginRing(id, nowMs) {
      db.prepare(`
        UPDATE reminders
        SET cycle_stage = 'ringing',
            cycle_num = 0,
            cycle_stage_ends_at_ms = ?
        WHERE id = ?
      `).run(nowMs + RING_DURATION_MS, id);
    },

    advanceRingingToPaused(id, nowMs) {
      db.prepare(`
        UPDATE reminders
        SET cycle_stage = 'paused',
            cycle_stage_ends_at_ms = ?
        WHERE id = ?
      `).run(nowMs + PAUSE_DURATION_MS, id);
    },

    advancePausedToRinging(id, nowMs) {
      db.prepare(`
        UPDATE reminders
        SET cycle_stage = 'ringing',
            cycle_num = cycle_num + 1,
            cycle_stage_ends_at_ms = ?
        WHERE id = ?
      `).run(nowMs + RING_DURATION_MS, id);
    },

    finishCycle(id, nowMs) {
      const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
      if (!row) return { nextFire: null };
      const schedule = JSON.parse(row.schedule_json) as Schedule;
      const nextFire = computeNextFire(schedule, nowMs);
      if (nextFire === null || schedule.kind === 'once') {
        db.prepare(`
          UPDATE reminders
          SET active = 0,
              cycle_stage = 'done',
              cycle_num = 0,
              cycle_stage_ends_at_ms = NULL
          WHERE id = ?
        `).run(id);
        return { nextFire: null };
      }
      db.prepare(`
        UPDATE reminders
        SET cycle_stage = 'idle',
            cycle_num = 0,
            cycle_stage_ends_at_ms = NULL,
            next_fire_at_ms = ?
        WHERE id = ?
      `).run(nextFire, id);
      return { nextFire };
    },

    dismiss(id, nowMs) {
      const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
      if (!row) return;
      const schedule = JSON.parse(row.schedule_json) as Schedule;
      if (schedule.kind === 'once') {
        db.prepare(`
          UPDATE reminders
          SET active = 0,
              cycle_stage = 'done',
              cycle_stage_ends_at_ms = NULL
          WHERE id = ?
        `).run(id);
        return;
      }
      const nextFire = computeNextFire(schedule, nowMs);
      if (nextFire === null) {
        db.prepare('UPDATE reminders SET active = 0 WHERE id = ?').run(id);
        return;
      }
      db.prepare(`
        UPDATE reminders
        SET cycle_stage = 'idle',
            cycle_num = 0,
            cycle_stage_ends_at_ms = NULL,
            next_fire_at_ms = ?
        WHERE id = ?
      `).run(nextFire, id);
    },

    snooze(id, nowMs) {
      const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
      if (!row) throw new Error(`Reminder ${id} not found`);
      const originalSchedule = JSON.parse(row.schedule_json) as Schedule;
      const snoozedSchedule: Schedule = {
        kind: 'once',
        at_iso: new Date(nowMs + SNOOZE_DELAY_MS).toISOString(),
      };
      const result = db.prepare(`
        INSERT INTO reminders (text, schedule_json, next_fire_at_ms, created_at)
        VALUES (?, ?, ?, ?)
      `).run(
        row.text,
        JSON.stringify(snoozedSchedule),
        nowMs + SNOOZE_DELAY_MS,
        nowMs,
      );
      if (originalSchedule.kind === 'once') {
        db.prepare(`
          UPDATE reminders
          SET active = 0,
              cycle_stage = 'done',
              cycle_num = 0,
              cycle_stage_ends_at_ms = NULL
          WHERE id = ?
        `).run(id);
      } else {
        const nextFire = computeNextFire(originalSchedule, nowMs);
        if (nextFire === null) {
          db.prepare(`
            UPDATE reminders
            SET active = 0, cycle_stage = 'done', cycle_stage_ends_at_ms = NULL
            WHERE id = ?
          `).run(id);
        } else {
          db.prepare(`
            UPDATE reminders
            SET cycle_stage = 'idle',
                cycle_num = 0,
                cycle_stage_ends_at_ms = NULL,
                next_fire_at_ms = ?
            WHERE id = ?
          `).run(nextFire, id);
        }
      }
      return Number(result.lastInsertRowid);
    },

    getById(id) {
      const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
      return row ? rowToReminder(row) : null;
    },
  };
}
