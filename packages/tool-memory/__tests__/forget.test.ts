import { describe, it, expect, vi } from 'vitest';
import { createMemoryForgetTool, createTool } from '../src/index.js';

function fakeService(forgetFact = vi.fn()) {
  return {
    search: vi.fn().mockResolvedValue([]),
    saveFact: vi.fn(),
    forgetFact,
  };
}

describe('memory_forget tool', () => {
  it('returns error when memory service is disabled', async () => {
    const tool = createMemoryForgetTool({ memoryService: null });
    const result = await tool.handler({ query: 'user.wife' });
    expect(result.success).toBe(false);
  });

  it('rejects empty query', async () => {
    const svc = fakeService();
    const tool = createMemoryForgetTool({ memoryService: svc });
    const result = await tool.handler({ query: '   ' });
    expect(result.success).toBe(false);
    expect(svc.forgetFact).not.toHaveBeenCalled();
  });

  it('reports success when a fact was forgotten', async () => {
    const svc = fakeService(
      vi.fn().mockResolvedValue({
        forgotten: [{ id: 1, key: 'user.wife', value: 'Марина' }],
        candidates: [],
      }),
    );
    const tool = createMemoryForgetTool({ memoryService: svc });
    const result = await tool.handler({ query: 'user.wife' });
    expect(result.success).toBe(true);
    expect(svc.forgetFact).toHaveBeenCalledWith({ query: 'user.wife' });
    expect((result.display as { content: string }).content).toMatch(/Забув/);
  });

  it('returns candidate list when multiple matches require disambiguation', async () => {
    const svc = fakeService(
      vi.fn().mockResolvedValue({
        forgotten: [],
        candidates: [
          { id: 1, key: 'user.wife', value: 'Марина' },
          { id: 2, key: 'user.wife.hobby', value: 'йога' },
        ],
      }),
    );
    const tool = createMemoryForgetTool({ memoryService: svc });
    const result = await tool.handler({ query: 'wife' });
    expect(result.success).toBe(true);
    const content = (result.display as { content: string }).content;
    expect(content).toMatch(/уточни/);
    expect(content).toContain('user.wife');
    expect(content).toContain('user.wife.hobby');
  });

  it('returns error when nothing matches', async () => {
    const svc = fakeService(
      vi.fn().mockResolvedValue({ forgotten: [], candidates: [] }),
    );
    const tool = createMemoryForgetTool({ memoryService: svc });
    const result = await tool.handler({ query: 'нічого' });
    expect(result.success).toBe(false);
  });

  it('registers the /забудь slash command', () => {
    const tool = createMemoryForgetTool({ memoryService: fakeService() });
    expect(tool.command?.name).toBe('забудь');
  });

  it('createTool factory returns all three tools', () => {
    const tools = createTool({ memoryService: fakeService() });
    expect(tools.map((t) => t.name).sort()).toEqual([
      'memory_forget',
      'memory_remember',
      'memory_search',
    ]);
  });
});
