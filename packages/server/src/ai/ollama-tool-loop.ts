import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent, ToolDefinition } from '@r2/shared';
import type { PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PendingMemoryConfirms } from '../routes/memory-confirm.js';
import type { PiiProxy } from '../pii/proxy.js';
import type { OllamaClient, OllamaToolCall } from './ollama.js';
import { toOllamaToolDef } from './ollama.js';
import { executeToolWithPermission, deanonDeep } from './tool-helpers.js';
import { shouldEscalate } from './escalation-check.js';
import { stripTimestampPrefix } from './timestamp-strip.js';
import { isLocalReadTool } from './local-route.js';
import { buildLocalContext } from './local-context.js';
import crypto from 'node:crypto';

const MAX_ITERATIONS = 4;

interface OllamaToolLoopParams {
  messages: MessageParam[];
  ollama: OllamaClient;
  tools: ToolDefinition[];
  system: string;
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms: PendingConfirms;
  pendingPlanReviews: PendingPlanReviews;
  pendingMemoryConfirms: PendingMemoryConfirms;
  piiProxy: PiiProxy;
  currentUserMessageId?: string;
  currentUserMessageTimestamp?: number;
  /** Tool calls from the initial Ollama response — avoids a redundant chat() call. */
  initialToolCalls?: OllamaToolCall[];
}

export interface OllamaToolLoopResult {
  escalate: boolean;
  reason: string;
}

interface OllamaToolResultMessage {
  role: 'tool';
  content: string;
  tool_name: string;
}

type OllamaLoopMessage = MessageParam | OllamaToolResultMessage;

export function getNextLocalToolNames(
  executedTool: string,
  allowedToolNames: ReadonlySet<string>,
): string[] {
  const nextByTool: Readonly<Record<string, readonly string[]>> = {
    web_search: ['web_fetch'],
    file_list: ['file_read'],
    emails_status: ['emails_get'],
    emails_list: ['emails_get'],
  };
  return (nextByTool[executedTool] ?? []).filter((name) => allowedToolNames.has(name));
}

export async function runOllamaToolLoop(params: OllamaToolLoopParams): Promise<OllamaToolLoopResult> {
  const {
    ollama,
    tools,
    system,
    onEvent,
    signal,
    pendingConfirms,
    pendingPlanReviews,
    pendingMemoryConfirms,
    piiProxy,
    currentUserMessageId,
    currentUserMessageTimestamp,
  } = params;

  if (tools.some((tool) => !isLocalReadTool(tool.name))) {
    return { escalate: true, reason: 'unsafe_local_tool_set' };
  }

  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const allowedToolNames = new Set(toolMap.keys());
  let currentToolNames = new Set(allowedToolNames);
  const loopMessages: OllamaLoopMessage[] = [...params.messages];
  let pendingToolCalls: OllamaToolCall[] | undefined = params.initialToolCalls;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (signal?.aborted) return { escalate: false, reason: '' };

    let toolCalls: OllamaToolCall[] | undefined;
    let text = '';
    if (pendingToolCalls) {
      toolCalls = pendingToolCalls;
      pendingToolCalls = undefined;
    } else {
      const currentTools = [...currentToolNames]
        .map((name) => toolMap.get(name))
        .filter((tool): tool is ToolDefinition => !!tool);
      const currentToolDefs = currentTools.map(toOllamaToolDef);
      const localContext = buildLocalContext({
        messages: loopMessages as MessageParam[],
        system,
        tools: currentToolDefs,
      });
      if (!localContext.fits) {
        return { escalate: true, reason: `local_tool_${localContext.reason}` };
      }
      const result = await ollama.chat({
        messages: localContext.messages,
        system: localContext.system,
        signal,
        tools: currentToolDefs.length > 0 ? currentToolDefs : undefined,
      });
      if (signal?.aborted) return { escalate: false, reason: '' };
      toolCalls = result.toolCalls;
      text = result.text;
    }

    if (!toolCalls?.length) {
      const decision = shouldEscalate(text);
      if (decision.escalate) return { escalate: true, reason: decision.reason };

      const deanonText = stripTimestampPrefix(await piiProxy.deanonymize(text));
      if (signal?.aborted) return { escalate: false, reason: '' };
      if (deanonText) onEvent({ type: 'text_delta', content: deanonText });
      return { escalate: false, reason: '' };
    }

    const toolResults: Array<{ call: OllamaToolCall; content: string }> = [];
    for (const toolCall of toolCalls) {
      if (signal?.aborted) return { escalate: false, reason: '' };
      if (!currentToolNames.has(toolCall.function.name)) {
        return { escalate: true, reason: `unoffered_local_tool:${toolCall.function.name}` };
      }

      const toolDef = toolMap.get(toolCall.function.name);
      if (!toolDef) return { escalate: true, reason: `unknown_local_tool:${toolCall.function.name}` };

      const deanonInput = await deanonDeep(toolCall.function.arguments, piiProxy);
      const blockId = crypto.randomUUID();
      const { result: toolResult } = await executeToolWithPermission({
        toolDef,
        blockId,
        input: deanonInput as Record<string, unknown>,
        onEvent,
        pendingConfirms,
        pendingPlanReviews,
        pendingMemoryConfirms,
        piiProxy,
        currentUserMessageId,
        currentUserMessageTimestamp,
        signal,
      });

      const rawContent = toolResult.success ? (toolResult.data ?? '') : (toolResult.error ?? 'Unknown error');
      const content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
      toolResults.push({ call: toolCall, content });

      if (toolResult.success) {
        currentToolNames = new Set(getNextLocalToolNames(toolCall.function.name, allowedToolNames));
      }
    }

    loopMessages.push({
      role: 'assistant',
      content: '',
      tool_calls: toolCalls,
    } as unknown as MessageParam);
    for (const result of toolResults) {
      loopMessages.push({
        role: 'tool',
        tool_name: result.call.function.name,
        content: result.content,
      });
    }
  }

  return { escalate: true, reason: 'local_tool_iteration_limit' };
}
