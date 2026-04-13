import { describe, it, expect, vi } from 'vitest';
import { createTool } from '../src/index.js';

function fakeService(search = vi.fn().mockResolvedValue([])) {
  return { search };
}

describe('tool-memory', () => {
  it('returns error when memory service is disabled', async () => {
    const tool = createTool({ memoryService: null });
    const result = await tool.handler({ query: 'x' });
    expect(result).toEqual({ success: false, error: 'Memory service is disabled' });
  });

  it('rejects empty query', async () => {
    const svc = fakeService();
    const tool = createTool({ memoryService: svc });
    const result = await tool.handler({ query: '' });
    expect(result.success).toBe(false);
    expect(svc.search).not.toHaveBeenCalled();
  });

  it('clamps limit into [1, 50] and defaults when non-finite', async () => {
    const svc = fakeService();
    const tool = createTool({ memoryService: svc });
    await tool.handler({ query: 'q', limit: 9999 });
    await tool.handler({ query: 'q', limit: -5 });
    await tool.handler({ query: 'q', limit: 'NaN' });
    const calls = svc.search.mock.calls.map((c) => c[0].limit);
    expect(calls).toEqual([50, 1, 10]);
  });

  it('normalizes kind to "all" when not fact/entry', async () => {
    const svc = fakeService();
    const tool = createTool({ memoryService: svc });
    await tool.handler({ query: 'q', kind: 'garbage' });
    expect(svc.search.mock.calls[0][0].kind).toBe('all');
  });

  it('returns "nothing found" display on empty hits', async () => {
    const tool = createTool({ memoryService: fakeService() });
    const result = await tool.handler({ query: 'q' });
    expect(result.success).toBe(true);
    expect(result.display?.content).toMatch(/нічого не знайдено/i);
  });

  it('formats hits with date/kind/score/preview', async () => {
    const svc = fakeService(
      vi.fn().mockResolvedValue([
        { text: 'Hello world', kind: 'user_msg', score: 0.87, timestamp: Date.UTC(2026, 3, 13) },
      ]),
    );
    const tool = createTool({ memoryService: svc });
    const result = await tool.handler({ query: 'q' });
    expect(result.success).toBe(true);
    expect(result.display?.content).toContain('2026-04-13');
    expect(result.display?.content).toContain('user_msg');
    expect(result.display?.content).toContain('0.87');
    expect(result.display?.content).toContain('Hello world');
  });

  it('returns error on service throw', async () => {
    const svc = fakeService(vi.fn().mockRejectedValue(new Error('boom')));
    const tool = createTool({ memoryService: svc });
    const result = await tool.handler({ query: 'q' });
    expect(result).toEqual({ success: false, error: 'boom' });
  });
});
