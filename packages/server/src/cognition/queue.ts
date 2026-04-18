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
  stop(): Promise<void>;
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
  let currentAc: AbortController | null = null;
  let currentHandler: string | null = null;

  async function pump(): Promise<void> {
    while (running && jobs.length > 0) {
      const job = jobs.shift()!;
      const handler = registry.get(job.handlerName);
      if (!handler) continue;

      currentHandler = handler.name;
      const ac = new AbortController();
      currentAc = ac;
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const startedAt = Date.now();
      let result: HandlerResult;
      try {
        // Race the handler against the abort signal so workerTimeoutMs
        // actually terminates stuck handlers instead of being advisory.
        // Handlers that honor ctx.signal still finalize their own state.
        const abortPromise = new Promise<never>((_, reject) => {
          if (ac.signal.aborted) {
            reject(new Error('handler aborted'));
            return;
          }
          ac.signal.addEventListener('abort', () => reject(new Error('handler aborted')), {
            once: true,
          });
        });
        result = await Promise.race([
          handler.run({ db: store.db, signal: ac.signal, firedAt: startedAt }),
          abortPromise,
        ]);
      } catch (err) {
        result = { error: true, message: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
        currentAc = null;
        currentHandler = null;
      }

      // Don't persist or emit after stop(): the DB may be closing and bus
      // subscribers (Discord bot) may be torn down.
      if (!running) break;

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
      // Deduplicate: skip if the same handler is already in-flight or queued.
      // Without this, a handler that runs longer than the heartbeat interval
      // (60s) gets re-enqueued on every subsequent tick — `lastFiredAt` in
      // trigger state only updates after run() completes — and the backlog
      // fires extra runs back-to-back once the slow run finishes.
      if (currentHandler === job.handlerName) return;
      if (jobs.some((j) => j.handlerName === job.handlerName)) return;
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
    async stop() {
      running = false;
      currentAc?.abort();
      try {
        await inFlight;
      } catch {
        // inFlight errors are already logged by the enqueue catch handler;
        // stop() must still resolve so callers can finalize shutdown.
      }
    },
  };
}
