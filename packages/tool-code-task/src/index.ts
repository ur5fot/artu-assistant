import type { ToolDefinition, ToolResult } from '@r2/shared';

export const codeTaskTool: ToolDefinition = {
  name: 'code_task',
  description: 'placeholder',
  permissionLevel: 'confirm',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async handler(_params, _ctx): Promise<ToolResult> {
    return { success: false, error: 'not implemented' };
  },
};

export default codeTaskTool;
