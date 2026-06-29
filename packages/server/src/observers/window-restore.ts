import { execFile } from 'node:child_process';

/** A work surface to bring back to the foreground — an app name plus, when the
 * surface was a browser tab, its host+path URL (as stored by window-snapshot). */
export interface RestoreTarget {
  app: string;
  url?: string;
}

export interface RestoreResult {
  ok: boolean;
  /** Short failure reason when `ok` is false (never thrown). */
  reason?: string;
}

/** Injectable child-process runner. Defaults to the real `execFile`. Args are
 * always passed as an array — no shell, no string interpolation — so app names
 * and URLs from the DB can't inject. */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { timeout: number },
  cb: (err: unknown) => void,
) => void;

export interface RestoreOptions {
  exec?: ExecFn;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** Loopback hosts only ever serve plain http in dev (a stored
 * `localhost:3000/app` reopened as https would be a non-loadable URL). The
 * stored URL is host[:port]/path with the scheme stripped at capture, so we
 * pick the scheme back: http for loopback, https for everything else (the
 * public web is effectively https-only). */
function schemeFor(url: string): 'http' | 'https' {
  const hostPort = url.split('/', 1)[0];
  const host = hostPort.split(':', 1)[0];
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.startsWith('127.') ||
    host === '0.0.0.0' ||
    hostPort.startsWith('[::1]')
  ) {
    return 'http';
  }
  return 'https';
}

/**
 * Focus a work app via macOS `open -a`. When the target carried a URL (the
 * surface was a browser tab), reopen that URL in the app so the right tab comes
 * back: `open -a <app> <scheme>://<host/path>`. The stored URL is host+path only
 * (scheme stripped at capture), so the scheme is reconstructed — http for
 * loopback dev servers, https otherwise (see schemeFor).
 *
 * Never throws: a non-zero exit, missing app, or timeout resolves to
 * `{ ok: false, reason }`, mirroring window-snapshot's silent-fail style.
 */
export function restoreWorkSurface(
  target: RestoreTarget,
  opts: RestoreOptions = {},
): Promise<RestoreResult> {
  const exec: ExecFn =
    opts.exec ?? (execFile as unknown as ExecFn);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const args = target.url
    ? ['-a', target.app, `${schemeFor(target.url)}://${target.url}`]
    : ['-a', target.app];

  return new Promise<RestoreResult>((resolve) => {
    try {
      exec('open', args, { timeout: timeoutMs }, (err) => {
        if (err) {
          resolve({ ok: false, reason: errMessage(err) });
          return;
        }
        resolve({ ok: true });
      });
    } catch (err) {
      // Synchronous throw from exec (e.g. invalid argument shape) — still no throw.
      resolve({ ok: false, reason: errMessage(err) });
    }
  });
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
