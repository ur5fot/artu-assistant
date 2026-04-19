import { describe, it, expect, vi } from 'vitest';
import {
  createMemoryForgetTool,
  createMemoryUpdateTool,
  createMemoryForgetLastTool,
} from '../src/index.js';

function makeMemoryService(overrides: Record<string, unknown> = {}) {
  return {
    search: vi.fn().mockResolvedValue([]),
    saveFact: vi.fn(),
    forgetFact: vi.fn(async () => ({
      forgotten: [{ id: 1, key: 'user.age', value: '42' }],
      candidates: [],
    })),
    updateFact: vi.fn(async ({ key, newValue }: { key: string; newValue: string }) => ({
      updated: { key, oldValue: '42', newValue },
    })),
    forgetLast: vi.fn(async (_params: { currentMessageTimestamp: number; dryRun?: boolean; factIds?: number[] }) => ({
      forgotten: [
        { id: 2, key: 'user.x', value: 'y' },
        { id: 3, key: 'user.z', value: 'w' },
      ],
      sourceMessageId: 'M_prev',
    })),
    ...overrides,
  };
}

function makeCtx(confirmResponse: { approved: boolean; editedParams?: Record<string, unknown> }) {
  return {
    requestMemoryConfirm: vi.fn(async () => confirmResponse),
    meta: { callId: 'BLK-1' },
  } as any;
}

describe('memory_forget with confirm', () => {
  it('requests confirm with preview; on approve, applies with original query', async () => {
    const memoryService = makeMemoryService();
    const tool = createMemoryForgetTool({ memoryService });
    const ctx = makeCtx({ approved: true });
    const res = await tool.handler({ query: 'user.age' }, ctx);
    expect(ctx.requestMemoryConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'memory_forget',
        editableField: 'query',
        initialValue: 'user.age',
        params: { query: 'user.age' },
      }),
    );
    expect(memoryService.forgetFact).toHaveBeenCalledWith({ query: 'user.age' });
    expect(res.success).toBe(true);
  });

  it('on edit & approve, uses edited query', async () => {
    const memoryService = makeMemoryService();
    const tool = createMemoryForgetTool({ memoryService });
    const ctx = makeCtx({ approved: true, editedParams: { query: 'user.age_group' } });
    await tool.handler({ query: 'user.age' }, ctx);
    expect(memoryService.forgetFact).toHaveBeenCalledWith({ query: 'user.age_group' });
  });

  it('on deny, returns error without calling service', async () => {
    const memoryService = makeMemoryService();
    const tool = createMemoryForgetTool({ memoryService });
    const ctx = makeCtx({ approved: false });
    const res = await tool.handler({ query: 'user.age' }, ctx);
    expect(res.success).toBe(false);
    expect(memoryService.forgetFact).not.toHaveBeenCalled();
  });

  it('falls back to direct apply if ctx.requestMemoryConfirm is missing', async () => {
    const memoryService = makeMemoryService();
    const tool = createMemoryForgetTool({ memoryService });
    await tool.handler({ query: 'user.age' }, { meta: {} } as any);
    expect(memoryService.forgetFact).toHaveBeenCalled();
  });
});

describe('memory_update', () => {
  it('requests confirm with key + editable newValue; applies with currentUserMessageId', async () => {
    const memoryService = makeMemoryService();
    const tool = createMemoryUpdateTool({ memoryService });
    const ctx = { ...makeCtx({ approved: true }), currentUserMessageId: 'M-10' };
    const res = await tool.handler({ key: 'user.activity', newValue: 'бег' }, ctx);
    expect(ctx.requestMemoryConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'memory_update',
        editableField: 'newValue',
        initialValue: 'бег',
      }),
    );
    expect(memoryService.updateFact).toHaveBeenCalledWith({
      key: 'user.activity',
      newValue: 'бег',
      sourceMessageId: 'M-10',
    });
    expect(res.success).toBe(true);
  });

  it('uses edited newValue when user edits', async () => {
    const memoryService = makeMemoryService();
    const tool = createMemoryUpdateTool({ memoryService });
    const ctx = {
      ...makeCtx({ approved: true, editedParams: { newValue: 'плавание' } }),
      currentUserMessageId: 'M-10',
    };
    await tool.handler({ key: 'user.activity', newValue: 'бег' }, ctx);
    expect(memoryService.updateFact).toHaveBeenCalledWith({
      key: 'user.activity',
      newValue: 'плавание',
      sourceMessageId: 'M-10',
    });
  });

  it('on deny, returns error without calling service', async () => {
    const memoryService = makeMemoryService();
    const tool = createMemoryUpdateTool({ memoryService });
    const ctx = { ...makeCtx({ approved: false }), currentUserMessageId: 'M-10' };
    const res = await tool.handler({ key: 'user.activity', newValue: 'бег' }, ctx);
    expect(res.success).toBe(false);
    expect(memoryService.updateFact).not.toHaveBeenCalled();
  });

  it('returns error when memory service is disabled', async () => {
    const tool = createMemoryUpdateTool({ memoryService: null });
    const res = await tool.handler({ key: 'user.x', newValue: 'y' }, makeCtx({ approved: true }));
    expect(res.success).toBe(false);
  });

  it('rejects missing key or newValue', async () => {
    const tool = createMemoryUpdateTool({ memoryService: makeMemoryService() });
    const res1 = await tool.handler({ key: '', newValue: 'y' }, makeCtx({ approved: true }));
    const res2 = await tool.handler({ key: 'user.x', newValue: '   ' }, makeCtx({ approved: true }));
    expect(res1.success).toBe(false);
    expect(res2.success).toBe(false);
  });
});

describe('memory_forget_last', () => {
  it('uses dryRun for preview, then applies on approve with frozen factIds', async () => {
    const memoryService = makeMemoryService();
    const tool = createMemoryForgetLastTool({ memoryService });
    const ctx = { ...makeCtx({ approved: true }), currentUserMessageTimestamp: 2000 };
    const res = await tool.handler({}, ctx);
    expect(memoryService.forgetLast).toHaveBeenCalledWith({ currentMessageTimestamp: 2000, dryRun: true });
    expect(ctx.requestMemoryConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'memory_forget_last',
        editableField: null,
      }),
    );
    // Apply path must pin the fact set to the ids the user saw in the preview —
    // otherwise the async extractor appending new facts to the same source
    // message between preview and approve would cause silent over-deletion.
    expect(memoryService.forgetLast).toHaveBeenCalledWith({ currentMessageTimestamp: 2000, factIds: [2, 3] });
    expect(res.success).toBe(true);
  });

  it('returns error without confirm when dry-run yields no facts', async () => {
    const memoryService = makeMemoryService({
      forgetLast: vi.fn(async () => ({
        forgotten: [],
        sourceMessageId: null,
        reason: 'no previous user message',
      })),
    });
    const tool = createMemoryForgetLastTool({ memoryService });
    const ctx = { ...makeCtx({ approved: true }), currentUserMessageTimestamp: 2000 };
    const res = await tool.handler({}, ctx);
    expect(res.success).toBe(false);
    expect(ctx.requestMemoryConfirm).not.toHaveBeenCalled();
  });

  it('on deny, does not mark forgotten', async () => {
    const forgetLast = vi.fn(async (_params: { currentMessageTimestamp: number; dryRun?: boolean }) => ({
      forgotten: [{ id: 2, key: 'user.x', value: 'y' }],
      sourceMessageId: 'M_prev',
    }));
    const memoryService = makeMemoryService({ forgetLast });
    const tool = createMemoryForgetLastTool({ memoryService });
    const ctx = { ...makeCtx({ approved: false }), currentUserMessageTimestamp: 2000 };
    const res = await tool.handler({}, ctx);
    expect(res.success).toBe(false);
    // Only the dryRun call should have happened — never the real apply
    expect(forgetLast).toHaveBeenCalledTimes(1);
    expect(forgetLast).toHaveBeenCalledWith({ currentMessageTimestamp: 2000, dryRun: true });
  });

  it('returns error when memory service is disabled', async () => {
    const tool = createMemoryForgetLastTool({ memoryService: null });
    const res = await tool.handler({}, makeCtx({ approved: true }));
    expect(res.success).toBe(false);
  });

  it('fails closed when ctx.currentUserMessageTimestamp is missing', async () => {
    const memoryService = makeMemoryService();
    const tool = createMemoryForgetLastTool({ memoryService });
    const ctx = makeCtx({ approved: true });
    const res = await tool.handler({}, ctx);
    expect(res.success).toBe(false);
    expect(memoryService.forgetLast).not.toHaveBeenCalled();
    expect(ctx.requestMemoryConfirm).not.toHaveBeenCalled();
  });
});
