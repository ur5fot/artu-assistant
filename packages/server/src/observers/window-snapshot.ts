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

// frontApp name → AppleScript that returns the active-tab title via the
// browser's own dictionary (more reliable than System Events AX, which yields
// "" for static pages / video / app-mode). Extensible: add Edge/Arc/Firefox as
// one line each later. Title only — no URL (privacy; consistent with
// titles-only design).
const BROWSER_TITLE_SCRIPTS: Record<string, string> = {
  'Google Chrome': 'tell application "Google Chrome" to get title of active tab of front window',
  Safari: 'tell application "Safari" to get name of current tab of front window',
};

export interface WindowSnapshot {
  app_name: string;
  window_title: string;
}

export interface WindowSnapshotProvider {
  getActive(): Promise<WindowSnapshot | null>;
}

export interface OsascriptProviderOptions {
  timeoutMs?: number;
  /** Injectable logger for the one-time Automation-permission hint (tests). */
  warn?: (msg: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function createOsascriptProvider(
  opts: OsascriptProviderOptions = {},
): WindowSnapshotProvider {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  // Latch: log the missing-browser-Automation hint exactly once per browser, so
  // a denied privilege never spams every tick. Keyed by app name.
  const hintedBrowsers = new Set<string>();

  const runScript = (script: string): Promise<string | null> =>
    new Promise<string | null>((resolve) => {
      execFile(
        'osascript',
        ['-e', script],
        { timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8' },
        (err, stdout) => {
          if (err) return resolve(null);
          resolve(stdout);
        },
      );
    });

  return {
    async getActive() {
      // Call 1 — System Events: frontApp + generic title. Always permitted.
      const raw = await runScript(SCRIPT);
      if (raw == null) return null;
      const snap = parseSnapshot(raw);
      if (!snap) return null;

      // Call 2 — browser dictionary, only for known browsers. A non-empty
      // active-tab title wins; otherwise fall back to the generic Call 1 title.
      const browserScript = BROWSER_TITLE_SCRIPTS[snap.app_name];
      if (browserScript) {
        const tabRaw = await runScript(browserScript);
        if (tabRaw == null) {
          // Call 2 failed (no Automation privilege / no window): silent
          // fallback to generic, hint once. Separate execFile so JS — not an
          // AppleScript `try` — catches the -1743 not-authorized error.
          if (!hintedBrowsers.has(snap.app_name)) {
            hintedBrowsers.add(snap.app_name);
            warn(
              `[window-snapshot] нет Automation-привилегии на ${snap.app_name} — заголовки вкладок будут пустыми; grant: System Settings → Privacy & Security → Automation → node/R2 → ${snap.app_name}.`,
            );
          }
        } else {
          const tabTitle = tabRaw.trim();
          if (tabTitle) snap.window_title = tabTitle;
        }
      }

      return snap;
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
