import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRunAllEvals = vi.fn();
vi.mock('@r2/server/evals/runner.js', () => ({
  runAllEvals: (...args: any[]) => mockRunAllEvals(...args),
}));

import { createTool } from '../index.js';

describe('eval_run tool', () => {
  const deps = {
    runLoop: vi.fn(),
    client: {} as any,
    registry: {} as any,
    piiProxy: {} as any,
  };

  beforeEach(() => {
    mockRunAllEvals.mockReset();
  });

  it('creates tool with expected name and confirm permission', () => {
    const tool = createTool(deps);
    expect(tool.name).toBe('eval_run');
    expect(tool.permissionLevel).toBe('confirm');
  });

  it('returns success when all evals pass', async () => {
    mockRunAllEvals.mockResolvedValueOnce({
      passed: 3,
      failed: 0,
      results: [
        { evalId: 'a', input: 'q', passed: true, reason: 'ok', actualText: 'r', actualToolCalls: [] },
        { evalId: 'b', input: 'q', passed: true, reason: 'ok', actualText: 'r', actualToolCalls: [] },
        { evalId: 'c', input: 'q', passed: true, reason: 'ok', actualText: 'r', actualToolCalls: [] },
      ],
    });

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(true);
    expect((result.data as any).passed).toBe(3);
    expect((result.data as any).failed).toBe(0);
  });

  it('returns failure when any eval fails', async () => {
    mockRunAllEvals.mockResolvedValueOnce({
      passed: 1,
      failed: 1,
      results: [
        { evalId: 'a', input: 'q', passed: true, reason: 'ok', actualText: 'r', actualToolCalls: [] },
        { evalId: 'b', input: 'q', passed: false, reason: 'wrong', actualText: 'r', actualToolCalls: [] },
      ],
    });

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.display?.content).toContain('wrong');
  });

  it('returns success:true with zero evals', async () => {
    mockRunAllEvals.mockResolvedValueOnce({ passed: 0, failed: 0, results: [] });

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(true);
    expect(result.display?.content).toContain('0 passed');
  });

  it('forwards onProgress to runAllEvals', async () => {
    mockRunAllEvals.mockResolvedValueOnce({ passed: 0, failed: 0, results: [] });

    const tool = createTool(deps);
    const progress: string[] = [];
    await tool.handler({}, { onProgress: (m) => progress.push(m) });

    expect(mockRunAllEvals).toHaveBeenCalledWith(
      deps.runLoop,
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
  });

  it('handles runAllEvals throwing', async () => {
    mockRunAllEvals.mockRejectedValueOnce(new Error('runner crashed'));

    const tool = createTool(deps);
    const result = await tool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/runner crashed/);
  });
});
