import type Database from 'better-sqlite3';
import type { EventEmitter } from 'node:events';
import { createCognitionStore, type CognitionStore } from './store.js';
import { createHandlerRegistry, type HandlerRegistry } from './registry.js';
import { createJobQueue, type JobQueue } from './queue.js';
import { createDispatcher } from './dispatcher.js';
import { startHeartbeat } from './heartbeat.js';
import type { Handler, CognitionStatus } from './types.js';

export interface CognitionService {
  register(handler: Handler): void;
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  status(): CognitionStatus;
  markPublished(runId: number, publishedAt: number): void;
}

interface Deps {
  db: Database.Database;
  bus: EventEmitter;
  workerTimeoutMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createCognitionService(deps: Deps): CognitionService {
  const store: CognitionStore = createCognitionStore({ db: deps.db });
  const registry: HandlerRegistry = createHandlerRegistry();
  const queue: JobQueue = createJobQueue({
    registry,
    store,
    bus: deps.bus,
    workerTimeoutMs: deps.workerTimeoutMs,
  });
  const dispatcher = createDispatcher({ registry, queue, store });
  let heartbeat: { stop(): void } | null = null;

  return {
    register(handler) {
      registry.register(handler);
    },
    start() {
      queue.start();
      heartbeat = startHeartbeat({ dispatcher, store });
    },
    stop() {
      heartbeat?.stop();
      heartbeat = null;
      queue.stop();
    },
    pause() {
      store.pause(Date.now());
    },
    resume() {
      store.resume();
    },
    status() {
      const now = Date.now();
      return {
        paused: store.isPaused(),
        lastTickAt: store.getLastTickAt(),
        ticks24h: store.countTicksSince(now - DAY_MS),
        queueSize: queue.size(),
        handlers: registry.list().map((h) => h.name),
        recentRuns: store.recentRuns(10),
      };
    },
    markPublished(runId, publishedAt) {
      store.markPublished(runId, publishedAt);
    },
  };
}
