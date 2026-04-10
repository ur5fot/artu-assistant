import type { ToolDefinition as SharedToolDefinition } from '@r2/shared';

export type { ToolDefinition, ToolContext, PlanReviewResponse } from '@r2/shared';

export function toClaudeTool(tool: SharedToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}
