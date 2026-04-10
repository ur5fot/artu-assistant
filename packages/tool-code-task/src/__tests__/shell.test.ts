import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], opts: any, cb: any) => {
    const callback = typeof opts === 'function' ? opts : cb;
    const options = typeof opts === 'function' ? {} : opts;
    const result = mockExecFile(cmd, args, options);
    if (result instanceof Error) {
      callback(result);
    } else {
      callback(null, { stdout: result ?? '', stderr: '' });
    }
  },
}));

import { run, tryRun } from '../shell.js';

describe('shell helpers', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('run executes with argv form', async () => {
    mockExecFile.mockReturnValueOnce('output\n');
    const result = await run('git', ['status', '--porcelain']);
    expect(result).toBe('output');
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('run passes cwd', async () => {
    mockExecFile.mockReturnValueOnce('');
    await run('git', ['status'], '/tmp/test');
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['status'],
      expect.objectContaining({ cwd: '/tmp/test', shell: false }),
    );
  });

  it('tryRun returns ok=true on success', async () => {
    mockExecFile.mockReturnValueOnce('data');
    const result = await tryRun('git', ['show']);
    expect(result).toEqual({ ok: true, stdout: 'data', stderr: '', code: 0 });
  });

  it('tryRun returns ok=false on error', async () => {
    const err = Object.assign(new Error('boom'), { code: 2 });
    mockExecFile.mockReturnValueOnce(err);
    const result = await tryRun('git', ['show']);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
  });
});
