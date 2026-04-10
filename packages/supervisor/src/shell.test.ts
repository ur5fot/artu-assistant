import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], opts: any, cb: any) => {
    const callback = typeof opts === 'function' ? opts : cb;
    const result = mockExecFile(cmd, args, opts);
    if (result instanceof Error) {
      callback(result);
    } else {
      callback(null, { stdout: result ?? '', stderr: '' });
    }
  },
}));

import { run, tryRun } from './shell.js';

describe('supervisor shell helpers', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('run uses argv form with shell: false', async () => {
    mockExecFile.mockReturnValueOnce('hash\n');
    const result = await run('git', ['rev-parse', 'HEAD']);
    expect(result).toBe('hash');
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['rev-parse', 'HEAD'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('run passes cwd', async () => {
    mockExecFile.mockReturnValueOnce('');
    await run('git', ['status'], '/repo');
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['status'],
      expect.objectContaining({ cwd: '/repo', shell: false }),
    );
  });

  it('tryRun returns ok=true on success', async () => {
    mockExecFile.mockReturnValueOnce('data');
    const result = await tryRun('git', ['show']);
    expect(result).toEqual({ ok: true, stdout: 'data', code: 0 });
  });

  it('tryRun returns ok=false on error', async () => {
    mockExecFile.mockReturnValueOnce(Object.assign(new Error('boom'), { code: 2 }));
    const result = await tryRun('git', ['show']);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
  });
});
