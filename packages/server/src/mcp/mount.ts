import type { Express } from 'express';
import type { ToolRegistry } from '../tools/registry.js';
import { createMcpRouter } from './server.js';

export interface MountMcpOptions {
  /** From `MCP_ENABLED` — MCP is off (no route mounted) unless this is true. */
  enabled: boolean;
  registry: ToolRegistry;
  /** Extra tool names to exclude (from `MCP_TOOL_DENYLIST`). */
  denylist?: readonly string[];
}

/**
 * Conditionally mount the MCP Streamable HTTP endpoint at `/mcp`. Gated on
 * `MCP_ENABLED` so a disabled server is byte-for-byte the old R2 (no route, no
 * registry exposure). Returns whether the route was mounted, for logging/tests.
 */
export function mountMcpRouter(
  app: Express,
  { enabled, registry, denylist = [] }: MountMcpOptions,
): boolean {
  if (!enabled) return false;
  app.use('/mcp', createMcpRouter({ registry, denylist }));
  return true;
}
