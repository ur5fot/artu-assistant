import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockRunAllEvals = vi.fn();
vi.mock('@r2/server/evals/runner.js', () => ({
  runAllEvals: (...args: any[]) => mockRunAllEvals(...args),
}));

import { createTool } from '../index.js';

describe('code_deploy tool', () => {
  const deps = {
    runLoop: vi.fn(),
    client: {} as any,
    registry: {} as any,
    piiProxy: {} as any,
  };

  beforeEach(() => {
    mockFetch.mockReset();
    mockRunAllEvals.mockReset();
    process.env.PORT = '3001';
  });

  it('exports factory createTool', () => {
    const tool = createTool(deps);
    expect(tool.name).toBe('code_deploy');
    expect(tool.permissionLevel).toBe('confirm');
  });

  it('preCheck returns destructive', async () => {
    const tool = createTool(deps);
    const check = await tool.preCheck!({});
    expect(check.destructive).toBe(true);
    expect(check.reason).toMatch(/master/i);
  });

  it('runs evals before merge and blocks on failure', async () => {
    mockRunAllEvals.mockResolvedValueOnce({
      passed: 1,
      failed: 2,
      results: [
        { evalId: 'a', input: 'q', passed: true, reason: 'ok', actualText: 'r', actualToolCalls: [] },
        { evalId: 'b', input: 'q', passed: false, reason: 'wrong', actualText: 'r', actualToolCalls: [] },
        { evalId: 'c', input: 'q', passed: false, reason: 'broken', actualText: 'r', actualToolCalls: [] },
      ],
    });

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('2 evals failed');
    expect(result.error).toContain('wrong');
    expect(result.error).toContain('broken');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('proceeds with merge when all evals pass', async () => {
    mockRunAllEvals.mockResolvedValueOnce({ passed: 3, failed: 0, results: [] });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, commit: 'abc1234567', filesChanged: 5, message: 'Deployed abc1234' }),
    });

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/merge',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.success).toBe(true);
  });

  it('proceeds with merge when evals list is empty', async () => {
    mockRunAllEvals.mockResolvedValueOnce({ passed: 0, failed: 0, results: [] });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, commit: 'abc', filesChanged: 1, message: 'ok' }),
    });

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalled();
  });

  it('returns failure when eval runner throws', async () => {
    mockRunAllEvals.mockRejectedValueOnce(new Error('runner crashed'));

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('runner crashed');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns conflict error on 409 response', async () => {
    mockRunAllEvals.mockResolvedValueOnce({ passed: 0, failed: 0, results: [] });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'merge conflicts', conflicts: ['src/a.ts'] }),
    });

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('src/a.ts');
  });
});
