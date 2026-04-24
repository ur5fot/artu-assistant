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
    const slowA: Handler = {
      name: 'slowA',
      trigger: () => true,
      run: () => new Promise((resolve) => setTimeout(() => resolve({ skip: true, reason: '' }), 100)),
    };
    const slowB: Handler = {
      name: 'slowB',
      trigger: () => true,
      run: () => new Promise((resolve) => setTimeout(() => resolve({ skip: true, reason: '' }), 100)),
    };
    const { store, registry, bus } = setup([slowA, slowB]);
    const q = createJobQueue({ registry, store, bus });
    q.enqueue({ handlerName: 'slowA' });
    q.enqueue({ handlerName: 'slowB' });
    // Queue is not started yet: neither job has been shifted.
    expect(q.size()).toBe(2);
    await q.stop();
  });

  it('dedupes repeated enqueues of the same handler while one is pending or in-flight', async () => {
    let release!: () => void;
    const slow: Handler = {
      name: 'slow',
      trigger: () => true,
      run: () =>
        new Promise((resolve) => {
          release = () => resolve({ skip: true, reason: 'done' });
        }),
    };
    const { store, registry, bus } = setup([slow]);
    const q = createJobQueue({ registry, store, bus });
    q.enqueue({ handlerName: 'slow' });
    q.enqueue({ handlerName: 'slow' });
    // Second enqueue while the first is still queued must be dropped.
    expect(q.size()).toBe(1);
    q.start();
    // Let the worker shift the job and begin awaiting run().
    await new Promise((r) => setImmediate(r));
    // Now the handler is in-flight: further enqueues must still be dropped.
    q.enqueue({ handlerName: 'slow' });
    expect(q.size()).toBe(0);
    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Exactly one run recorded despite three enqueue attempts.
    expect(store.recentRuns(5).filter((r) => r.handlerName === 'slow').length).toBe(1);
    await q.stop();
  });

  it('workerTimeoutMs aborts a stuck handler so the worker records an error and continues', async () => {
    const stuck: Handler = {
      name: 'stuck',
      trigger: () => true,
      // Intentionally never resolves — only the abort-race can break the
      // worker out, proving the timeout actually terminates the await.
      run: () => new Promise(() => {}),
    };
    const after: Handler = {
      name: 'after',
      trigger: () => true,
      run: async () => ({ skip: true, reason: 'next' }),
    };
    const { store, registry, bus } = setup([stuck, after]);
    const q = createJobQueue({ registry, store, bus, workerTimeoutMs: 20 });
    q.start();
    q.enqueue({ handlerName: 'stuck' });
    q.enqueue({ handlerName: 'after' });
    // Wait long enough for the 20ms abort to fire and the worker to move on.
    await new Promise((r) => setTimeout(r, 80));
    const runs = store.recentRuns(2);
    const stuckRow = runs.find((r) => r.handlerName === 'stuck');
    const afterRow = runs.find((r) => r.handlerName === 'after');
    expect(stuckRow?.outcome).toBe('error');
    expect(stuckRow?.reason).toContain('abort');
    expect(afterRow?.outcome).toBe('skip');
    await q.stop();
  });

  it('firePublished invokes the run-local onPublished callback exactly once', async () => {
    let publishedFired = 0;
    const handler: Handler = {
      name: 'h',
      trigger: () => true,
      run: async () => ({
        publish: true,
        content: 'x',
        onPublished: () => { publishedFired += 1; },
      }),
    };
    const { store, registry, bus, events } = setup([handler]);
    const q = createJobQueue({ registry, store, bus });
    q.start();
    q.enqueue({ handlerName: 'h' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const ev = events.find((e) => e.type === 'cognition_publish');
    expect(ev).toBeDefined();
    // Before firePublished: side-effect must not have run. Pre-firing the
    // callback is what protects downstream DB state (e.g. email_pending)
    // from being marked on a run whose DM actually failed.
    expect(publishedFired).toBe(0);
    q.firePublished(ev.runId);
    await new Promise((r) => setImmediate(r));
    expect(publishedFired).toBe(1);
    // Idempotent: subsequent fires are no-ops (the callback was cleared).
    q.firePublished(ev.runId);
    await new Promise((r) => setImmediate(r));
    expect(publishedFired).toBe(1);
    await q.stop();
  });

  it('stop awaits in-flight pump and skips recording after stop', async () => {
    let release!: () => void;
    const slow: Handler = {
      name: 'slow',
      trigger: () => true,
      run: () =>
        new Promise((resolve) => {
          release = () => resolve({ skip: true, reason: 'released' });
        }),
    };
    const { store, registry, bus } = setup([slow]);
    const q = createJobQueue({ registry, store, bus });
    q.start();
    q.enqueue({ handlerName: 'slow' });
    // Let the worker shift the job and reach the await on run().
    await new Promise((r) => setImmediate(r));
    const stopP = q.stop();
    // With stop set running=false then aborting the current AC, the handler
    // resolves via abort handler but the worker must NOT record or emit.
    await stopP;
    // Release the handler anyway — stop() should already have returned.
    release();
    await new Promise((r) => setImmediate(r));
    expect(store.recentRuns(1)).toEqual([]);
  });
});
