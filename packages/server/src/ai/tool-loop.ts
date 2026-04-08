import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent, ToolCall, ToolResult } from '@r2/shared';
import type { ClaudeClient } from './claude.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ConfirmResponse } from '../routes/confirm.js';
import { toClaudeTool } from '../tools/base.js';
import { logToolCall, getPermissionRule, savePermissionRule } from '../db.js';

const MAX_ITERATIONS = 10;

export type PendingConfirms = Map<string, (response: ConfirmResponse) => void>;

interface ToolLoopParams {
  messages: MessageParam[];
  client: ClaudeClient;
  registry: ToolRegistry;
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
}

async function requestConfirmation(
  callId: string,
  toolCall: ToolCall,
  level: 'confirm' | 'forbidden',
  onEvent: (event: SSEEvent) => void,
  pendingConfirms: PendingConfirms,
): Promise<ConfirmResponse> {
  return new Promise((resolve) => {
    pendingConfirms.set(callId, resolve);
    onEvent({ type: 'tool_confirm_request', toolCall, level });
  });
}

export async function runToolLoop({
  messages,
  client,
  registry,
  onEvent,
  signal,
  pendingConfirms = new Map(),
}: ToolLoopParams): Promise<void> {
  const allTools = registry.getAll();
  const tools: Tool[] = allTools.map(toClaudeTool) as Tool[];
  let currentMessages: MessageParam[] = [...messages];
  let iterations = 0;
  let lastEndedWithToolUse = false;

  while (iterations < MAX_ITERATIONS) {
    if (signal?.aborted) return;
    iterations++;

    const response = await client.sendMessage({
      messages: currentMessages,
      tools,
      signal,
    });

    if (signal?.aborted) return;

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

    // Emit text
    for (const block of textBlocks) {
      if (block.type === 'text') {
        onEvent({ type: 'text_delta', content: block.text });
      }
    }

    // No tool calls — done
    if (toolUseBlocks.length === 0 || response.stop_reason !== 'tool_use') {
      lastEndedWithToolUse = false;
      break;
    }

    lastEndedWithToolUse = true;

    // Execute tools and collect results
    const toolResultContents: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }> = [];

    for (const block of toolUseBlocks) {
      if (block.type !== 'tool_use') continue;
      if (signal?.aborted) return;

      const toolCall: ToolCall = {
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
        status: 'running',
      };
      onEvent({ type: 'tool_call_start', toolCall });

      const toolDef = registry.get(block.name);
      let result: ToolResult;

      const startTime = Date.now();
      if (!toolDef) {
        result = { success: false, error: `Unknown tool: ${block.name}` };
      } else if (toolDef.permissionLevel === 'confirm' || toolDef.permissionLevel === 'forbidden') {
        // Check saved permission rule
        let allowed: boolean | null = null;
        try {
          const rule = getPermissionRule(block.name);
          if (rule) allowed = rule.allowed;
        } catch {
          // DB not initialized — proceed to ask user
        }

        if (allowed === null) {
          // Ask user for confirmation
          const confirmResponse = await requestConfirmation(
            block.id,
            toolCall,
            toolDef.permissionLevel,
            onEvent,
            pendingConfirms,
          );
          allowed = confirmResponse.allowed;

          if (confirmResponse.remember) {
            try {
              savePermissionRule(block.name, confirmResponse.allowed);
            } catch {
              // Permission save failure shouldn't break the flow
            }
          }
        }

        if (allowed) {
          try {
            result = await toolDef.handler(block.input as Record<string, unknown>);
          } catch (err) {
            result = {
              success: false,
              error: err instanceof Error ? err.message : 'Unknown error',
            };
          }
        } else {
          result = { success: false, error: 'Action denied by user' };
        }
      } else {
        try {
          result = await toolDef.handler(block.input as Record<string, unknown>);
        } catch (err) {
          result = {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }
      }
      const durationMs = Date.now() - startTime;

      try {
        logToolCall({
          toolName: block.name,
          input: block.input as Record<string, unknown>,
          result,
          success: result.success,
          durationMs,
        });
      } catch (err) {
        console.error('Audit log write failed:', err instanceof Error ? err.message : err);
      }

      onEvent({ type: 'tool_call_result', id: block.id, result });

      toolResultContents.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result.success ? (result.data ?? '') : (result.error ?? 'Unknown error')),
        ...(result.success ? {} : { is_error: true }),
      });
    }

    // Continue conversation with tool results
    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResultContents },
    ];
  }

  // If we hit max iterations without Claude giving a final text answer, ask it to wrap up
  if (iterations >= MAX_ITERATIONS && lastEndedWithToolUse && !signal?.aborted) {
    const finalResponse = await client.sendMessage({
      messages: [
        ...currentMessages,
        { role: 'user', content: 'Max tool iterations reached. Give a final answer now.' },
      ],
      tools: [],
      signal,
    });

    for (const block of finalResponse.content) {
      if (block.type === 'text') {
        onEvent({ type: 'text_delta', content: block.text });
      }
    }
  }

  onEvent({ type: 'done' });
}
