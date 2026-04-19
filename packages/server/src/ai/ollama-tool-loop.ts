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
  pendingMemoryConfirms: PendingMemoryConfirms;
  piiProxy: PiiProxy;
  currentUserMessageId?: string;
  currentUserMessageTimestamp?: number;
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

  const ollamaTools = tools.map(toOllamaToolDef);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  // Build message history — we maintain our own list since Ollama uses
  // a different format for tool result messages.
  const loopMessages: OllamaLoopMessage[] = [...params.messages];
  let iterations = 0;
  let pendingToolCalls: OllamaToolCall[] | undefined = params.initialToolCalls;
  let toolsExecuted = false;

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
      // Only escalate if no tools were executed yet — otherwise Claude
      // would replay already-executed tools from the original messages,
      // risking duplicate side-effects (writes, deploys, etc.).
      if (!toolsExecuted) {
        const decision = shouldEscalate(text);
        if (decision.escalate) {
          return { escalate: true, reason: decision.reason };
        }
      } else {
        // Strip escalation markers from text — we can't escalate after tools
        // executed, so don't leak raw markers like [need tool: ...] to the user.
        text = text.replace(/\[need\s+(?:code|tool)\b[^\]]*\]/gi, '').trim();
        // Self-check: ask Ollama to verify its own response against the
        // actual tool results in history, and rewrite if it hallucinated.
        text = await verifyAndCorrect(ollama, loopMessages, text, system, signal);
      }

      // Deanonymize and emit final text. Strip any leading `[DD.MM.YYYY, HH:MM]`
      // prefix qwen may have mirrored from the timestamped user turn.
      const deanonText = stripTimestampPrefix(await piiProxy.deanonymize(text));
      if (signal?.aborted) return { escalate: false, reason: '' };
      if (deanonText) {
        onEvent({ type: 'text_delta', content: deanonText });
      }
      return { escalate: false, reason: '' };
    }

    // Execute each tool call and collect results for Ollama history
    const toolResults: Array<{ call: OllamaToolCall; content: string }> = [];

    for (const tc of toolCalls) {
      if (signal?.aborted) return { escalate: false, reason: '' };

      const toolDef = toolMap.get(tc.function.name);
      if (!toolDef) {
        // Unknown tool — include available tool list so the model can retry with correct name.
        const availableNames = tools.map((t) => t.name).join(', ');
        const blockId = crypto.randomUUID();
        onEvent({
          type: 'tool_call_start',
          toolCall: { id: blockId, name: tc.function.name, input: tc.function.arguments, status: 'running' },
        });
        const errorResult = {
          success: false as const,
          error: `Unknown tool "${tc.function.name}". Available tools: ${availableNames}. Retry with a valid tool name.`,
        };
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
        pendingMemoryConfirms,
        piiProxy,
        currentUserMessageId,
        currentUserMessageTimestamp,
        signal,
      });

      const rawContent = toolResult.success ? (toolResult.data ?? '') : (toolResult.error ?? 'Unknown error');
      const resultContent = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
      toolResults.push({ call: tc, content: resultContent });
    }

    toolsExecuted = true;

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
  onEvent({ type: 'text_delta', content: 'Reached maximum number of tool iterations.' });
  return { escalate: false, reason: '' };
}

/**
 * Self-check pass: take the model's final response and ask it to verify
 * the response against the actual tool results in history. If the model
 * hallucinated (e.g. claimed bullet formatting when the file contains
 * flat text), it should rewrite the response to match reality.
 *
 * This adds one extra Ollama call but prevents the common failure mode
 * where qwen2.5:7b invents formatting or content that does not match
 * what the tools actually produced.
 */
async function verifyAndCorrect(
  ollama: OllamaClient,
  history: OllamaLoopMessage[],
  candidateText: string,
  system: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!candidateText.trim()) return candidateText;

  const verificationPrompt = `Ось твоя чернетка відповіді користувачу:

"""
${candidateText}
"""

Перевір цю відповідь проти РЕАЛЬНИХ результатів tools у попередніх повідомленнях.
Якщо відповідь точно описує що сталось — поверни її БЕЗ ЗМІН.
Якщо відповідь вигадує форматування, вміст, буллети, переноси рядків яких немає
в реальному tool result — перепиши її чесно.

Поверни ТІЛЬКИ фінальну відповідь користувачу, без метакоментарів.`;

  try {
    const result = await ollama.chat({
      messages: [
        ...(history as MessageParam[]),
        { role: 'user', content: verificationPrompt } as MessageParam,
      ],
      system,
      signal,
      // No tools — we only want text
    });
    const corrected = (result.text || '').trim();
    return corrected || candidateText;
  } catch {
    // If self-check fails for any reason, fall back to the original response
    return candidateText;
  }
}
