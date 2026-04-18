import type { EventEmitter } from 'node:events';
import type { CognitionStore } from './store.js';
import type { HandlerRegistry } from './registry.js';
import type { HandlerResult } from './types.js';

export interface Job {
  handlerName: string;
}

export interface JobQueue {
  enqueue(job: Job): void;
  size(): number;
  start(): void;
  stop(): void;
}

interface Deps {
  registry: HandlerRegistry;
  store: CognitionStore;
  bus: EventEmitter;
  workerTimeoutMs?: number;
}

export function createJobQueue(deps: Deps): JobQueue {
  const { registry, store, bus } = deps;
  const timeoutMs = deps.workerTimeoutMs ?? 60_000;
  const jobs: Job[] = [];
  let running = false;
  let inFlight: Promise<void> = Promise.resolve();

  async function pump(): Promise<void> {
    while (running && jobs.length > 0) {
      const job = jobs.shift()!;
      const handler = registry.get(job.handlerName);
      if (!handler) continue;

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const startedAt = Date.now();
      let result: HandlerResult;
      try {
        result = await handler.run({ db: store.db, signal: ac.signal });
      } catch (err) {
        result = { error: true, message: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }

      const runId = store.recordHandlerRun({
        handlerName: handler.name,
        firedAt: startedAt,
        durationMs: Date.now() - startedAt,
        result,
      });

      if ('publish' in result && result.publish) {
        bus.emit('push', {
          type: 'cognition_publish',
          runId,
          handler: handler.name,
          content: result.content,
        });
      }
    }
  }

  return {
    enqueue(job) {
      jobs.push(job);
      if (running) {
        inFlight = inFlight
          .then(pump)
          .catch((err) =>
            console.error('[cognition] worker error:', err instanceof Error ? err.message : err),
          );
      }
    },
    size: () => jobs.length,
    start() {
      running = true;
      inFlight = pump();
    },
    stop() {
      running = false;
    },
  };
}
