import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent } from '@r2/shared';
import type { PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PiiProxy } from '../pii/proxy.js';
import type { OllamaClient } from './ollama.js';
import { shouldEscalate } from './escalation-check.js';
import { getLocalSystemPrompt } from './prompts.js';

export interface RunChatRequestParams {
  messages: MessageParam[];
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
  pendingPlanReviews?: PendingPlanReviews;
  piiProxy: PiiProxy;
  ollama: OllamaClient | null;
  runLoop: (params: {
    messages: MessageParam[];
    onEvent: (event: SSEEvent) => void;
    signal?: AbortSignal;
    pendingConfirms?: PendingConfirms;
    pendingPlanReviews?: PendingPlanReviews;
    piiProxy: PiiProxy;
  }) => Promise<void>;
}

interface AnonymizedBatch {
  messages: MessageParam[];
  entities: Array<{ type: string; original: string }>;
}

async function anonymizeMessages(
  messages: MessageParam[],
  piiProxy: PiiProxy,
): Promise<AnonymizedBatch> {
  const entities: Array<{ type: string; original: string }> = [];
  const collect = (role: MessageParam['role'], result: { entities: Array<{ type: string; original: string }> }) => {
    if (role === 'user') {
      for (const e of result.entities) entities.push({ type: e.type, original: e.original });
    }
  };
  const out = await Promise.all(
    messages.map(async (msg) => {
      if (typeof msg.content === 'string') {
        const result = await piiProxy.anonymize(msg.content);
        collect(msg.role, result);
        return { role: msg.role, content: result.text } as MessageParam;
      }
      if (Array.isArray(msg.content)) {
        // Router only lets text-only block arrays reach this function; still
        // guard each block defensively so a future shape change cannot leak
        // PII past Presidio.
        const newBlocks = await Promise.all(
          msg.content.map(async (block: any) => {
            if (block?.type === 'text' && typeof block.text === 'string') {
              const result = await piiProxy.anonymize(block.text);
              collect(msg.role, result);
              return { ...block, text: result.text };
            }
            return block;
          }),
        );
        return { role: msg.role, content: newBlocks } as MessageParam;
      }
      return msg;
    }),
  );
  return { messages: out, entities };
}

async function callClaudeFallback(params: RunChatRequestParams): Promise<void> {
  if (!params.signal?.aborted) {
    params.onEvent({ type: 'assistant_source', source: 'claude' });
  }
  await params.runLoop({
    messages: params.messages,
    onEvent: params.onEvent,
    signal: params.signal,
    pendingConfirms: params.pendingConfirms,
    pendingPlanReviews: params.pendingPlanReviews,
    piiProxy: params.piiProxy,
  });
}

export async function runChatRequest(params: RunChatRequestParams): Promise<void> {
  const mode = process.env.LOCAL_LLM_MODE || 'enabled';

  if (mode === 'disabled' || params.ollama === null) {
    await callClaudeFallback(params);
    return;
  }

  // Ollama only speaks plain text. Any tool_use / tool_result / image block
  // in history means we cannot serialize the turn — skip straight to Claude
  // without a wasted Presidio pass and without a misleading "unreachable" log.
  // Text-only block arrays are fine: ollama.ts flattens them to a string.
  const hasUnsupportedContent = params.messages.some((m) => {
    if (typeof m.content === 'string') return false;
    if (Array.isArray(m.content)) {
      return m.content.some((block: any) => block?.type !== 'text');
    }
    return true;
  });
  if (hasUnsupportedContent) {
    await callClaudeFallback(params);
    return;
  }

  let ollamaText: string | null = null;
  let piiEntities: Array<{ type: string; original: string }> = [];
  try {
    const anonymized = await anonymizeMessages(params.messages, params.piiProxy);
    piiEntities = anonymized.entities;
    const result = await params.ollama.chat({
      messages: anonymized.messages,
      system: getLocalSystemPrompt(),
      signal: params.signal,
    });
    ollamaText = result.text;
  } catch (err) {
    // Client aborted — do not waste a Claude call on a dead connection.
    if (params.signal?.aborted) return;
    console.warn(
      '[router] Ollama unreachable, falling back to Claude:',
      err instanceof Error ? err.message : err,
    );
    await callClaudeFallback(params);
    return;
  }

  const decision = shouldEscalate(ollamaText);

  if (decision.escalate) {
    if (params.signal?.aborted) return;
    // Synthesize a pseudo tool call so the escalation is visible in the UI.
    // A bare tool_progress event would be dropped by the client handler,
    // which only applies progress to an existing toolCalls entry.
    const escalationMessage = `Escalating to Claude (${decision.reason})`;
    params.onEvent({
      type: 'tool_call_start',
      toolCall: {
        id: 'router',
        name: 'router',
        input: { reason: decision.reason },
        status: 'running',
      },
    });
    params.onEvent({
      type: 'tool_progress',
      id: 'router',
      message: escalationMessage,
    });
    params.onEvent({
      type: 'tool_call_result',
      id: 'router',
      result: {
        success: true,
        display: { type: 'text', content: escalationMessage },
      },
    });
    // pii_masked is intentionally not emitted here — tool-loop will
    // re-anonymize from the original messages and emit its own event.
    await callClaudeFallback(params);
    return;
  }

  if (piiEntities.length > 0) {
    params.onEvent({ type: 'pii_masked', entities: piiEntities });
  }

  const deanonText = await params.piiProxy.deanonymize(ollamaText);
  if (params.signal?.aborted) return;
  params.onEvent({ type: 'assistant_source', source: 'ollama' });
  params.onEvent({ type: 'text_delta', content: deanonText });
  if (params.signal?.aborted) return;
  params.onEvent({ type: 'done' });
}
