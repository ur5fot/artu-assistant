import type { ToolContext, ToolResult } from '@r2/shared';

/** Minimal MCP `CallToolResult` shape we emit (text content only in v1). */
export interface CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Map an R2 `ToolResult` to an MCP `CallToolResult`. Human-readable
 * `display.content` is preferred; otherwise the raw `data` is JSON-stringified.
 * A failed result (`success:false`) surfaces as `isError:true` carrying `error`.
 */
export function toCallToolResult(result: ToolResult): CallToolResult {
  if (!result.success) {
    return {
      content: [{ type: 'text', text: result.error ?? 'Tool reported failure' }],
      isError: true,
    };
  }
  const text = result.display
    ? result.display.content
    : result.data !== undefined
      ? JSON.stringify(result.data)
      : '';
  return { content: [{ type: 'text', text }] };
}

export interface HeadlessCtxOptions {
  signal?: AbortSignal;
  callId?: string;
}

/**
 * Build a headless `ToolContext` for MCP-driven calls. The MCP client prompts
 * the user before each tool call, so R2's Discord-based confirm callbacks
 * auto-approve here; destructiveness is surfaced to the client via
 * `destructiveHint` (see `toMcpTool`). Progress is dropped (no Discord channel).
 */
export function makeHeadlessCtx({ signal, callId }: HeadlessCtxOptions): ToolContext {
  return {
    onProgress: () => {},
    requestPlanReview: async () => ({ approved: true }),
    requestMemoryConfirm: async () => ({ approved: true }),
    signal,
    meta: { autoMode: true, callId },
  };
}
