import type { Dispatcher } from './dispatcher.js';
import type { CognitionStore } from './store.js';

export const HEARTBEAT_TICK_MS = 60_000;

interface Deps {
  dispatcher: Dispatcher;
  store: CognitionStore;
}

export function startHeartbeat(deps: Deps): { stop(): void } {
  // Re-entrancy guard: setInterval fires on schedule regardless of whether
  // the prior tick's dispatcher work has resolved. Under DB contention a
  // slow tick could overlap itself, iterating the registry concurrently.
  let inTick = false;
  const tick = async () => {
    if (inTick) return;
    inTick = true;
    try {
      const now = Date.now();
      if (deps.store.isPaused()) return;
      deps.store.recordTick(now);
      await deps.dispatcher.runTick(now);
    } catch (err) {
      console.error('[cognition] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      inTick = false;
    }
  };
  const timer = setInterval(tick, HEARTBEAT_TICK_MS);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
