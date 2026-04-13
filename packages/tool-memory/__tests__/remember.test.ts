import { describe, it, expect, vi } from 'vitest';
import { createMemoryRememberTool, createTool } from '../src/index.js';

function fakeService(saveFact = vi.fn().mockImplementation(async (p) => ({ id: 1, ...p, importance: p.importance ?? 1 }))) {
  return { search: vi.fn().mockResolvedValue([]), saveFact };
}

describe('memory_remember tool', () => {
  it('returns error when memory service is disabled', async () => {
    const tool = createMemoryRememberTool({ memoryService: null });
    const result = await tool.handler({ text: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects empty text', async () => {
    const svc = fakeService();
    const tool = createMemoryRememberTool({ memoryService: svc });
    const result = await tool.handler({ text: '   ' });
    expect(result.success).toBe(false);
    expect(svc.saveFact).not.toHaveBeenCalled();
  });

  it('saves free text as user.note.<id> with importance=10', async () => {
    const svc = fakeService();
    const tool = createMemoryRememberTool({ memoryService: svc });
    const result = await tool.handler({ text: 'Марина любить каву' });
    expect(result.success).toBe(true);
    expect(svc.saveFact).toHaveBeenCalledTimes(1);
    const args = svc.saveFact.mock.calls[0][0];
    expect(args.key).toMatch(/^user\.note\./);
    expect(args.value).toBe('Марина любить каву');
    expect(args.importance).toBe(10);
  });

  it('parses "key: value" syntax and prefixes key with user. when no dot', async () => {
    const svc = fakeService();
    const tool = createMemoryRememberTool({ memoryService: svc });
    await tool.handler({ text: 'wife: Марина' });
    const args = svc.saveFact.mock.calls[0][0];
    expect(args.key).toBe('user.wife');
    expect(args.value).toBe('Марина');
    expect(args.importance).toBe(10);
  });

  it('keeps dotted keys as-is and lowercases', async () => {
    const svc = fakeService();
    const tool = createMemoryRememberTool({ memoryService: svc });
    await tool.handler({ text: 'Project.R2.Phase: 3' });
    expect(svc.saveFact.mock.calls[0][0].key).toBe('project.r2.phase');
  });

  it('returns error when saveFact returns null', async () => {
    const svc = fakeService(vi.fn().mockResolvedValue(null));
    const tool = createMemoryRememberTool({ memoryService: svc });
    const result = await tool.handler({ text: 'щось' });
    expect(result.success).toBe(false);
  });

  it('registers the /запам\'ятай slash command', async () => {
    const tool = createMemoryRememberTool({ memoryService: fakeService() });
    expect(tool.command?.name).toBe('запам\'ятай');
  });

  it('createTool factory returns both search and remember tools', () => {
    const tools = createTool({ memoryService: fakeService() });
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.map((t) => t.name).sort()).toEqual(['memory_remember', 'memory_search']);
  });
});
