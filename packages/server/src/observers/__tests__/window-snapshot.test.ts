import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { createOsascriptProvider, parseSnapshot } from '../window-snapshot.js';

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
