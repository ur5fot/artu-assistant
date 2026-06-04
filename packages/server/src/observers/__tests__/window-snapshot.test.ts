import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { createOsascriptProvider, parseSnapshot, stripUrl } from '../window-snapshot.js';

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockExecFile.mockReset();
});

function setupStdout(stdout: string) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, o: string, s: string) => void) => {
      queueMicrotask(() => cb(null, stdout, ''));
    },
  );
}

function setupError(err: unknown) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown) => void) => {
      queueMicrotask(() => cb(err));
    },
  );
}

// Route Call 1 (System Events) vs Call 2 (browser dictionary) by script body.
// `browser` may be a string (stdout) or an Error (Call 2 failure).
function setupBrowser(systemEventsStdout: string, browser: string | Error) {
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: (e: unknown, o?: string, s?: string) => void) => {
      const script = args[1];
      if (script.includes('System Events')) {
        queueMicrotask(() => cb(null, systemEventsStdout, ''));
      } else if (browser instanceof Error) {
        queueMicrotask(() => cb(browser));
      } else {
        queueMicrotask(() => cb(null, browser, ''));
      }
    },
  );
}

describe('parseSnapshot', () => {
  it('parses well-formed stdout into app + title', () => {
    expect(parseSnapshot('Chrome|||Inbox - Gmail\n')).toEqual({
      app_name: 'Chrome',
      window_title: 'Inbox - Gmail',
    });
  });

  it('returns object with empty title when title side is empty', () => {
    expect(parseSnapshot('Finder|||\n')).toEqual({
      app_name: 'Finder',
      window_title: '',
    });
  });

  it('returns null when app side is empty', () => {
    expect(parseSnapshot('|||\n')).toBeNull();
  });

  it('returns null when delimiter is missing', () => {
    expect(parseSnapshot('Chrome\n')).toBeNull();
  });

  it('returns null when there are too many delimiters', () => {
    expect(parseSnapshot('Chrome|||a|||b\n')).toBeNull();
  });

  it('trims whitespace around app and title', () => {
    expect(parseSnapshot('  Chrome   |||   Inbox  \n')).toEqual({
      app_name: 'Chrome',
      window_title: 'Inbox',
    });
  });
});

describe('createOsascriptProvider.getActive', () => {
  it('returns parsed snapshot on successful stdout', async () => {
    setupStdout('Chrome|||Inbox - Gmail\n');
    const provider = createOsascriptProvider();
    expect(await provider.getActive()).toEqual({
      app_name: 'Chrome',
      window_title: 'Inbox - Gmail',
    });
  });

  it('returns snapshot with empty title for "Finder|||"', async () => {
    setupStdout('Finder|||\n');
    const provider = createOsascriptProvider();
    expect(await provider.getActive()).toEqual({
      app_name: 'Finder',
      window_title: '',
    });
  });

  it('returns null when stdout has empty app side', async () => {
    setupStdout('|||\n');
    const provider = createOsascriptProvider();
    expect(await provider.getActive()).toBeNull();
  });

  it('returns null on timeout (error with killed=true)', async () => {
    const err = Object.assign(new Error('process killed'), { killed: true });
    setupError(err);
    const provider = createOsascriptProvider();
    expect(await provider.getActive()).toBeNull();
  });

  it('returns null on non-zero exit code', async () => {
    const err = Object.assign(new Error('Command failed: osascript'), {
      code: 1,
      stderr: 'not authorised to send Apple events',
    });
    setupError(err);
    const provider = createOsascriptProvider();
    expect(await provider.getActive()).toBeNull();
  });

  it('returns null when stdout missing delimiter', async () => {
    setupStdout('completely unexpected output\n');
    const provider = createOsascriptProvider();
    expect(await provider.getActive()).toBeNull();
  });

  it('invokes osascript with -e SCRIPT and passes timeoutMs', async () => {
    setupStdout('Chrome|||x\n');
    const provider = createOsascriptProvider({ timeoutMs: 1234 });
    await provider.getActive();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockExecFile.mock.calls[0];
    expect(cmd).toBe('osascript');
    expect(args[0]).toBe('-e');
    expect(typeof args[1]).toBe('string');
    expect(args[1]).toContain('System Events');
    expect(opts).toMatchObject({ timeout: 1234, killSignal: 'SIGKILL' });
  });

  it('defaults timeoutMs to 5000 when not supplied', async () => {
    setupStdout('Chrome|||x\n');
    const provider = createOsascriptProvider();
    await provider.getActive();
    const opts = mockExecFile.mock.calls[0][2] as { timeout: number };
    expect(opts.timeout).toBe(5000);
  });
});

describe('createOsascriptProvider.getActive — browser-aware tab title', () => {
  it('non-browser app makes a single System Events call (no Call 2)', async () => {
    setupStdout('Finder|||Documents\n');
    const provider = createOsascriptProvider();
    expect(await provider.getActive()).toEqual({
      app_name: 'Finder',
      window_title: 'Documents',
    });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('browser with non-empty tab title prefers Call 2 over generic title', async () => {
    setupBrowser('Google Chrome|||generic window\n', '«Уроки для Пети» - Google Chrome\n');
    const provider = createOsascriptProvider();
    expect(await provider.getActive()).toEqual({
      app_name: 'Google Chrome',
      window_title: '«Уроки для Пети» - Google Chrome',
    });
    // Call 1 (System Events) + Call 2 (title) + Call 3 (URL).
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it('Safari tab title is queried via its own dictionary', async () => {
    setupBrowser('Safari|||\n', 'Apple\n');
    const provider = createOsascriptProvider();
    expect(await provider.getActive()).toEqual({
      app_name: 'Safari',
      window_title: 'Apple',
    });
    const call2Script = mockExecFile.mock.calls[1][1][1] as string;
    expect(call2Script).toContain('Safari');
  });

  it('browser with empty Call 2 result falls back to generic title', async () => {
    setupBrowser('Google Chrome|||generic window\n', '\n');
    const provider = createOsascriptProvider();
    expect(await provider.getActive()).toEqual({
      app_name: 'Google Chrome',
      window_title: 'generic window',
    });
  });

  it('browser with empty generic title AND failed Call 2 yields an empty window_title', async () => {
    // The core scenario this feature targets: long Chrome dwell, System Events
    // returns a blank title, and Automation is denied. The snapshot must stay
    // a valid object with window_title='' (blank signal → judge returns unknown),
    // not null.
    const err = Object.assign(new Error('not authorised'), { code: 1 });
    setupBrowser('Google Chrome|||\n', err);
    const warn = vi.fn();
    const provider = createOsascriptProvider({ warn });
    expect(await provider.getActive()).toEqual({
      app_name: 'Google Chrome',
      window_title: '',
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('Call 2 error falls back to generic and logs the hint exactly once', async () => {
    const err = Object.assign(new Error('not authorised'), { code: 1 });
    setupBrowser('Google Chrome|||generic window\n', err);
    const warn = vi.fn();
    const provider = createOsascriptProvider({ warn });

    expect(await provider.getActive()).toEqual({
      app_name: 'Google Chrome',
      window_title: 'generic window',
    });
    // Second tick: still failing, but the hint must not repeat (latch).
    expect(await provider.getActive()).toEqual({
      app_name: 'Google Chrome',
      window_title: 'generic window',
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Automation');
    expect(warn.mock.calls[0][0]).toContain('Google Chrome');
  });
});

// Route Call 1 (System Events), Call 2 (title), Call 3 (URL) by script body.
// `title`/`url` may each be a string (stdout) or an Error (call failure).
function setupBrowserUrl(
  systemEventsStdout: string,
  title: string | Error,
  url: string | Error,
) {
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: (e: unknown, o?: string, s?: string) => void) => {
      const script = args[1] as string;
      let outcome: string | Error;
      if (script.includes('System Events')) outcome = systemEventsStdout;
      else if (script.includes('URL')) outcome = url;
      else outcome = title;
      if (outcome instanceof Error) queueMicrotask(() => cb(outcome));
      else queueMicrotask(() => cb(null, outcome, ''));
    },
  );
}

describe('stripUrl', () => {
  it('drops scheme, query and fragment, keeps host+path', () => {
    expect(stripUrl('https://example.com/foo/bar?token=secret#frag')).toBe('example.com/foo/bar');
  });
  it('strips leading www. and trailing slash', () => {
    expect(stripUrl('https://www.example.com/foo/')).toBe('example.com/foo');
  });
  it('host-only URL yields bare host', () => {
    expect(stripUrl('https://example.com/')).toBe('example.com');
  });
  it('returns null for non-http(s) schemes', () => {
    expect(stripUrl('file:///Users/x/secret.txt')).toBeNull();
    expect(stripUrl('chrome://settings')).toBeNull();
  });
  it('returns null for unparseable input', () => {
    expect(stripUrl('not a url')).toBeNull();
    expect(stripUrl('')).toBeNull();
  });
  it('keeps a non-default port so localhost services do not cross-match', () => {
    // localhost-first project: :3000 and :5173 are different services and must
    // produce distinct host+path identities (uses `host`, not `hostname`).
    expect(stripUrl('http://localhost:3000/a/b')).toBe('localhost:3000/a/b');
    expect(stripUrl('http://localhost:5173/a/b')).toBe('localhost:5173/a/b');
    expect(stripUrl('http://localhost:3000/a/b')).not.toBe(stripUrl('http://localhost:5173/a/b'));
  });
  it('omits default ports (normal sites unaffected)', () => {
    expect(stripUrl('https://example.com:443/foo')).toBe('example.com/foo');
    expect(stripUrl('http://example.com:80/foo')).toBe('example.com/foo');
  });
});

describe('createOsascriptProvider.getActive — active-tab URL capture', () => {
  it('captures the active-tab URL (Call 3), query/fragment stripped', async () => {
    setupBrowserUrl(
      'Google Chrome|||generic\n',
      'My Page - Google Chrome\n',
      'https://example.com/lessons/petya?ref=email#top\n',
    );
    const provider = createOsascriptProvider();
    expect(await provider.getActive()).toEqual({
      app_name: 'Google Chrome',
      window_title: 'My Page - Google Chrome',
      url: 'example.com/lessons/petya',
    });
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it('Safari URL is queried via its own dictionary', async () => {
    setupBrowserUrl('Safari|||\n', 'Apple\n', 'https://apple.com/mac\n');
    const provider = createOsascriptProvider();
    const snap = await provider.getActive();
    expect(snap?.url).toBe('apple.com/mac');
    const call3Script = mockExecFile.mock.calls[2][1][1] as string;
    expect(call3Script).toContain('Safari');
    expect(call3Script).toContain('URL');
  });

  it('non-browser app captures no url (no Call 3)', async () => {
    setupStdout('Finder|||Documents\n');
    const provider = createOsascriptProvider();
    const snap = await provider.getActive();
    expect(snap).toEqual({ app_name: 'Finder', window_title: 'Documents' });
    expect(snap?.url).toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('URL fetch failure (no privilege) leaves url absent, title preserved', async () => {
    const err = Object.assign(new Error('not authorised'), { code: 1 });
    setupBrowserUrl('Google Chrome|||generic\n', 'My Page\n', err);
    const provider = createOsascriptProvider();
    const snap = await provider.getActive();
    expect(snap).toEqual({ app_name: 'Google Chrome', window_title: 'My Page' });
    expect(snap?.url).toBeUndefined();
  });

  it('non-http(s) active tab (e.g. chrome://) yields no url', async () => {
    setupBrowserUrl('Google Chrome|||Settings\n', 'Settings\n', 'chrome://settings\n');
    const provider = createOsascriptProvider();
    const snap = await provider.getActive();
    expect(snap?.url).toBeUndefined();
  });
});
