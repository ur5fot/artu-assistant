import type { WindowHistoryStore } from './window-history-store.js';
import type { WindowSnapshotProvider } from './window-snapshot.js';
import type { IdleSource } from './idle-source.js';
import type { PresenceStore } from './presence-store.js';

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
  /** System input-idle signal. When omitted, away-detection is disabled and
   *  every tick is treated as active (current behavior). */
  idleSource?: IdleSource;
  /** Persists finalized away spans on return-to-active. */
  presence?: PresenceStore;
  /** Idle seconds at or above which the user counts as "away". Away-detection
   *  runs only when idleSource and a positive threshold are both present. */
  idleThresholdSec?: number;
}

export function startWindowLogger(params: StartWindowLoggerParams): () => void {
  const {
    store,
    provider,
    intervalMs,
    onError,
    blindAlertAfter,
    onBlind,
    onRecover,
    idleSource,
    presence,
    idleThresholdSec,
  } = params;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Away state machine: a single field holds the (back-dated) start of the
  // current away span, or null while the user is active. Enabled only when an
  // idle source and a positive threshold are wired in; otherwise every tick is
  // active and this stays inert (backward-compat).
  const awayEnabled = !!idleSource && idleThresholdSec != null && idleThresholdSec > 0;
  let awayStartedAt: number | null = null;
  // Last tick we observed the user active — clamps the back-dated away start so
  // a large HIDIdleTime can't push an away span before the user was last seen.
  let lastActiveAt: number | null = null;

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

    const now = Date.now();

    // Away-detection is a separate axis from blindness: it reads the input-idle
    // signal, never the provider. A failure here resolves to "active" and must
    // not touch consecutiveBlind — losing the idle signal is not losing eyes.
    let away = false;
    if (awayEnabled) {
      let idleSec: number | null = null;
      try {
        idleSec = await idleSource!.getIdleSeconds();
      } catch {
        idleSec = null;
      }
      away = idleSec != null && idleSec >= idleThresholdSec!;
      if (away) {
        // Entering (or staying) away: back-date the span start to when idleness
        // actually began, but never before the user was last seen active.
        if (awayStartedAt == null) {
          const backDated = now - idleSec! * 1000;
          awayStartedAt = lastActiveAt != null ? Math.max(backDated, lastActiveAt) : backDated;
        }
      } else {
        // Returning to active: close the open away span (if any) and reset.
        if (awayStartedAt != null) {
          safely(() => presence?.recordAway(awayStartedAt as number, now));
          awayStartedAt = null;
        }
        lastActiveAt = now;
      }
    }

    // Persist outside the blind-detection path: a recordSample() throw (locked/
    // full/corrupt DB) means we DID get a snapshot — the observer is NOT blind.
    // Route it through onError so it never inflates consecutiveBlind or fires
    // the "lost macOS Automation permission" alert (wrong remediation).
    // Skip while away: a focused-but-idle window (e.g. overnight YouTube) is not
    // activity and must not be stitched into the active session.
    if (snap && !away) {
      try {
        store.recordSample({ ...snap, sampled_at: now });
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
