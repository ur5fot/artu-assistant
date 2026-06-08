import express, { Router } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { selectMcpTools } from './select-tools.js';
import { toMcpTool } from './to-mcp-tool.js';
import { toCallToolResult, makeHeadlessCtx } from './runtime.js';

export interface McpServerOptions {
  registry: ToolRegistry;
  /** Extra tool names to exclude (from `MCP_TOOL_DENYLIST`). */
  denylist?: readonly string[];
}

const SERVER_INFO = { name: 'r2', version: '0.1.0' } as const;

/**
 * Build a low-level MCP `Server` exposing R2's tool arsenal. We use the
 * low-level `Server` (not `McpServer`) because R2 tools carry raw JSON Schema
 * (`ToolDefinition.parameters`), whereas `McpServer.registerTool` expects Zod
 * shapes. `ListTools` returns `selectMcpTools` mapped via `toMcpTool`; `CallTool`
 * re-checks exposure (defence in depth), runs the tool handler with a headless
 * `ToolContext`, and maps the `ToolResult` via `toCallToolResult`.
 */
export function createMcpServer({ registry, denylist = [] }: McpServerOptions): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = selectMcpTools(registry, denylist).map((tool) => {
      const mcp = toMcpTool(tool);
      return {
        name: mcp.name,
        description: mcp.description,
        inputSchema: mcp.inputSchema,
        ...(mcp.annotations ? { annotations: mcp.annotations } : {}),
      };
    });
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    // Re-resolve the exposed set per call so a denylisted/internal/unknown name
    // can never reach a handler, even if the client ignores `list_tools`.
    const tool = selectMcpTools(registry, denylist).find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown or unavailable tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const ctx = makeHeadlessCtx({ signal: extra.signal, callId: String(extra.requestId) });
      const result = await tool.handler((args ?? {}) as Record<string, unknown>, ctx);
      return toCallToolResult(result) as CallToolResult;
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Guard against DNS-rebinding. The endpoint is unauthenticated and bound to
 * loopback, but a malicious web page can point a hostname it controls at
 * 127.0.0.1 and have the victim's browser POST here (the browser sends the
 * attacker's domain in `Host`). We only accept requests whose `Host` — and
 * `Origin`, when present — resolve to loopback. SDK 1.29.0's transport has no
 * built-in Host/Origin validation, so this is the only line of defence.
 */
function isLoopbackHost(value: string | undefined): boolean {
  if (!value) return false;
  // Strip scheme (Origin carries one) and any path, leaving host[:port].
  let host = value.replace(/^[a-z]+:\/\//i, '').split('/')[0];
  if (host.startsWith('[')) {
    // IPv6 literal: `[::1]:3001` → `::1`
    host = host.slice(1, host.indexOf(']'));
  } else {
    host = host.split(':')[0];
  }
  host = host.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Express router exposing the MCP endpoint over Streamable HTTP at the mount
 * point (mounted at `/mcp` in `index.ts`). Stateless mode: a fresh `Server` +
 * `StreamableHTTPServerTransport` per request, torn down when the response
 * closes. Suitable for the local single-user, no-auth deployment.
 */
export function createMcpRouter(options: McpServerOptions): Router {
  const router = Router();
  router.use(express.json());

  router.post('/', async (req, res) => {
    const origin = req.headers.origin;
    if (!isLoopbackHost(req.headers.host) || (origin && !isLoopbackHost(origin))) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Forbidden: non-local Host/Origin' },
        id: null,
      });
      return;
    }
    const server = createMcpServer(options);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
          id: null,
        });
      }
    }
  });

  return router;
}
