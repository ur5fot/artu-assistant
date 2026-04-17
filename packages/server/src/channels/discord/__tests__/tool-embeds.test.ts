import { describe, it, expect } from 'vitest';
import { buildToolCallEmbed, SILENT_TOOLS } from '../tool-embeds.js';
import type { ToolCall } from '@r2/shared';

function mkTool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'call-1',
    name: 'file_write',
    input: { path: '/tmp/x.txt' },
    status: 'running',
    ...overrides,
  };
}

describe('SILENT_TOOLS', () => {
  it('contains memory_search and memory_save', () => {
    expect(SILENT_TOOLS).toContain('memory_search');
    expect(SILENT_TOOLS).toContain('memory_save');
  });
});

describe('buildToolCallEmbed — running', () => {
  it('returns null for silent tools', () => {
    const result = buildToolCallEmbed({
      state: 'running',
      toolCall: mkTool({ name: 'memory_search' }),
    });
    expect(result).toBeNull();
  });

  it('running embed has 🔧 icon and name', () => {
    const result = buildToolCallEmbed({
      state: 'running',
      toolCall: mkTool(),
    });
    expect(result).not.toBeNull();
    const e = result!.toJSON();
    expect(e.title).toBe('🔧 file_write');
    expect(e.description).toBe('running…');
    // Discord color is an integer; running is gray
    expect(typeof e.color).toBe('number');
  });
});
