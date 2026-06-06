import { execFile } from 'node:child_process';

/**
 * System input-idle signal. `getIdleSeconds` returns how many seconds since the
 * last user input (keyboard/mouse), or `null` when the signal is unavailable
 * (non-macOS, exec failure, unparseable output). The logger treats `null` as
 * "active" — away-detection is best-effort and never blocks the main loop.
 */
export interface IdleSource {
  getIdleSeconds(): Promise<number | null>;
}

/** Injectable exec for tests: returns stdout, or `null` on any failure. */
export type ExecRunner = (cmd: string, args: string[]) => Promise<string | null>;

export interface IoregIdleSourceOptions {
  timeoutMs?: number;
  /** Injectable exec runner (tests). Defaults to a real `ioreg` execFile. */
  exec?: ExecRunner;
}

const DEFAULT_TIMEOUT_MS = 5000;
const NS_PER_SEC = 1e9;

/**
 * Parse `HIDIdleTime` (nanoseconds) out of `ioreg -c IOHIDSystem` output and
 * return whole seconds. Returns `null` when the field is absent or the captured
 * value isn't a finite non-negative integer. The line looks like:
 *   "HIDIdleTime" = 12345678900
 */
export function parseIdleSeconds(raw: string): number | null {
  if (!raw) return null;
  const match = raw.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  if (!match) return null;
  const ns = Number(match[1]);
  if (!Number.isFinite(ns) || ns < 0) return null;
  return Math.round(ns / NS_PER_SEC);
}

export function createIoregIdleSource(opts: IoregIdleSourceOptions = {}): IdleSource {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exec: ExecRunner =
    opts.exec ??
    ((cmd, args) =>
      new Promise<string | null>((resolve) => {
        execFile(
          cmd,
          args,
          { timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8' },
          (err, stdout) => {
            if (err) return resolve(null);
            resolve(stdout);
          },
        );
      }));

  return {
    async getIdleSeconds() {
      let raw: string | null;
      try {
        raw = await exec('ioreg', ['-c', 'IOHIDSystem']);
      } catch {
        // Defensive: a real execFile resolves null on error, but an injected
        // runner could throw. Any failure → null (treated as active).
        return null;
      }
      if (raw == null) return null;
      return parseIdleSeconds(raw);
    },
  };
}
