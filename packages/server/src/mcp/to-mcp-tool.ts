import type { ToolDefinition } from '../tools/base.js';

/**
 * MCP tool annotations we surface. `readOnlyHint` is intentionally omitted in v1
 * (R2 tracks no read/write split on `ToolDefinition`); `destructiveHint` flags
 * tools that need confirmation in R2's own flow so the MCP client can warn the
 * user before calling.
 */
export interface McpToolAnnotations {
  destructiveHint?: boolean;
  readOnlyHint?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: ToolDefinition['parameters'];
  annotations?: McpToolAnnotations;
}

/**
 * Convert an R2 `ToolDefinition` to an MCP tool descriptor. Parallel to
 * `toClaudeTool` ([base.ts]). A tool is flagged destructive when R2 would
 * confirm it (`permissionLevel === 'confirm'`), when it carries a `preCheck`,
 * or when it self-gates via `ctx.requestMemoryConfirm` and so opts in with an
 * explicit `destructiveHint` (e.g. the memory mutation tools, which run at
 * `auto` but still mutate stored facts).
 */
export function toMcpTool(tool: ToolDefinition): McpTool {
  const isDestructive =
    tool.permissionLevel === 'confirm' ||
    tool.preCheck !== undefined ||
    tool.destructiveHint === true;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    ...(isDestructive ? { annotations: { destructiveHint: true } } : {}),
  };
}
