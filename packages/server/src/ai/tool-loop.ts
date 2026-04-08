import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent, ToolCall, ToolResult } from '@r2/shared';
import type { ClaudeClient } from './claude.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ConfirmResponse, PendingConfirms } from '../routes/confirm.js';
import { toClaudeTool } from '../tools/base.js';
import { logToolCall, getPermissionRule, savePermissionRule } from '../db.js';
import type { PiiProxy } from '../pii/proxy.js';

const MAX_ITERATIONS = 10;

interface ToolLoopParams {
  messages: MessageParam[];
  client: ClaudeClient;
  registry: ToolRegistry;
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
  piiProxy: PiiProxy;
}

async function requestConfirmation(
  callId: string,
  toolCall: ToolCall,
  level: 'confirm' | 'forbidden',
  onEvent: (event: SSEEvent) => void,
  pendingConfirms: PendingConfirms,
  signal?: AbortSignal,
): Promise<ConfirmResponse> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ allowed: false, remember: false });
      return;
    }
    const onAbort = () => {
      pendingConfirms.delete(callId);
      resolve({ allowed: false, remember: false });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pendingConfirms.set(callId, (response) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(response);
    });
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
  piiProxy,
}: ToolLoopParams): Promise<void> {
  const allTools = registry.getAll();
  const tools: Tool[] = allTools.map(toClaudeTool) as Tool[];
  let currentMessages: MessageParam[] = [...messages];
  let iterations = 0;
  let lastEndedWithToolUse = false;

  // Anonymize user messages before sending to Claude
  const anonymizedMessages: MessageParam[] = [];
  const allPiiEntities: Array<{ type: string; token: string }> = [];
  for (const msg of currentMessages) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      const result = await piiProxy.anonymize(msg.content);
      anonymizedMessages.push({ role: 'user', content: result.text });
      allPiiEntities.push(...result.entities);
    } else {
      anonymizedMessages.push(msg);
    }
  }
  currentMessages = anonymizedMessages;

  // Emit pii_masked event if any PII was found
  if (allPiiEntities.length > 0) {
    const counts = new Map<string, number>();
    for (const e of allPiiEntities) {
      counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    }
    onEvent({
      type: 'pii_masked',
      entities: Array.from(counts.entries()).map(([type, count]) => ({ type, count })),
    });
  }

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
        const deanonText = await piiProxy.deanonymize(block.text);
        onEvent({ type: 'text_delta', content: deanonText });
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

      // Deanonymize tool input field-by-field to avoid JSON breakage from special chars
      const deanonInput: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(block.input as Record<string, unknown>)) {
        if (typeof value === 'string') {
          deanonInput[key] = await piiProxy.deanonymize(value);
        } else {
          deanonInput[key] = value;
        }
      }

      const toolCall: ToolCall = {
        id: block.id,
        name: block.name,
        input: deanonInput as Record<string, unknown>,
        status: 'running',
      };
      onEvent({ type: 'tool_call_start', toolCall });

      const toolDef = registry.get(block.name);
      let result: ToolResult;

      const startTime = Date.now();
      if (!toolDef) {
        result = { success: false, error: `Unknown tool: ${block.name}` };
      } else if (toolDef.permissionLevel === 'confirm' || toolDef.permissionLevel === 'forbidden') {
        // Check saved permission rule (only for 'confirm' level — 'forbidden' always asks)
        let allowed: boolean | null = null;
        if (toolDef.permissionLevel === 'confirm') {
          try {
            const rule = getPermissionRule(block.name);
            if (rule) allowed = rule.allowed;
          } catch (err) {
            console.error('Failed to read permission rule:', err instanceof Error ? err.message : err);
          }
        }

        if (allowed === null) {
          // Ask user for confirmation
          const confirmResponse = await requestConfirmation(
            block.id,
            toolCall,
            toolDef.permissionLevel,
            onEvent,
            pendingConfirms,
            signal,
          );
          allowed = confirmResponse.allowed;

          if (confirmResponse.remember && toolDef.permissionLevel === 'confirm') {
            try {
              savePermissionRule(block.name, confirmResponse.allowed);
            } catch (err) {
              console.error('Failed to save permission rule:', err instanceof Error ? err.message : err);
            }
          }
        }

        if (allowed) {
          try {
            result = await toolDef.handler(deanonInput);
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
          result = await toolDef.handler(deanonInput);
        } catch (err) {
          result = {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }
      }
      const durationMs = Date.now() - startTime;

      // Anonymize tool result before logging and sending back to Claude
      if (result.data) {
        const anonResult = await piiProxy.anonymize(JSON.stringify(result.data));
        if (anonResult.entities.length > 0) {
          result = { ...result, data: JSON.parse(anonResult.text) };
        }
      }

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
        const deanonText = await piiProxy.deanonymize(block.text);
        onEvent({ type: 'text_delta', content: deanonText });
      }
    }
  }

  onEvent({ type: 'done' });
}
