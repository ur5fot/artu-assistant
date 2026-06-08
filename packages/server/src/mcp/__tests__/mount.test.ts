import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mountMcpRouter } from '../mount.js';
import { createRegistry, type ToolRegistry } from '../../tools/registry.js';
import type { ToolDefinition } from '../../tools/base.js';

function makeRegistry(): ToolRegistry {
  const registry = createRegistry();
  const tool: ToolDefinition = {
    name: 'ping',
    description: 'ping',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => ({ success: true, data: { pong: true } }),
  };
  registry.register(tool);
  return registry;
}

describe('mountMcpRouter', () => {
  let app: express.Express;
  let registry: ToolRegistry;

  beforeEach(() => {
    app = express();
    registry = makeRegistry();
  });

  it('mounts the /mcp route when enabled and serves the registered tools', async () => {
    const mounted = mountMcpRouter(app, { enabled: true, registry, denylist: [] });
    expect(mounted).toBe(true);

    // A POST to /mcp reaches the MCP transport and a real tools/list exchange
    // returns the registered tool — not just "the route exists".
    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
    // Streamable HTTP replies as SSE; the JSON-RPC result is in the body text.
    expect(res.text).toContain('ping');
  });

  it('rejects a non-local Host header (DNS-rebinding guard)', async () => {
    mountMcpRouter(app, { enabled: true, registry, denylist: [] });
    const res = await request(app)
      .post('/mcp')
      .set('Host', 'evil.example.com')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(403);
  });

  it('does not mount the /mcp route when disabled', async () => {
    const mounted = mountMcpRouter(app, { enabled: false, registry, denylist: [] });
    expect(mounted).toBe(false);

    const res = await request(app).post('/mcp').send({});
    expect(res.status).toBe(404);
  });
});
