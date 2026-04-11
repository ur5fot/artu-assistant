import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent } from '@r2/shared';
import type { PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PiiProxy } from '../pii/proxy.js';
import type { OllamaClient } from './ollama.js';
import { shouldEscalate } from './escalation-check.js';

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

function anonymizeMessages(
  messages: MessageParam[],
  piiProxy: PiiProxy,
): Promise<MessageParam[]> {
  return Promise.all(
    messages.map(async (msg) => {
      if (typeof msg.content !== 'string') return msg;
      const result = await piiProxy.anonymize(msg.content);
      return { role: msg.role, content: result.text };
    }),
  );
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
  try {
    const anonymized = await anonymizeMessages(params.messages, params.piiProxy);
    const result = await params.ollama.chat({
      messages: anonymized,
      signal: params.signal,
    });
    ollamaText = result.text;
  } catch (err) {
    console.warn(
      '[router] Ollama unreachable, falling back to Claude:',
      err instanceof Error ? err.message : err,
    );
    await callClaudeFallback(params);
    return;
  }

  const decision = shouldEscalate(ollamaText);

  if (decision.escalate) {
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
