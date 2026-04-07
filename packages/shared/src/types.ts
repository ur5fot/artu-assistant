export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: ToolResult;
  status: 'pending' | 'running' | 'done' | 'error';
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

export type SSEEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_start'; toolCall: ToolCall }
  | { type: 'tool_call_result'; id: string; result: ToolResult }
  | { type: 'done' }
  | { type: 'error'; message: string };
