import type { ToolDefinition, ToolResult } from '@r2/shared';

export const codeDeployTool: ToolDefinition = {
  name: 'code_deploy',
  description: 'placeholder',
  permissionLevel: 'confirm',
  parameters: { type: 'object', properties: {}, required: [] },
  async handler(): Promise<ToolResult> {
    return { success: false, error: 'not implemented' };
  },
};

export default codeDeployTool;
