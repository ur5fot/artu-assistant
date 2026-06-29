import { describe, it, expect, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { restoreWorkSurface, type ExecFn } from '../window-restore.js';

/** Capture the args passed to `open` and let the test drive the callback. */
function makeExec(behaviour: (cb: (err: unknown) => void) => void) {
  const calls: { cmd: string; args: string[]; timeout: number }[] = [];
  const exec: ExecFn = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, timeout: opts.timeout });
    behaviour(cb);
  };
  return { exec, calls };
}

const okExec = () => makeExec((cb) => queueMicrotask(() => cb(null)));

describe('restoreWorkSurface', () => {
  it('opens app + reconstructed https URL when target has a url', async () => {
    const { exec, calls } = okExec();
    const res = await restoreWorkSurface(
      { app: 'Google Chrome', url: 'github.com/foo/bar' },
      { exec },
    );
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('open');
    expect(calls[0].args).toEqual([
      '-a',
      'Google Chrome',
      'https://github.com/foo/bar',
    ]);
  });

  it('reopens a loopback dev-server URL with http (not https)', async () => {
    // A stored `localhost:3000/app` reopened as https would be non-loadable.
    const { exec, calls } = okExec();
    const res = await restoreWorkSurface(
      { app: 'Google Chrome', url: 'localhost:3000/app' },
      { exec },
    );
    expect(res).toEqual({ ok: true });
    expect(calls[0].args).toEqual([
      '-a',
      'Google Chrome',
      'http://localhost:3000/app',
    ]);
  });

  it('reopens a 127.0.0.1 URL with http', async () => {
    const { exec, calls } = okExec();
    await restoreWorkSurface(
      { app: 'Google Chrome', url: '127.0.0.1:8080/x' },
      { exec },
    );
    expect(calls[0].args[2]).toBe('http://127.0.0.1:8080/x');
  });

  it('opens app only when target has no url', async () => {
    const { exec, calls } = okExec();
    const res = await restoreWorkSurface({ app: 'Visual Studio Code' }, { exec });
    expect(res).toEqual({ ok: true });
    expect(calls[0].args).toEqual(['-a', 'Visual Studio Code']);
  });

  it('keeps an app name with spaces/special chars as a single argument', async () => {
    const { exec, calls } = okExec();
    await restoreWorkSurface({ app: 'My App "Pro" & Co' }, { exec });
    // No shell parsing: the whole name is one array element, untouched.
    expect(calls[0].args).toEqual(['-a', 'My App "Pro" & Co']);
  });

  it('resolves { ok: false, reason } on exec failure — never throws', async () => {
    const { exec } = makeExec((cb) =>
      queueMicrotask(() => cb(new Error('No such application'))),
    );
    const res = await restoreWorkSurface({ app: 'Nope' }, { exec });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('No such application');
  });

  it('resolves { ok: false } when exec throws synchronously', async () => {
    const exec: ExecFn = () => {
      throw new Error('boom');
    };
    const res = await restoreWorkSurface({ app: 'X' }, { exec });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('boom');
  });

  it('passes the configured timeout through to exec', async () => {
    const { exec, calls } = okExec();
    await restoreWorkSurface({ app: 'X' }, { exec, timeoutMs: 1234 });
    expect(calls[0].timeout).toBe(1234);
  });

  it('defaults exec to the real execFile when none injected', async () => {
    // No opts → exercises the `opts.exec ?? execFile` default branch (the path
    // that actually runs in production) against a mocked node:child_process.
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null));
    const res = await restoreWorkSurface({ app: 'Finder' });
    expect(res).toEqual({ ok: true });
    expect(execFileMock).toHaveBeenCalledWith(
      'open',
      ['-a', 'Finder'],
      { timeout: 5000 },
      expect.any(Function),
    );
  });
});
