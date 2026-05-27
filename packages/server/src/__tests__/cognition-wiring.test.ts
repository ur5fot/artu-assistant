import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { initDb, getDb } from '../db.js';
import { createCognitionStore } from '../cognition/store.js';
import { createHandlerRegistry } from '../cognition/registry.js';
import { createJobQueue } from '../cognition/queue.js';
import { createDispatcher } from '../cognition/dispatcher.js';
import { createEmailStore } from '../emails/store.js';
import { createEmailUrgentHandler } from '../cognition/handlers/emailUrgent.js';

beforeEach(() => initDb(':memory:'));

const TZ = 'Europe/Kyiv';
// 12:00 Kyiv (UTC+3) — outside the default 22:00 quiet window.
const NOON_KYIV = Date.UTC(2026, 3, 24, 12 - 3);

async function flush() {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
}

describe('emailUrgent cognition wiring', () => {
  it('triggers on tick, emits cognition_publish, and marks urgent_pinged_at after firePublished', async () => {
    const db = getDb();
    const store = createCognitionStore({ db });
    const registry = createHandlerRegistry();
    const bus = new EventEmitter();
    const events: any[] = [];
    bus.on('push', (e) => events.push(e));
    const queue = createJobQueue({ registry, store, bus });
    const dispatcher = createDispatcher({ registry, queue, store, db });

    const emailStore = createEmailStore({ db });
    registry.register(
      createEmailUrgentHandler({ store: emailStore, tz: TZ, quietStart: 22 }),
    );

    db.prepare(
      `INSERT INTO email_pending
        (account_id, message_uid, from_addr, subject, snippet, importance, received_at, added_at)
       VALUES ('a', 1, 'boss@acme.com', 'Server down', 'Prod is on fire', 5, ?, ?)`,
    ).run(NOON_KYIV - 60_000, NOON_KYIV - 60_000);

    queue.start();
    await dispatcher.runTick(NOON_KYIV);
    await flush();

    const ev = events.find((e) => e.type === 'cognition_publish');
    expect(ev).toBeDefined();
    expect(ev.handler).toBe('emailUrgent');
    expect(typeof ev.runId).toBe('number');
    expect(ev.content).toContain('boss@acme.com');
    expect(ev.content).toContain('Server down');

    // Row should still be unpinged until firePublished runs the onPublished
    // callback — that gate is the whole reason we hard-require Discord.
    const before = db
      .prepare('SELECT urgent_pinged_at FROM email_pending WHERE id = 1')
      .get() as { urgent_pinged_at: number | null };
    expect(before.urgent_pinged_at).toBeNull();

    queue.firePublished(ev.runId);
    await flush();

    const after = db
      .prepare('SELECT urgent_pinged_at FROM email_pending WHERE id = 1')
      .get() as { urgent_pinged_at: number | null };
    expect(after.urgent_pinged_at).not.toBeNull();
    expect(typeof after.urgent_pinged_at).toBe('number');

    await queue.stop();
  });

  it('does not trigger when no importance=5 row exists', async () => {
    const db = getDb();
    const store = createCognitionStore({ db });
    const registry = createHandlerRegistry();
    const bus = new EventEmitter();
    const events: any[] = [];
    bus.on('push', (e) => events.push(e));
    const queue = createJobQueue({ registry, store, bus });
    const dispatcher = createDispatcher({ registry, queue, store, db });

    const emailStore = createEmailStore({ db });
    registry.register(
      createEmailUrgentHandler({ store: emailStore, tz: TZ, quietStart: 22 }),
    );

    db.prepare(
      `INSERT INTO email_pending
        (account_id, message_uid, from_addr, subject, snippet, importance, received_at, added_at)
       VALUES ('a', 1, 'x@y.com', 's', '', 4, ?, ?)`,
    ).run(NOON_KYIV - 60_000, NOON_KYIV - 60_000);

    queue.start();
    await dispatcher.runTick(NOON_KYIV);
    await flush();

    expect(events.find((e) => e.type === 'cognition_publish')).toBeUndefined();
    await queue.stop();
  });
});
