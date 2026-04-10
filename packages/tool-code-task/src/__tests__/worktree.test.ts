import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRun = vi.fn();
const mockTryRun = vi.fn();
vi.mock('../shell.js', () => ({
  run: (...args: any[]) => mockRun(...args),
  tryRun: (...args: any[]) => mockTryRun(...args),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    rmSync: vi.fn(),
    statSync: vi.fn(),
  },
  existsSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
}));

import { ensureWorktree, removeWorktree, commitChanges, validateWorktreePath } from '../worktree.js';
import fs from 'node:fs';

describe('validateWorktreePath', () => {
  beforeEach(() => {
    process.env.R2_DEV_WORKTREE_PREFIX = '/tmp/r2-dev-';
  });

  it('accepts valid prefix', () => {
    expect(() => validateWorktreePath('/tmp/r2-dev-abc123')).not.toThrow();
  });

  it('rejects root', () => {
    expect(() => validateWorktreePath('/')).toThrow();
  });

  it('rejects home', () => {
    expect(() => validateWorktreePath('~/code')).toThrow();
  });

  it('rejects missing prefix', () => {
    expect(() => validateWorktreePath('/var/tmp/foo')).toThrow();
  });

  it('rejects path with ..', () => {
    expect(() => validateWorktreePath('/tmp/r2-dev-abc/../etc')).toThrow();
  });
});

describe('ensureWorktree', () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockTryRun.mockReset();
    vi.mocked(fs.existsSync).mockReset();
    process.env.R2_DEV_WORKTREE_PREFIX = '/tmp/r2-dev-';
  });

  it('creates worktree when path does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    mockRun.mockResolvedValue('');

    await ensureWorktree('/tmp/r2-dev-abc', 'dev');

    expect(mockRun).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '--detach', '/tmp/r2-dev-abc', 'origin/dev'],
    );
  });

  it('removes existing path before creating', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockTryRun.mockResolvedValue({ ok: true, stdout: '', code: 0 });
    mockRun.mockResolvedValue('');

    await ensureWorktree('/tmp/r2-dev-abc', 'dev');

    expect(mockTryRun).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/tmp/r2-dev-abc'],
    );
  });
});

describe('removeWorktree', () => {
  beforeEach(() => {
    mockTryRun.mockReset();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.rmSync).mockReset();
    process.env.R2_DEV_WORKTREE_PREFIX = '/tmp/r2-dev-';
  });

  it('calls git worktree remove --force', async () => {
    mockTryRun.mockResolvedValue({ ok: true, stdout: '', code: 0 });
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await removeWorktree('/tmp/r2-dev-abc');

    expect(mockTryRun).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/tmp/r2-dev-abc'],
    );
  });

  it('falls back to fs.rmSync if git fails and path still exists', async () => {
    mockTryRun.mockResolvedValue({ ok: false, stdout: '', code: 1 });
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await removeWorktree('/tmp/r2-dev-abc');

    expect(fs.rmSync).toHaveBeenCalledWith('/tmp/r2-dev-abc', { recursive: true, force: true });
  });

  it('rejects unsafe path', async () => {
    await expect(removeWorktree('/')).rejects.toThrow();
  });
});

describe('commitChanges', () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockTryRun.mockReset();
    process.env.R2_DEV_WORKTREE_PREFIX = '/tmp/r2-dev-';
  });

  it('returns empty when nothing staged', async () => {
    mockTryRun.mockResolvedValue({ ok: true, stdout: '', code: 0 }); // diff --cached --quiet exits 0
    const hash = await commitChanges('/tmp/r2-dev-abc', 'r2: test');
    expect(hash).toBe('');
  });

  it('commits via argv form and returns hash', async () => {
    mockTryRun.mockResolvedValue({ ok: false, stdout: '', code: 1 }); // has changes
    mockRun.mockResolvedValueOnce(''); // git commit
    mockRun.mockResolvedValueOnce('abc1234deadbeef'); // git rev-parse

    const hash = await commitChanges('/tmp/r2-dev-abc', 'r2: test "quoted"');

    expect(hash).toBe('abc1234deadbeef');
    expect(mockRun).toHaveBeenCalledWith(
      'git',
      ['commit', '-m', 'r2: test "quoted"'],
      '/tmp/r2-dev-abc',
    );
  });
});
