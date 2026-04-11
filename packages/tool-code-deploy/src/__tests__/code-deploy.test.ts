import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { codeDeployTool } from '../index.js';

describe('codeDeployTool', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.PORT = '3001';
  });

  it('preCheck always returns destructive', async () => {
    expect(codeDeployTool.preCheck).toBeDefined();
    const result = await codeDeployTool.preCheck!({});
    expect(result.destructive).toBe(true);
    expect(result.reason).toMatch(/master/i);
  });

  it('calls POST /api/merge on configured port', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, commit: 'abc1234567', filesChanged: 5, message: 'Deployed abc1234' }),
    });

    const result = await codeDeployTool.handler({}, { onProgress: () => {} });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/merge',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.success).toBe(true);
    expect((result.data as any).commit).toBe('abc1234567');
    expect((result.data as any).filesChanged).toBe(5);
  });

  it('returns failure with conflicts list on 409', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'merge conflicts', conflicts: ['src/a.ts', 'src/b.ts'] }),
    });

    const result = await codeDeployTool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('src/a.ts');
    expect(result.error).toContain('src/b.ts');
  });

  it('reports non-conflict 409 (e.g. dirty worktree) using server error, not fake conflicts', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'working tree not clean; commit or stash changes before deploying' }),
    });

    const result = await codeDeployTool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('working tree not clean');
    expect(result.error).not.toContain('Merge conflicts');
  });

  it('reports 409 deploy-already-in-progress without claiming merge conflicts', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'deploy already in progress' }),
    });

    const result = await codeDeployTool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('deploy already in progress');
    expect(result.error).not.toContain('Merge conflicts');
  });

  it('returns failure on 500', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'push rejected' }),
    });

    const result = await codeDeployTool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('push rejected');
  });

  it('returns failure on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await codeDeployTool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('emits progress messages', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, commit: 'abc1234', filesChanged: 1, message: 'ok' }),
    });

    const progress: string[] = [];
    await codeDeployTool.handler({}, { onProgress: (m) => progress.push(m) });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((p) => p.toLowerCase().includes('merg'))).toBe(true);
  });
});
