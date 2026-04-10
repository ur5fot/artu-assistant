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

import { ensureWorktree, removeWorktree, commitChanges, validateWorktreePath, parseRawDiffZ } from '../worktree.js';
import fs from 'node:fs';

describe('parseRawDiffZ', () => {
  it('parses a simple modify record', () => {
    const raw = ':100644 100644 abc def M\0src/foo.ts\0';
    expect(parseRawDiffZ(raw)).toEqual([{ file: 'src/foo.ts', mode: '100644' }]);
  });

  it('parses an add record', () => {
    const raw = ':000000 100644 0000000 abc A\0src/new.ts\0';
    expect(parseRawDiffZ(raw)).toEqual([{ file: 'src/new.ts', mode: '100644' }]);
  });

  it('returns destination path for rename (not "old\\tnew")', () => {
    // Status R100 has source and destination as two separate NUL-terminated fields
    const raw = ':100644 100644 abc def R100\0src/old.ts\0.env\0';
    const parsed = parseRawDiffZ(raw);
    expect(parsed).toEqual([{ file: '.env', mode: '100644' }]);
    // Regression guard: old regex-based parser captured "src/old.ts\t.env"
    expect(parsed[0].file).not.toContain('\t');
    expect(parsed[0].file).not.toContain('old.ts');
  });

  it('parses a copy record destination', () => {
    const raw = ':100644 100644 abc def C75\0src/a.ts\0src/b.ts\0';
    expect(parseRawDiffZ(raw)).toEqual([{ file: 'src/b.ts', mode: '100644' }]);
  });

  it('parses multiple mixed records', () => {
    const raw =
      ':100644 100644 abc def M\0foo.ts\0' +
      ':100644 100644 abc def R100\0a.ts\0b.ts\0' +
      ':100644 120000 abc def M\0link\0';
    expect(parseRawDiffZ(raw)).toEqual([
      { file: 'foo.ts', mode: '100644' },
      { file: 'b.ts', mode: '100644' },
      { file: 'link', mode: '120000' },
    ]);
  });
});

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
    // resolveBaseRef calls tryRun rev-parse --verify for candidates; origin/dev resolves on first try.
    mockTryRun.mockResolvedValue({ ok: true, stdout: '', code: 0 });
    mockRun.mockResolvedValueOnce(''); // git worktree add
    mockRun.mockResolvedValueOnce('basesha1234'); // git rev-parse HEAD in worktree

    const baseSha = await ensureWorktree('/tmp/r2-dev-abc', 'dev');

    expect(mockRun).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '--detach', '/tmp/r2-dev-abc', 'origin/dev'],
    );
    expect(baseSha).toBe('basesha1234');
  });

  it('falls back to local branch when origin/dev missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    // origin/dev fails, local dev succeeds
    mockTryRun.mockResolvedValueOnce({ ok: false, stdout: '', code: 1 });
    mockTryRun.mockResolvedValueOnce({ ok: true, stdout: '', code: 0 });
    mockRun.mockResolvedValueOnce('');
    mockRun.mockResolvedValueOnce('sha');

    await ensureWorktree('/tmp/r2-dev-abc', 'dev');

    expect(mockRun).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '--detach', '/tmp/r2-dev-abc', 'dev'],
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
