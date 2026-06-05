import { isTransientNetworkError } from './transient-error.js';

export type FatalSignalKind = 'uncaughtException' | 'unhandledRejection';

export interface FatalSignalDeps {
  /** Real `process.exit` in prod; a spy in tests. Called only for fatal errors. */
  onExit: (code: number) => void;
  /** Structured logger: `log('warn'|'error', msg, err)`. */
  log: (level: 'warn' | 'error', msg: string, err: unknown) => void;
}

/**
 * Pure handler for top-level process faults.
 *
 * Transient network blips (flapping VPN/DNS, raw `ws` handshake timeouts) are
 * logged as warnings and swallowed — the worker keeps running and reconnect
 * logic recovers. Everything else is a real fault: log + `onExit(1)` so the
 * supervisor restarts us cleanly instead of leaving a wedged process.
 */
export function handleFatalSignal(
  kind: FatalSignalKind,
  err: unknown,
  { onExit, log }: FatalSignalDeps,
): void {
  if (isTransientNetworkError(err)) {
    log('warn', `[net] transient ${kind} — staying alive`, err);
    return;
  }
  log('error', `[net] fatal ${kind} — exiting for supervisor restart`, err);
  onExit(1);
}
