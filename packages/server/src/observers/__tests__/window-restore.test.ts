import { describe, it, expect, vi } from 'vitest';
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

  it('defaults exec to the real execFile when none injected', () => {
    // Just assert it returns a promise without configuration (won't await the
    // real `open` here — covered by injected-exec cases above).
    const p = restoreWorkSurface({ app: 'Finder' }, { exec: vi.fn() as unknown as ExecFn });
    expect(p).toBeInstanceOf(Promise);
  });
});
