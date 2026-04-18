import type Database from 'better-sqlite3';
import type { CognitionStore } from './store.js';
import type { HandlerRegistry } from './registry.js';
import type { JobQueue } from './queue.js';
import type { HandlerState, TriggerContext } from './types.js';

export interface Dispatcher {
  runTick(now: number): Promise<void>;
}

interface Deps {
  registry: HandlerRegistry;
  queue: JobQueue;
  store: CognitionStore;
  db: Database.Database;
}

export function createDispatcher(deps: Deps): Dispatcher {
  const { registry, queue, store, db } = deps;
  const ctx: TriggerContext = { db };
  return {
    async runTick(now) {
      for (const handler of registry.list()) {
        const state: HandlerState = {
          now,
          lastFiredAt: store.getLastFiredAt(handler.name),
          lastResult: store.getLastResult(handler.name),
        };
        let triggered = false;
        try {
          triggered = await handler.trigger(state, ctx);
        } catch (err) {
          console.error(
            `[cognition] trigger ${handler.name} threw:`,
            err instanceof Error ? err.message : err,
          );
        }
        if (triggered) queue.enqueue({ handlerName: handler.name });
      }
    },
  };
}
