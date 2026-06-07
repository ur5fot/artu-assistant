import { describe, it, expect } from 'vitest';
import type { ToolResult } from '@r2/shared';
import { toCallToolResult, makeHeadlessCtx } from '../runtime.js';

describe('toCallToolResult', () => {
  it('prefers display.content for a successful result', () => {
    const result: ToolResult = {
      success: true,
      data: { temp: 20 },
      display: { type: 'text', content: 'It is 20°C' },
    };
    const out = toCallToolResult(result);
    expect(out.isError).toBeUndefined();
    expect(out.content).toEqual([{ type: 'text', text: 'It is 20°C' }]);
  });

  it('falls back to JSON-stringified data when no display', () => {
    const result: ToolResult = { success: true, data: { temp: 20 } };
    const out = toCallToolResult(result);
    expect(out.isError).toBeUndefined();
    expect(out.content).toEqual([{ type: 'text', text: JSON.stringify({ temp: 20 }) }]);
  });

  it('emits empty-string content when success has neither display nor data', () => {
    const result: ToolResult = { success: true };
    const out = toCallToolResult(result);
    expect(out.isError).toBeUndefined();
    expect(out.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('maps success:false to isError:true with the error text', () => {
    const result: ToolResult = { success: false, error: 'boom' };
    const out = toCallToolResult(result);
    expect(out.isError).toBe(true);
    expect(out.content).toEqual([{ type: 'text', text: 'boom' }]);
  });

  it('maps success:false with no error to isError:true with a generic message', () => {
    const result: ToolResult = { success: false };
    const out = toCallToolResult(result);
    expect(out.isError).toBe(true);
    expect(out.content[0].type).toBe('text');
    expect((out.content[0] as { text: string }).text.length).toBeGreaterThan(0);
  });
});

describe('makeHeadlessCtx', () => {
  it('auto-approves requestPlanReview', async () => {
    const ctx = makeHeadlessCtx({});
    const res = await ctx.requestPlanReview!('do the thing');
    expect(res.approved).toBe(true);
  });

  it('auto-approves requestMemoryConfirm', async () => {
    const ctx = makeHeadlessCtx({});
    const res = await ctx.requestMemoryConfirm!({
      tool: 'memory_forget',
      preview: 'p',
      editableField: null,
      initialValue: null,
      params: {},
    });
    expect(res.approved).toBe(true);
  });

  it('has a no-op onProgress that does not throw', () => {
    const ctx = makeHeadlessCtx({});
    expect(() => ctx.onProgress!('half done')).not.toThrow();
  });

  it('passes signal and callId through to ctx.meta', () => {
    const controller = new AbortController();
    const ctx = makeHeadlessCtx({ signal: controller.signal, callId: 'abc' });
    expect(ctx.signal).toBe(controller.signal);
    expect(ctx.meta?.callId).toBe('abc');
  });

  it('marks the context as auto mode', () => {
    const ctx = makeHeadlessCtx({});
    expect(ctx.meta?.autoMode).toBe(true);
  });
});
