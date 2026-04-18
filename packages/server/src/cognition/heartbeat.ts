import type { Dispatcher } from './dispatcher.js';
import type { CognitionStore } from './store.js';

export const HEARTBEAT_TICK_MS = 60_000;

interface Deps {
  dispatcher: Dispatcher;
  store: CognitionStore;
}

export function startHeartbeat(deps: Deps): { stop(): void } {
  const tick = async () => {
    const now = Date.now();
    try {
      if (deps.store.isPaused()) return;
      deps.store.recordTick(now);
      await deps.dispatcher.runTick(now);
    } catch (err) {
      console.error('[cognition] tick failed:', err instanceof Error ? err.message : err);
    }
  };
  const timer = setInterval(tick, HEARTBEAT_TICK_MS);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
