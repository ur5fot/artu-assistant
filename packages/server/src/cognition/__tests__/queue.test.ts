import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { initDb, getDb } from '../../db.js';
import { createCognitionStore } from '../store.js';
import { createHandlerRegistry } from '../registry.js';
import { createJobQueue } from '../queue.js';
import type { Handler } from '../types.js';

function setup(handlers: Handler[]) {
  initDb(':memory:');
  const store = createCognitionStore({ db: getDb() });
  const registry = createHandlerRegistry();
  for (const h of handlers) registry.register(h);
  const bus = new EventEmitter();
  const events: any[] = [];
  bus.on('push', (e) => events.push(e));
  return { store, registry, bus, events };
}

describe('JobQueue', () => {
  it('processes a job and persists skip outcome', async () => {
    const handler: Handler = {
      name: 'h',
      trigger: () => true,
      run: async () => ({ skip: true, reason: 'noop' }),
    };
    const { store, registry, bus } = setup([handler]);
    const q = createJobQueue({ registry, store, bus });
    q.start();
    q.enqueue({ handlerName: 'h' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(store.recentRuns(1)[0]).toMatchObject({ handlerName: 'h', outcome: 'skip', reason: 'noop' });
    q.stop();
  });

  it('emits cognition_publish when handler returns publish', async () => {
    const handler: Handler = {
      name: 'h',
      trigger: () => true,
      run: async () => ({ publish: true, content: 'hello' }),
    };
    const { store, registry, bus, events } = setup([handler]);
    const q = createJobQueue({ registry, store, bus });
    q.start();
    q.enqueue({ handlerName: 'h' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const e = events.find((x) => x.type === 'cognition_publish');
    expect(e).toMatchObject({ handler: 'h', content: 'hello' });
    expect(typeof e.runId).toBe('number');
    q.stop();
  });

  it('handler error is captured and worker continues', async () => {
    const bad: Handler = {
      name: 'bad',
      trigger: () => true,
      run: async () => { throw new Error('boom'); },
    };
    const ok: Handler = {
      name: 'ok',
      trigger: () => true,
      run: async () => ({ skip: true, reason: 'fine' }),
    };
    const { store, registry, bus } = setup([bad, ok]);
    const q = createJobQueue({ registry, store, bus });
    q.start();
    q.enqueue({ handlerName: 'bad' });
    q.enqueue({ handlerName: 'ok' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const recent = store.recentRuns(2);
    const names = recent.map((r) => r.handlerName).sort();
    expect(names).toEqual(['bad', 'ok']);
    const badRow = recent.find((r) => r.handlerName === 'bad')!;
    expect(badRow.outcome).toBe('error');
    expect(badRow.reason).toContain('boom');
    q.stop();
  });

  it('size reflects queued jobs before processing', async () => {
    const slow: Handler = {
      name: 'slow',
      trigger: () => true,
      run: () => new Promise((resolve) => setTimeout(() => resolve({ skip: true, reason: '' }), 100)),
    };
    const { store, registry, bus } = setup([slow]);
    const q = createJobQueue({ registry, store, bus });
    q.start();
    q.enqueue({ handlerName: 'slow' });
    q.enqueue({ handlerName: 'slow' });
    expect(q.size()).toBeGreaterThan(0);
    q.stop();
  });
});
