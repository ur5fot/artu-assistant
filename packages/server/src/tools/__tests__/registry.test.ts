import { describe, it, expect, beforeEach } from 'vitest';
import { createRegistry } from '../registry.js';
import type { ToolDefinition } from '../base.js';

const mockTool: ToolDefinition = {
  name: 'test_tool',
  description: 'A test tool',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  handler: async () => ({ success: true, data: 'ok' }),
};

describe('Tool Registry', () => {
  it('registers and retrieves a tool', () => {
    const registry = createRegistry();
    registry.register(mockTool);
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.get('test_tool')).toBe(mockTool);
  });

  it('returns undefined for unknown tool', () => {
    const registry = createRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('prevents duplicate registration', () => {
    const registry = createRegistry();
    registry.register(mockTool);
    expect(() => registry.register(mockTool)).toThrow('already registered');
  });
});
