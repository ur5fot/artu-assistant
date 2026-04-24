import type { ToolDefinition as SharedToolDefinition, SSEEvent } from '@r2/shared';
import type { PiiProxy } from '../pii/proxy.js';
import type { ClaudeClient } from '../ai/claude.js';
import type { ToolRegistry } from './registry.js';
import type { PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PendingMemoryConfirms } from '../routes/memory-confirm.js';
import type { MemoryService } from '../memory/service.js';
import type { ReminderStore } from '../reminders/store.js';
import type { EmailStore } from '../emails/store.js';
import type { ImapAccount, NewMessage, FullMessage } from '../emails/types.js';

export type { ToolDefinition, ToolContext, PlanReviewResponse } from '@r2/shared';

export interface ImapClient {
  fetchNewMessages: (account: ImapAccount, sinceUid: number, limit: number) => Promise<NewMessage[]>;
  fetchFullBody: (account: ImapAccount, uid: number) => Promise<FullMessage>;
  getAccount: (id: string) => ImapAccount | null;
}

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
  pendingMemoryConfirms?: PendingMemoryConfirms;
}

export type RunLoopFn = (params: RunLoopParams) => Promise<void>;

export interface ToolDeps {
  runLoop: RunLoopFn;
  client: ClaudeClient;
  registry: ToolRegistry;
  piiProxy: PiiProxy;
  memoryService: MemoryService | null;
  reminderStore: ReminderStore | null;
  emailStore: EmailStore | null;
  imapClient: ImapClient | null;
}

export type ToolFactory = (deps: ToolDeps) => SharedToolDefinition | SharedToolDefinition[];
