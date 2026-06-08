import { describe, it, expect } from 'vitest';
import { toMcpTool } from '../to-mcp-tool.js';
import type { ToolDefinition } from '../../tools/base.js';

const baseTool: ToolDefinition = {
  name: 'weather',
  description: 'Get the weather',
  permissionLevel: 'auto',
  provider: 'all',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  handler: async () => ({ success: true, data: 'ok' }),
};

describe('toMcpTool', () => {
  it('passes name and description through', () => {
    const mcp = toMcpTool(baseTool);
    expect(mcp.name).toBe('weather');
    expect(mcp.description).toBe('Get the weather');
  });

  it('builds inputSchema from parameters (type/properties/required)', () => {
    const mcp = toMcpTool(baseTool);
    expect(mcp.inputSchema).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    });
  });

  it('omits readOnlyHint', () => {
    const mcp = toMcpTool(baseTool);
    expect(mcp.annotations?.readOnlyHint).toBeUndefined();
  });

  it('sets destructiveHint:true for permissionLevel "confirm"', () => {
    const mcp = toMcpTool({ ...baseTool, permissionLevel: 'confirm' });
    expect(mcp.annotations?.destructiveHint).toBe(true);
  });

  it('sets destructiveHint:true for a tool with a preCheck', () => {
    const mcp = toMcpTool({
      ...baseTool,
      preCheck: async () => ({ destructive: true, reason: 'x' }),
    });
    expect(mcp.annotations?.destructiveHint).toBe(true);
  });

  it('does not set destructiveHint for a plain auto tool', () => {
    const mcp = toMcpTool(baseTool);
    expect(mcp.annotations?.destructiveHint).toBeUndefined();
  });

  it('sets destructiveHint:true for an auto tool with explicit destructiveHint', () => {
    const mcp = toMcpTool({ ...baseTool, permissionLevel: 'auto', destructiveHint: true });
    expect(mcp.annotations?.destructiveHint).toBe(true);
  });

  it('sets destructiveHint:true when preCheck is present even at auto level', () => {
    const mcp = toMcpTool({
      ...baseTool,
      permissionLevel: 'auto',
      preCheck: async () => ({ destructive: false, reason: '' }),
    });
    expect(mcp.annotations?.destructiveHint).toBe(true);
  });

  it('handles a tool with no required array', () => {
    const { required, ...noReqParams } = baseTool.parameters;
    const mcp = toMcpTool({ ...baseTool, parameters: noReqParams });
    expect(mcp.inputSchema).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
    });
    expect((mcp.inputSchema as { required?: unknown }).required).toBeUndefined();
  });
});
