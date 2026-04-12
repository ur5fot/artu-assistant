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

  while (iterations < MAX_ITERATIONS) {
    if (signal?.aborted) return { escalate: false, reason: '' };
    iterations++;

    const result = await ollama.chat({
      messages: loopMessages as MessageParam[],
      system,
      signal,
      tools: ollamaTools,
    });

    if (signal?.aborted) return { escalate: false, reason: '' };

    // No tool calls — check for escalation or return text
    if (!result.toolCalls) {
      const decision = shouldEscalate(result.text);
      if (decision.escalate) {
        return { escalate: true, reason: decision.reason };
      }

      // Deanonymize and emit final text
      const deanonText = await piiProxy.deanonymize(result.text);
      if (signal?.aborted) return { escalate: false, reason: '' };
      onEvent({ type: 'text_delta', content: deanonText });
      return { escalate: false, reason: '' };
    }

    // Execute each tool call
    for (const tc of result.toolCalls) {
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
        loopMessages.push(
          { role: 'assistant', content: `Calling tool: ${tc.function.name}` } as MessageParam,
          { role: 'tool', content: JSON.stringify(errorResult) },
        );
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

      // Add assistant tool call + tool result to history for next iteration
      loopMessages.push(
        { role: 'assistant', content: `Calling tool: ${toolDef.name}` } as MessageParam,
        { role: 'tool', content: JSON.stringify(toolResult.success ? (toolResult.data ?? '') : (toolResult.error ?? 'Unknown error')) },
      );
    }
  }

  // Max iterations — emit warning
  onEvent({ type: 'text_delta', content: 'Досягнуто максимальну кількість ітерацій tools.' });
  return { escalate: false, reason: '' };
}
