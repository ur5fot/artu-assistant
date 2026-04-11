export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  timestamp: number;
  piiEntities?: Array<{ type: string; original: string }>;
  source?: 'ollama' | 'claude';
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: ToolResult;
  status: 'running' | 'done' | 'error';
  progress?: string;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  display?: {
    type: 'text' | 'table' | 'link' | 'code' | 'file';
    content: string;
  };
}

export interface ToolContext {
  onProgress?: (message: string) => void;
  requestPlanReview?: (plan: string) => Promise<PlanReviewResponse>;
  signal?: AbortSignal;
  meta?: { autoMode?: boolean; callId?: string };
}

export interface PlanReviewResponse {
  approved: boolean;
  editedPlan?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  permissionLevel: 'auto' | 'confirm' | 'forbidden';
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (params: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolResult>;
  preCheck?: (input: Record<string, unknown>) => Promise<{ destructive: boolean; reason: string }>;
}

export type SSEEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_start'; toolCall: ToolCall }
  | { type: 'tool_progress'; id: string; message: string }
  | { type: 'tool_plan_review'; id: string; task: string; plan: string }
  | { type: 'tool_call_result'; id: string; result: ToolResult }
  | { type: 'tool_confirm_request'; toolCall: ToolCall; level: 'confirm' | 'forbidden'; destructiveWarning?: { reason: string } }
  | { type: 'pii_masked'; entities: Array<{ type: string; original: string }> }
  | { type: 'assistant_source'; source: 'ollama' | 'claude' }
  | { type: 'done' }
  | { type: 'error'; message: string };
