import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { ReminderStore } from './store.js';
import type { ReminderPushEvent } from './bus.js';

const MAX_CYCLES = 3;
export const SCHEDULER_TICK_MS = 15_000;

interface AdvanceParams {
  store: ReminderStore;
  db: Database.Database;
  now: number;
  bus: EventEmitter;
}

export function advanceScheduler(params: AdvanceParams): void {
  const { store, db, now, bus } = params;

  for (const r of store.findDueIdle(now)) {
    store.beginRing(r.id, now);
    persistChatMessage(db, `⏰ ${r.text}`, now);
    emit(bus, { type: 'reminder_ring', id: r.id, text: r.text });
  }

  for (const r of store.findDueRinging(now)) {
    store.advanceRingingToPaused(r.id, now);
    emit(bus, { type: 'reminder_stop_ring', id: r.id });
  }

  for (const r of store.findDuePaused(now)) {
    if (r.cycle_num + 1 < MAX_CYCLES) {
      store.advancePausedToRinging(r.id, now);
      emit(bus, { type: 'reminder_ring', id: r.id, text: r.text });
    } else {
      store.finishCycle(r.id, now);
      persistChatMessage(db, `⏰ пропущено: ${r.text}`, now);
      emit(bus, { type: 'reminder_done', id: r.id });
    }
  }
}

function emit(bus: EventEmitter, event: ReminderPushEvent): void {
  bus.emit('push', event);
}

function persistChatMessage(db: Database.Database, content: string, now: number): void {
  db.prepare(`
    INSERT INTO chat_messages (message_id, role, content, timestamp, source)
    VALUES (?, 'assistant', ?, ?, 'claude')
  `).run(crypto.randomUUID(), content, now);
}

export function startScheduler(params: {
  store: ReminderStore;
  db: Database.Database;
  bus: EventEmitter;
}): () => void {
  const timer = setInterval(() => {
    try {
      advanceScheduler({ store: params.store, db: params.db, now: Date.now(), bus: params.bus });
    } catch (err) {
      console.error('[reminder] scheduler tick failed:', err instanceof Error ? err.message : err);
    }
  }, SCHEDULER_TICK_MS);
  return () => clearInterval(timer);
}
