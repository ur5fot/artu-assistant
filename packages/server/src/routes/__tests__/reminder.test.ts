import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { createReminderRouter } from '../reminder.js';
import { createReminderStore } from '../../reminders/store.js';
import { reminderBus } from '../../reminders/bus.js';

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
  `);
  return db;
}

async function post(app: express.Express, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = {
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/json' },
      body,
    };
    const res: any = {
      statusCode: 200,
      setHeader: () => {},
      status(code: number) { res.statusCode = code; return res; },
      json(obj: any) { resolve({ status: res.statusCode, body: obj }); return res; },
      send(data: any) { resolve({ status: res.statusCode, body: data }); return res; },
    };
    (app as any).handle(req, res);
  });
}

describe('reminder routes', () => {
  let db: Database.Database;
  let app: express.Express;

  beforeEach(() => {
    db = freshDb();
    const store = createReminderStore({ db });
    app = express();
    app.use(express.json());
    app.use('/api/reminder', createReminderRouter({ store, bus: reminderBus }));
  });

  it('POST /api/reminder/dismiss returns ok for an existing reminder', async () => {
    const store = createReminderStore({ db });
    const id = store.create('drink', { kind: 'once', at_iso: new Date(Date.now() + 60_000).toISOString() });
    store.beginRing(id, Date.now());
    const res = await post(app, '/api/reminder/dismiss', { id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const row = db.prepare('SELECT active FROM reminders WHERE id = ?').get(id) as any;
    expect(row.active).toBe(0);
  });

  it('POST /api/reminder/dismiss 400 when body missing id', async () => {
    const res = await post(app, '/api/reminder/dismiss', {});
    expect(res.status).toBe(400);
  });

  it('POST /api/reminder/snooze creates a new one-shot 10 minutes out', async () => {
    const store = createReminderStore({ db });
    const id = store.create('drink', { kind: 'daily', hour: 9, minute: 0 });
    store.beginRing(id, Date.now());
    const res = await post(app, '/api/reminder/snooze', { id });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.newId).toBe('number');
    const rows = db.prepare('SELECT id, schedule_json FROM reminders').all() as any[];
    expect(rows).toHaveLength(2);
    const snoozed = rows.find((r) => r.id !== id)!;
    expect(JSON.parse(snoozed.schedule_json).kind).toBe('once');
  });
});
