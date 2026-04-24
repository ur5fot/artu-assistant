import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { initDb, getDb } from '../../db.js';
import { createCognitionService } from '../service.js';
import type { Handler } from '../types.js';

beforeEach(() => initDb(':memory:'));

const noop: Handler = {
  name: 'noop',
  trigger: () => false,
  run: async () => ({ skip: true, reason: '' }),
};

describe('CognitionService', () => {
  it('register adds a handler that shows up in status.handlers', () => {
    const svc = createCognitionService({ db: getDb(), bus: new EventEmitter() });
    svc.register(noop);
    expect(svc.status().handlers).toEqual(['noop']);
  });

  it('pause flips status.paused and resume clears it', () => {
    const svc = createCognitionService({ db: getDb(), bus: new EventEmitter() });
    expect(svc.status().paused).toBe(false);
    svc.pause();
    expect(svc.status().paused).toBe(true);
    svc.resume();
    expect(svc.status().paused).toBe(false);
  });

  it('status reports queueSize, lastTickAt, ticks24h, recentRuns', () => {
    const svc = createCognitionService({ db: getDb(), bus: new EventEmitter() });
    const s = svc.status();
    expect(s).toMatchObject({
      paused: false,
      lastTickAt: null,
      ticks24h: 0,
      queueSize: 0,
      handlers: [],
      recentRuns: [],
    });
  });

  it('markPublished delegates to store', () => {
    const svc = createCognitionService({ db: getDb(), bus: new EventEmitter() });
    const id = (getDb()
      .prepare(
        `INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome, content)
         VALUES (?, ?, ?, 'publish', ?)`,
      )
      .run('x', 1, 0, 'c').lastInsertRowid as bigint | number);
    svc.markPublished(Number(id), 9999);
    const row = getDb()
      .prepare('SELECT published_at FROM cognition_handler_runs WHERE id = ?')
      .get(Number(id)) as { published_at: number };
    expect(row.published_at).toBe(9999);
  });

});
