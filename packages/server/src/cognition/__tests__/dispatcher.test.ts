import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db.js';
import { createCognitionStore } from '../store.js';
import { createHandlerRegistry } from '../registry.js';
import { createDispatcher } from '../dispatcher.js';
import type { Handler } from '../types.js';

beforeEach(() => initDb(':memory:'));

function fakeQueue() {
  const enqueued: string[] = [];
  return {
    queue: {
      enqueue: (job: { handlerName: string }) => enqueued.push(job.handlerName),
      size: () => enqueued.length,
      start: vi.fn(),
      stop: vi.fn(),
    },
    enqueued,
  };
}

describe('Dispatcher', () => {
  it('enqueues only triggered handlers', async () => {
    const store = createCognitionStore({ db: getDb() });
    const registry = createHandlerRegistry();
    registry.register({ name: 'on', trigger: () => true, run: async () => ({ skip: true, reason: '' }) });
    registry.register({ name: 'off', trigger: () => false, run: async () => ({ skip: true, reason: '' }) });
    const { queue, enqueued } = fakeQueue();
    const d = createDispatcher({ registry, queue, store });
    await d.runTick(1000);
    expect(enqueued).toEqual(['on']);
  });

  it('passes HandlerState (now, lastFiredAt, lastResult) to trigger', async () => {
    const store = createCognitionStore({ db: getDb() });
    store.recordHandlerRun({
      handlerName: 'h',
      firedAt: 50,
      durationMs: 0,
      result: { skip: true, reason: 'r' },
    });
    const seen: any[] = [];
    const registry = createHandlerRegistry();
    registry.register({
      name: 'h',
      trigger: (s) => { seen.push(s); return false; },
      run: async () => ({ skip: true, reason: '' }),
    });
    const { queue } = fakeQueue();
    const d = createDispatcher({ registry, queue, store });
    await d.runTick(2000);
    expect(seen[0]).toMatchObject({
      now: 2000,
      lastFiredAt: 50,
      lastResult: { skip: true, reason: 'r' },
    });
  });

  it('trigger throw does not break the loop', async () => {
    const store = createCognitionStore({ db: getDb() });
    const registry = createHandlerRegistry();
    registry.register({ name: 'bad', trigger: () => { throw new Error('x'); }, run: async () => ({ skip: true, reason: '' }) });
    registry.register({ name: 'good', trigger: () => true, run: async () => ({ skip: true, reason: '' }) });
    const { queue, enqueued } = fakeQueue();
    const d = createDispatcher({ registry, queue, store });
    await d.runTick(1000);
    expect(enqueued).toEqual(['good']);
  });
});
