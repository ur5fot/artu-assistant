import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnsureWorktree = vi.fn();
const mockRemoveWorktree = vi.fn();
const mockCommitChanges = vi.fn();
const mockGetStagedFiles = vi.fn();
const mockUnstageFile = vi.fn();
const mockPreserveCommit = vi.fn();
const mockNormalizeWorktreeState = vi.fn();
const mockRunAgent = vi.fn();
const mockRunRalphex = vi.fn();
const mockRun = vi.fn();

vi.mock('../worktree.js', () => ({
  ensureWorktree: (...a: any[]) => mockEnsureWorktree(...a),
  removeWorktree: (...a: any[]) => mockRemoveWorktree(...a),
  commitChanges: (...a: any[]) => mockCommitChanges(...a),
  getStagedFiles: (...a: any[]) => mockGetStagedFiles(...a),
  unstageFile: (...a: any[]) => mockUnstageFile(...a),
  preserveCommit: (...a: any[]) => mockPreserveCommit(...a),
  normalizeWorktreeState: (...a: any[]) => mockNormalizeWorktreeState(...a),
}));

vi.mock('../agent-sdk.js', () => ({ runAgent: (...a: any[]) => mockRunAgent(...a) }));
vi.mock('../ralphex.js', () => ({ runRalphex: (...a: any[]) => mockRunRalphex(...a) }));
vi.mock('../shell.js', () => ({ run: (...a: any[]) => mockRun(...a), tryRun: vi.fn() }));

vi.mock('node:fs', () => ({
  default: { statSync: vi.fn().mockReturnValue({ size: 100 }) },
  statSync: vi.fn().mockReturnValue({ size: 100 }),
}));

import { codeTaskTool } from '../index.js';

describe('codeTaskTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureWorktree.mockResolvedValue('basesha1234');
    mockRemoveWorktree.mockResolvedValue(undefined);
    mockCommitChanges.mockResolvedValue('abc1234567890');
    mockGetStagedFiles.mockResolvedValue([{ file: 'src/App.tsx', mode: '100644' }]);
    mockRunAgent.mockResolvedValue(undefined);
    mockRunRalphex.mockResolvedValue(undefined);
    mockPreserveCommit.mockResolvedValue(undefined);
    mockNormalizeWorktreeState.mockResolvedValue(undefined);
    mockRun.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('--numstat')) return Promise.resolve('5\t2\tsrc/App.tsx');
      return Promise.resolve('diff content');
    });
  });

  it('requires task parameter', async () => {
    const result = await codeTaskTool.handler({}, { onProgress: () => {} });
    expect(result.success).toBe(false);
    expect(result.error).toContain('task');
  });

  it('runs agent-sdk in once mode', async () => {
    const result = await codeTaskTool.handler(
      { task: 'add feature' },
      { onProgress: () => {}, meta: { callId: 'c1' } },
    );

    expect(mockRunAgent).toHaveBeenCalled();
    expect(mockRunRalphex).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect((result.data as any).mode).toBe('once');
  });

  it('runs ralphex in auto mode', async () => {
    await codeTaskTool.handler(
      { task: 'test' },
      {
        onProgress: () => {},
        meta: { autoMode: true, callId: 'c2' },
        requestPlanReview: async () => ({ approved: true }),
      },
    );
    expect(mockRunRalphex).toHaveBeenCalled();
  });

  it('fails in auto mode without requestPlanReview', async () => {
    const result = await codeTaskTool.handler(
      { task: 'test' },
      { onProgress: () => {}, meta: { autoMode: true, callId: 'c3' } },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/plan review/i);
  });

  it('unstages .env files via denylist', async () => {
    mockGetStagedFiles.mockResolvedValue([
      { file: 'src/App.tsx', mode: '100644' },
      { file: '.env', mode: '100644' },
      { file: 'src/.env.local', mode: '100644' },
    ]);

    const result = await codeTaskTool.handler(
      { task: 'test' },
      { onProgress: () => {}, meta: { callId: 'c4' } },
    );

    expect(mockUnstageFile).toHaveBeenCalledWith(expect.any(String), '.env');
    expect(mockUnstageFile).toHaveBeenCalledWith(expect.any(String), 'src/.env.local');
    expect((result.data as any).blockedFiles).toContain('.env');
    expect((result.data as any).blockedFiles).toContain('src/.env.local');
  });

  it('removes worktree in finally on success', async () => {
    await codeTaskTool.handler(
      { task: 'test' },
      { onProgress: () => {}, meta: { callId: 'c5' } },
    );
    expect(mockRemoveWorktree).toHaveBeenCalled();
  });

  it('removes worktree in finally on agent error', async () => {
    mockRunAgent.mockRejectedValue(new Error('agent crashed'));

    const result = await codeTaskTool.handler(
      { task: 'test' },
      { onProgress: () => {}, meta: { callId: 'c6' } },
    );

    expect(result.success).toBe(false);
    expect(mockRemoveWorktree).toHaveBeenCalled();
  });

  it('uses per-call worktree paths', async () => {
    await codeTaskTool.handler(
      { task: 'a' },
      { onProgress: () => {}, meta: { callId: 'call-a' } },
    );
    await codeTaskTool.handler(
      { task: 'b' },
      { onProgress: () => {}, meta: { callId: 'call-b' } },
    );

    const firstPath = mockEnsureWorktree.mock.calls[0][0];
    const secondPath = mockEnsureWorktree.mock.calls[1][0];
    expect(firstPath).not.toBe(secondPath);
    expect(firstPath).toContain('call-a');
    expect(secondPath).toContain('call-b');
  });

  it('normalizes worktree state before filtering (enforces no-self-commit contract)', async () => {
    const order: string[] = [];
    mockNormalizeWorktreeState.mockImplementation(async () => { order.push('normalize'); });
    mockGetStagedFiles.mockImplementation(async () => { order.push('getStaged'); return []; });

    await codeTaskTool.handler(
      { task: 'test' },
      { onProgress: () => {}, meta: { callId: 'c-norm' } },
    );

    // normalizeWorktreeState MUST run before filterStagedFiles so that any
    // agent-made commits are collapsed into the staged index and then
    // subjected to the denylist.
    expect(order).toEqual(['normalize', 'getStaged']);
    expect(mockNormalizeWorktreeState).toHaveBeenCalledWith(
      expect.stringContaining('c-norm'),
      'basesha1234',
    );
  });

  it('defines preCheck hook delegating to isDestructive', async () => {
    expect(codeTaskTool.preCheck).toBeDefined();
    const result = await codeTaskTool.preCheck!({ task: 'delete all logs' });
    expect(result.destructive).toBe(true);
  });
});
