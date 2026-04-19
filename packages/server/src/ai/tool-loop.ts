import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent, ToolCall, ToolResult } from '@r2/shared';
import type { ClaudeClient } from './claude.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PendingMemoryConfirms } from '../routes/memory-confirm.js';
import { toClaudeTool } from '../tools/base.js';
import type { PiiProxy } from '../pii/proxy.js';
import { executeToolWithPermission, deanonDeep } from './tool-helpers.js';

const MAX_ITERATIONS = 10;

interface ToolLoopParams {
  messages: MessageParam[];
  client: ClaudeClient;
  registry: ToolRegistry;
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
  pendingPlanReviews?: PendingPlanReviews;
  pendingMemoryConfirms?: PendingMemoryConfirms;
  piiProxy: PiiProxy;
}

export async function runToolLoop({
  messages,
  client,
  registry,
  onEvent,
  signal,
  pendingConfirms = new Map(),
  pendingPlanReviews = new Map(),
  pendingMemoryConfirms = new Map(),
  piiProxy,
}: ToolLoopParams): Promise<void> {
  const allTools = registry.getForProvider('claude');
  const allowedToolMap = new Map(allTools.map((t) => [t.name, t]));
  const tools: Tool[] = allTools.map(toClaudeTool) as Tool[];
  let currentMessages: MessageParam[] = [...messages];
  let iterations = 0;
  let lastEndedWithToolUse = false;

  // Anonymize user messages before sending to Claude
  const anonymizedMessages: MessageParam[] = [];
  const allPiiEntities: Array<{ type: string; token: string; original: string }> = [];
  for (const msg of currentMessages) {
    if (signal?.aborted) return;
    if (typeof msg.content === 'string') {
      const result = await piiProxy.anonymize(msg.content);
      anonymizedMessages.push({ role: msg.role, content: result.text });
      if (msg.role === 'user') allPiiEntities.push(...result.entities);
    } else {
      anonymizedMessages.push(msg);
    }
  }
  currentMessages = anonymizedMessages;

  // Emit pii_masked event if any PII was found
  if (allPiiEntities.length > 0) {
    onEvent({
      type: 'pii_masked',
      entities: allPiiEntities.map((e) => ({ type: e.type, original: e.original })),
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

      const deanonInput = await deanonDeep(block.input, piiProxy) as Record<string, unknown>;

      const toolDef = allowedToolMap.get(block.name);
      if (!toolDef) {
        const toolCall: ToolCall = { id: block.id, name: block.name, input: deanonInput, status: 'running' };
        onEvent({ type: 'tool_call_start', toolCall });
        const result: ToolResult = { success: false, error: `Unknown tool: ${block.name}` };
        onEvent({ type: 'tool_call_result', id: block.id, result });
        toolResultContents.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result.error),
          is_error: true,
        });
        continue;
      }

      const { result } = await executeToolWithPermission({
        toolDef,
        blockId: block.id,
        input: deanonInput,
        onEvent,
        pendingConfirms,
        pendingPlanReviews,
        pendingMemoryConfirms,
        piiProxy,
        signal,
      });

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
