import { describe, it, expect } from 'vitest';
import { selectMcpTools, INTERNAL_TOOL_DENYLIST } from '../select-tools.js';
import { createRegistry } from '../../tools/registry.js';
import type { ToolDefinition } from '../../tools/base.js';

function makeTool(over: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    description: `desc for ${over.name}`,
    permissionLevel: 'auto',
    provider: 'all',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => ({ success: true }),
    ...over,
  };
}

function seed(tools: ToolDefinition[]) {
  const reg = createRegistry();
  for (const t of tools) reg.register(t);
  return reg;
}

describe('INTERNAL_TOOL_DENYLIST', () => {
  it('contains the R2-internal tool names', () => {
    expect(INTERNAL_TOOL_DENYLIST).toEqual(
      expect.arrayContaining([
        'code_deploy',
        'code_task',
        'task',
        'eval_add',
        'eval_run',
        'prompt_overlay_claude',
        'prompt_overlay_ollama',
      ]),
    );
  });
});

describe('selectMcpTools', () => {
  it('exposes non-internal tools', () => {
    const reg = seed([makeTool({ name: 'weather' }), makeTool({ name: 'reminder_create' })]);
    const names = selectMcpTools(reg).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['weather', 'reminder_create']));
  });

  it('excludes internal tool names', () => {
    const reg = seed([
      makeTool({ name: 'weather' }),
      makeTool({ name: 'code_deploy' }),
      makeTool({ name: 'eval_run' }),
      makeTool({ name: 'prompt_overlay_claude', permissionLevel: 'confirm' }),
    ]);
    const names = selectMcpTools(reg).map((t) => t.name);
    expect(names).toContain('weather');
    expect(names).not.toContain('code_deploy');
    expect(names).not.toContain('eval_run');
    expect(names).not.toContain('prompt_overlay_claude');
  });

  it('excludes any permissionLevel "forbidden" tool', () => {
    const reg = seed([
      makeTool({ name: 'weather' }),
      makeTool({ name: 'danger', permissionLevel: 'forbidden' }),
    ]);
    const names = selectMcpTools(reg).map((t) => t.name);
    expect(names).toContain('weather');
    expect(names).not.toContain('danger');
  });

  it('MCP_TOOL_DENYLIST extends the default denylist', () => {
    const reg = seed([makeTool({ name: 'weather' }), makeTool({ name: 'reminder_create' })]);
    const names = selectMcpTools(reg, ['reminder_create']).map((t) => t.name);
    expect(names).toContain('weather');
    expect(names).not.toContain('reminder_create');
  });

  it('still excludes internal tools when a custom denylist is given', () => {
    const reg = seed([makeTool({ name: 'weather' }), makeTool({ name: 'code_task' })]);
    const names = selectMcpTools(reg, ['weather']).map((t) => t.name);
    expect(names).not.toContain('weather');
    expect(names).not.toContain('code_task');
  });

  it('ignores unknown denylist entries', () => {
    const reg = seed([makeTool({ name: 'weather' })]);
    const names = selectMcpTools(reg, ['does_not_exist']).map((t) => t.name);
    expect(names).toEqual(['weather']);
  });
});
