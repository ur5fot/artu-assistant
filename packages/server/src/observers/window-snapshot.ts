import { execFile } from 'node:child_process';

const SCRIPT = `tell application "System Events"
  set frontApp to name of first process whose frontmost is true
  set frontTitle to ""
  try
    tell process frontApp
      set frontTitle to name of front window
    end tell
  end try
  return frontApp & "|||" & frontTitle
end tell`;

export interface WindowSnapshot {
  app_name: string;
  window_title: string;
}

export interface WindowSnapshotProvider {
  getActive(): Promise<WindowSnapshot | null>;
}

export interface OsascriptProviderOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function createOsascriptProvider(
  opts: OsascriptProviderOptions = {},
): WindowSnapshotProvider {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    getActive() {
      return new Promise<WindowSnapshot | null>((resolve) => {
        execFile(
          'osascript',
          ['-e', SCRIPT],
          { timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8' },
          (err, stdout) => {
            if (err) return resolve(null);
            resolve(parseSnapshot(stdout));
          },
        );
      });
    },
  };
}

export function parseSnapshot(raw: string): WindowSnapshot | null {
  const trimmed = raw.trim();
  const parts = trimmed.split('|||');
  if (parts.length !== 2) return null;
  const app_name = parts[0].trim();
  const window_title = parts[1].trim();
  if (!app_name) return null;
  return { app_name, window_title };
}
