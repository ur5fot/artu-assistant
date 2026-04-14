import type { ToolDefinition as SharedToolDefinition, SSEEvent } from '@r2/shared';
import type { PiiProxy } from '../pii/proxy.js';
import type { ClaudeClient } from '../ai/claude.js';
import type { ToolRegistry } from './registry.js';
import type { PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { MemoryService } from '../memory/service.js';
import type { ReminderStore } from '../reminders/store.js';

export type { ToolDefinition, ToolContext, PlanReviewResponse } from '@r2/shared';

export function toClaudeTool(tool: SharedToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

export interface RunLoopParams {
  messages: Array<{ role: 'user' | 'assistant'; content: string }> | any;
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
  pendingPlanReviews?: PendingPlanReviews;
}

export type RunLoopFn = (params: RunLoopParams) => Promise<void>;

export interface ToolDeps {
  runLoop: RunLoopFn;
  client: ClaudeClient;
  registry: ToolRegistry;
  piiProxy: PiiProxy;
  memoryService: MemoryService | null;
  reminderStore: ReminderStore | null;
}

export type ToolFactory = (deps: ToolDeps) => SharedToolDefinition | SharedToolDefinition[];
