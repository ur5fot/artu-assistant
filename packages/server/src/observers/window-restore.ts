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

/**
 * Focus a work app via macOS `open -a`. When the target carried a URL (the
 * surface was a browser tab), reopen that URL in the app so the right tab comes
 * back: `open -a <app> https://<host/path>`. The stored URL is host+path only
 * (scheme stripped at capture), so it's reconstructed as https.
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
    ? ['-a', target.app, `https://${target.url}`]
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
