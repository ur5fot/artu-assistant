import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent } from '@r2/shared';
import type { PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PiiProxy } from '../pii/proxy.js';
import type { OllamaClient } from './ollama.js';
import { shouldEscalate } from './escalation-check.js';
import { getSystemPrompt } from './prompts.js';

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
  const out = await Promise.all(
    messages.map(async (msg) => {
      if (typeof msg.content !== 'string') return msg;
      const result = await piiProxy.anonymize(msg.content);
      if (msg.role === 'user') {
        for (const e of result.entities) entities.push({ type: e.type, original: e.original });
      }
      return { role: msg.role, content: result.text } as MessageParam;
    }),
  );
  return { messages: out, entities };
}

async function callClaudeFallback(params: RunChatRequestParams): Promise<void> {
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

  let ollamaText: string | null = null;
  let piiEntities: Array<{ type: string; original: string }> = [];
  try {
    const anonymized = await anonymizeMessages(params.messages, params.piiProxy);
    piiEntities = anonymized.entities;
    const result = await params.ollama.chat({
      messages: anonymized.messages,
      system: getSystemPrompt(),
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

  if (piiEntities.length > 0) {
    params.onEvent({ type: 'pii_masked', entities: piiEntities });
  }

  const decision = shouldEscalate(ollamaText);

  if (decision.escalate) {
    if (params.signal?.aborted) return;
    params.onEvent({
      type: 'tool_progress',
      id: 'router',
      message: `Escalating to Claude (${decision.reason})`,
    });
    await callClaudeFallback(params);
    return;
  }

  const deanonText = await params.piiProxy.deanonymize(ollamaText);
  params.onEvent({ type: 'text_delta', content: deanonText });
  params.onEvent({ type: 'done' });
}
