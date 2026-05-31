import type { WindowHistoryStore } from './window-history-store.js';
import type { WindowSnapshotProvider } from './window-snapshot.js';

export interface StartWindowLoggerParams {
  store: WindowHistoryStore;
  provider: WindowSnapshotProvider;
  intervalMs: number;
  onError?: (err: unknown) => void;
  /** Consecutive blind ticks (null/timeout/throw) before firing onBlind. */
  blindAlertAfter?: number;
  /** Called exactly once when consecutiveBlind === blindAlertAfter. */
  onBlind?: (info: { consecutive: number }) => void;
  /** Called once on the first good sample after an alert has fired. */
  onRecover?: (info: { blindFor: number }) => void;
}

export function startWindowLogger(params: StartWindowLoggerParams): () => void {
  const { store, provider, intervalMs, onError, blindAlertAfter, onBlind, onRecover } = params;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Blind-detection: count consecutive ticks that produced no snapshot (null
  // OR throw). The real failure mode is osascript returning null after
  // sleep/wake, so onError (throw-only) cannot catch it — we count both.
  let consecutiveBlind = 0;
  let alerted = false;

  // A throwing callback must never kill the poller: it runs before the next
  // tick is scheduled, so an uncaught throw would skip the reschedule and stop
  // sampling silently — the exact failure this observer exists to detect.
  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* swallow — a broken callback must not stop the loop */
    }
  };

  // Self-scheduling loop: the next tick is only queued once the current one
  // resolves, mirroring multi-account-poller. setInterval would fire
  // concurrently if a tick (osascript) runs longer than intervalMs.
  const runOnce = async () => {
    if (stopped) return;
    let blind = false;
    let snap: Awaited<ReturnType<WindowSnapshotProvider['getActive']>> = null;
    // Blindness is strictly a provider problem: getActive() returning null OR
    // throwing means the observer has no eyes (osascript lost Automation
    // permission after sleep/wake). A storage write is a separate concern.
    try {
      snap = await provider.getActive();
      if (!snap) blind = true;
    } catch (err) {
      blind = true;
      safely(() => onError?.(err));
    }

    // Persist outside the blind-detection path: a recordSample() throw (locked/
    // full/corrupt DB) means we DID get a snapshot — the observer is NOT blind.
    // Route it through onError so it never inflates consecutiveBlind or fires
    // the "lost macOS Automation permission" alert (wrong remediation).
    if (snap) {
      try {
        store.recordSample({ ...snap, sampled_at: Date.now() });
      } catch (err) {
        safely(() => onError?.(err));
      }
    }

    if (blind) {
      consecutiveBlind += 1;
      if (blindAlertAfter != null && blindAlertAfter > 0 && consecutiveBlind === blindAlertAfter) {
        // Fires exactly once per streak: the counter grows monotonically, so
        // equality holds for a single tick.
        alerted = true;
        safely(() => onBlind?.({ consecutive: consecutiveBlind }));
      }
    } else {
      if (alerted) {
        safely(() => onRecover?.({ blindFor: consecutiveBlind }));
        alerted = false;
      }
      consecutiveBlind = 0;
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
