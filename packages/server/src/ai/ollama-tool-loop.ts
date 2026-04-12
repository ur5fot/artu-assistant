import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent, ToolDefinition } from '@r2/shared';
import type { PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PiiProxy } from '../pii/proxy.js';
import type { OllamaClient, OllamaToolCall } from './ollama.js';
import { toOllamaToolDef } from './ollama.js';
import { executeToolWithPermission, deanonDeep } from './tool-helpers.js';
import { shouldEscalate } from './escalation-check.js';
import crypto from 'node:crypto';

const MAX_ITERATIONS = 10;

interface OllamaToolLoopParams {
  messages: MessageParam[];
  ollama: OllamaClient;
  tools: ToolDefinition[];
  system: string;
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms: PendingConfirms;
  pendingPlanReviews: PendingPlanReviews;
  piiProxy: PiiProxy;
  /** Tool calls from the initial Ollama response — avoids a redundant chat() call. */
  initialToolCalls?: OllamaToolCall[];
}

interface OllamaToolLoopResult {
  escalate: boolean;
  reason: string;
}

/**
 * Ollama tool message format: role 'tool' with the result content.
 * We build these as MessageParam-compatible objects that toOllamaMessage
 * will handle, but since Ollama uses a different message format for tool
 * results, we track them separately.
 */
interface OllamaToolResultMessage {
  role: 'tool';
  content: string;
}

type OllamaLoopMessage = MessageParam | OllamaToolResultMessage;

export async function runOllamaToolLoop(params: OllamaToolLoopParams): Promise<OllamaToolLoopResult> {
  const { ollama, tools, system, onEvent, signal, pendingConfirms, pendingPlanReviews, piiProxy } = params;

  const ollamaTools = tools.map(toOllamaToolDef);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  // Build message history — we maintain our own list since Ollama uses
  // a different format for tool result messages.
  const loopMessages: OllamaLoopMessage[] = [...params.messages];
  let iterations = 0;
  let pendingToolCalls: OllamaToolCall[] | undefined = params.initialToolCalls;

  while (iterations < MAX_ITERATIONS) {
    if (signal?.aborted) return { escalate: false, reason: '' };
    iterations++;

    let toolCalls: OllamaToolCall[] | undefined;
    let text: string;

    if (pendingToolCalls) {
      // Use tool calls from initial response (first iteration) — avoids
      // a redundant ollama.chat() call.
      toolCalls = pendingToolCalls;
      text = '';
      pendingToolCalls = undefined;
    } else {
      const result = await ollama.chat({
        messages: loopMessages as MessageParam[],
        system,
        signal,
        tools: ollamaTools,
      });

      if (signal?.aborted) return { escalate: false, reason: '' };
      toolCalls = result.toolCalls;
      text = result.text;
    }

    // No tool calls — check for escalation or return text
    if (!toolCalls) {
      const decision = shouldEscalate(text);
      if (decision.escalate) {
        return { escalate: true, reason: decision.reason };
      }

      // Deanonymize and emit final text
      const deanonText = await piiProxy.deanonymize(text);
      if (signal?.aborted) return { escalate: false, reason: '' };
      onEvent({ type: 'text_delta', content: deanonText });
      return { escalate: false, reason: '' };
    }

    // Execute each tool call and collect results for Ollama history
    const toolResults: Array<{ call: OllamaToolCall; content: string }> = [];

    for (const tc of toolCalls) {
      if (signal?.aborted) return { escalate: false, reason: '' };

      const toolDef = toolMap.get(tc.function.name);
      if (!toolDef) {
        // Unknown tool — add error result and continue
        const blockId = crypto.randomUUID();
        onEvent({
          type: 'tool_call_start',
          toolCall: { id: blockId, name: tc.function.name, input: tc.function.arguments, status: 'running' },
        });
        const errorResult = { success: false as const, error: `Unknown tool: ${tc.function.name}` };
        onEvent({ type: 'tool_call_result', id: blockId, result: errorResult });
        toolResults.push({ call: tc, content: JSON.stringify(errorResult) });
        continue;
      }

      // Deanonymize tool input
      const deanonInput = await deanonDeep(tc.function.arguments, piiProxy);

      const blockId = crypto.randomUUID();
      const { result: toolResult } = await executeToolWithPermission({
        toolDef,
        blockId,
        input: deanonInput as Record<string, unknown>,
        onEvent,
        pendingConfirms,
        pendingPlanReviews,
        piiProxy,
        signal,
      });

      const resultContent = JSON.stringify(toolResult.success ? (toolResult.data ?? '') : (toolResult.error ?? 'Unknown error'));
      toolResults.push({ call: tc, content: resultContent });
    }

    // Add assistant message with tool_calls + individual tool results to history.
    // Ollama expects the assistant turn to carry the tool_calls array, and each
    // tool result as a separate { role: 'tool' } message.
    loopMessages.push({
      role: 'assistant',
      content: '',
      tool_calls: toolCalls,
    } as unknown as MessageParam);
    for (const tr of toolResults) {
      loopMessages.push({ role: 'tool', content: tr.content });
    }
  }

  // Max iterations — emit warning
  onEvent({ type: 'text_delta', content: 'Досягнуто максимальну кількість ітерацій tools.' });
  return { escalate: false, reason: '' };
}
