import type { WindowHistoryStore } from './window-history-store.js';
import type { WindowSnapshotProvider } from './window-snapshot.js';

export interface StartWindowLoggerParams {
  store: WindowHistoryStore;
  provider: WindowSnapshotProvider;
  intervalMs: number;
  onError?: (err: unknown) => void;
}

export function startWindowLogger(params: StartWindowLoggerParams): () => void {
  const { store, provider, intervalMs, onError } = params;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Self-scheduling loop: the next tick is only queued once the current one
  // resolves, mirroring multi-account-poller. setInterval would fire
  // concurrently if a tick (osascript) runs longer than intervalMs.
  const runOnce = async () => {
    if (stopped) return;
    try {
      const snap = await provider.getActive();
      if (snap) {
        store.recordSample({ ...snap, sampled_at: Date.now() });
      }
    } catch (err) {
      onError?.(err);
    }
    if (!stopped) {
      timer = setTimeout(runOnce, intervalMs);
    }
  };
  void runOnce();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
