import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { WorkerManager } from './worker-manager.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('WorkerManager', () => {
  let manager: WorkerManager;

  afterEach(() => {
    manager?.stop();
  });

  it('spawns worker and receives ready signal', async () => {
    // Use a small test script that sends ready immediately
    const testWorker = path.resolve(__dirname, '__fixtures__/mock-worker.ts');
    manager = new WorkerManager({ workerPath: testWorker, useTsx: true });

    const readyPromise = new Promise<void>((resolve) => {
      manager.on('worker_ready', () => resolve());
    });

    manager.start();
    await readyPromise;

    expect(manager.status).toBe('running');
  });

  it('emits worker_starting on start', () => {
    const testWorker = path.resolve(__dirname, '__fixtures__/mock-worker.ts');
    manager = new WorkerManager({ workerPath: testWorker, useTsx: true });

    const events: string[] = [];
    manager.on('worker_starting', () => events.push('starting'));

    manager.start();
    expect(events).toContain('starting');
  });

  it('emits worker_crashed when worker exits with non-zero code', async () => {
    const testWorker = path.resolve(__dirname, '__fixtures__/crash-worker.ts');
    manager = new WorkerManager({
      workerPath: testWorker,
      useTsx: true,
      maxCrashesInWindow: 10, // high limit so no pause
    });

    const crashPromise = new Promise<{ code: number | null; signal: string | null; statusAtCrash: string }>((resolve) => {
      manager.on('worker_crashed', (code, signal) => {
        const statusAtCrash = manager.status;
        resolve({ code, signal, statusAtCrash });
      });
    });

    manager.start();
    const result = await crashPromise;

    expect(result.code).toBe(1);
    expect(result.statusAtCrash).toBe('crashed');
  });

  it('does not auto-restart when stopped gracefully', async () => {
    const testWorker = path.resolve(__dirname, '__fixtures__/mock-worker.ts');
    manager = new WorkerManager({ workerPath: testWorker, useTsx: true });

    await new Promise<void>((resolve) => {
      manager.on('worker_ready', () => resolve());
      manager.start();
    });

    const restartEvents: string[] = [];
    manager.on('worker_restarting', () => restartEvents.push('restarting'));

    manager.stop();

    // Wait a bit to confirm no restart
    await new Promise((r) => setTimeout(r, 200));
    expect(restartEvents).toHaveLength(0);
  });
});
