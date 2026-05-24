import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent } from '@r2/shared';
import type { PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PendingMemoryConfirms } from '../routes/memory-confirm.js';
import type { PiiProxy } from '../pii/proxy.js';
import type { OllamaClient } from './ollama.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { MemoryService } from '../memory/service.js';
import { shouldEscalate } from './escalation-check.js';
import { getLocalSystemPrompt } from './prompts.js';
import { toOllamaToolDef } from './ollama.js';
import { runOllamaToolLoop } from './ollama-tool-loop.js';
import { stripTimestampPrefix } from './timestamp-strip.js';
import { sanitizeHistory } from './sanitize-history.js';

export interface RunChatRequestParams {
  messages: MessageParam[];
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
  pendingPlanReviews?: PendingPlanReviews;
  pendingMemoryConfirms?: PendingMemoryConfirms;
  piiProxy: PiiProxy;
  ollama: OllamaClient | null;
  registry: ToolRegistry;
  memoryService: MemoryService | null;
  /**
   * Override for the memory-recall embedding query. When the caller rewrote
   * the last user message (e.g. slash-command → tool dispatcher), the rewritten
   * content is a meta-instruction, not the user's intent. Pass the original
   * user text here so buildContextPrefix retrieves relevant memories instead
   * of embedding `[User used command /...]` boilerplate.
   */
  memoryQuery?: string;
  /** Id of the user message triggering this turn — threaded into ToolContext so
   *  memory tools (memory_update, memory_forget_last) can tag or locate facts
   *  by source message. */
  currentUserMessageId?: string;
  currentUserMessageTimestamp?: number;
  forceProvider?: 'claude';
  /**
   * Topic-clustered summary block produced by `buildCompactedPrompt`. When
   * present it is injected as additional context (system suffix for Ollama,
   * prepended to the last user turn for Claude) so older, dropped turns are
   * still represented to the model. Not a chat turn — preserves alternation.
   */
  topicSummaryPrefix?: string;
  runLoop: (params: {
    messages: MessageParam[];
    onEvent: (event: SSEEvent) => void;
    signal?: AbortSignal;
    pendingConfirms?: PendingConfirms;
    pendingPlanReviews?: PendingPlanReviews;
    pendingMemoryConfirms?: PendingMemoryConfirms;
    piiProxy: PiiProxy;
    currentUserMessageId?: string;
    currentUserMessageTimestamp?: number;
  }) => Promise<void>;
}

async function callClaudeFallback(params: RunChatRequestParams): Promise<void> {
  if (!params.signal?.aborted) {
    params.onEvent({ type: 'assistant_source', source: 'claude' });
  }
  let messagesForClaude = params.messages;
  if ((params.memoryService || params.topicSummaryPrefix) && params.messages.length > 0) {
    const lastUserIdx = [...params.messages].reverse().findIndex((m) => m.role === 'user');
    if (lastUserIdx !== -1) {
      const idx = params.messages.length - 1 - lastUserIdx;
      const msg = params.messages[idx];
      const rawText = typeof msg.content === 'string' ? msg.content : '';
      const strippedText = stripTimestampPrefix(rawText);
      const userText = params.memoryQuery ?? strippedText;
      let memoryPrefix: string | null = null;
      if (params.memoryService && userText) {
        try {
          const { prefix, recalledFacts } = await params.memoryService.buildContextPrefix(userText, params.signal);
          memoryPrefix = prefix || null;
          if (recalledFacts.length > 0 && !params.signal?.aborted) {
            params.onEvent({ type: 'memory_recalled', facts: recalledFacts });
          }
        } catch (err) {
          console.warn('[router] memory context failed for claude:', err instanceof Error ? err.message : err);
        }
      }
      const prefixParts: string[] = [];
      if (memoryPrefix) prefixParts.push(memoryPrefix);
      if (params.topicSummaryPrefix) prefixParts.push(params.topicSummaryPrefix);
      if (prefixParts.length > 0) {
        const rewritten = [...params.messages];
        rewritten[idx] = { ...msg, content: `${prefixParts.join('\n\n')}\n\n${rawText}` };
        messagesForClaude = rewritten;
      }
    }
  }
  await params.runLoop({
    messages: messagesForClaude,
    onEvent: params.onEvent,
    signal: params.signal,
    pendingConfirms: params.pendingConfirms,
    pendingPlanReviews: params.pendingPlanReviews,
    pendingMemoryConfirms: params.pendingMemoryConfirms,
    piiProxy: params.piiProxy,
    currentUserMessageId: params.currentUserMessageId,
    currentUserMessageTimestamp: params.currentUserMessageTimestamp,
  });
}

/**
 * qwen2.5 sometimes emits a tool call as text in message content instead of
 * using the proper tool_calls channel. Try to recover it from common formats:
 *   1. `{ "name": "...", "arguments": {...} }` — OpenAI-style JSON wrapper
 *   2. `tool_name {...}` — function call notation (qwen favorite)
 *   3. bare `{...}` where first key looks like a tool parameter — risky,
 *      only parse if we can't match the other formats
 */
function tryParseToolCallFromContent(text: string): import('./ollama.js').OllamaToolCall | null {
  const trimmed = text.trim();

  // Format 1: { "name": "...", "arguments": {...} }
  if (trimmed.startsWith('{') && trimmed.includes('"name"') && trimmed.includes('"arguments"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        const name = parsed.name;
        const args = parsed.arguments;
        if (typeof name === 'string' && typeof args === 'object' && args !== null) {
          return { function: { name, arguments: args as Record<string, unknown> } };
        }
      }
    } catch {
      // fall through to next format
    }
  }

  // Format 2: tool_name {...}
  const match = trimmed.match(/^([a-z_][a-z0-9_]*)\s+(\{[\s\S]*\})\s*$/i);
  if (match) {
    const [, name, jsonStr] = match;
    try {
      const args = JSON.parse(jsonStr);
      if (typeof args === 'object' && args !== null) {
        return { function: { name, arguments: args as Record<string, unknown> } };
      }
    } catch {
      return null;
    }
  }

  return null;
}

async function emitEscalationAndFallback(params: RunChatRequestParams, reason: string): Promise<void> {
  const escalationMessage = `Escalating to Claude (${reason})`;
  params.onEvent({
    type: 'tool_call_start',
    toolCall: { id: 'router', name: 'router', input: { reason }, status: 'running' },
  });
  params.onEvent({ type: 'tool_progress', id: 'router', message: escalationMessage });
  params.onEvent({
    type: 'tool_call_result',
    id: 'router',
    result: { success: true, display: { type: 'text', content: escalationMessage } },
  });
  await callClaudeFallback(params);
}

export async function runChatRequest(params: RunChatRequestParams): Promise<void> {
  // Normalize past assistant turns so legacy formatting (markdown tables,
  // etc.) doesn't prime the model to replicate it. Applied ONCE at the
  // edge so both the Claude fallback and the Ollama branch see a clean
  // history without needing to know about the sanitization.
  params = { ...params, messages: sanitizeHistory(params.messages) };

  const mode = process.env.LOCAL_LLM_MODE || 'enabled';

  if (mode === 'disabled' || params.ollama === null || params.forceProvider === 'claude') {
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
  let ollamaToolCalls: import('./ollama.js').OllamaToolCall[] | undefined;
  const ollamaTools = params.registry.getForProvider('ollama');
  const toolSummary = ollamaTools.map((t) => ({ name: t.name, description: t.description }));
  const basePrompt = getLocalSystemPrompt(toolSummary);
  let systemPrompt = basePrompt;
  try {
    // PII anonymization is NOT applied for the local model — Ollama runs on
    // the user's own machine, so there is no external data boundary to
    // protect. Claude's tool-loop still anonymizes its own input from the
    // original messages when escalation happens.
    const ollamaToolDefs = ollamaTools.map(toOllamaToolDef);

    if (params.memoryService) {
      const lastMsg = params.messages[params.messages.length - 1];
      // Only build memory context from a user query. If the turn happens to
      // end on an assistant message (re-invocation path) we'd otherwise embed
      // assistant text as the "query" and retrieve irrelevant memories.
      const lastUserMsg = lastMsg?.role === 'user' ? lastMsg : undefined;
      const rawLastUserText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
      const strippedLastUserText = stripTimestampPrefix(rawLastUserText);
      const userText = params.memoryQuery ?? strippedLastUserText;
      if (userText) {
        try {
          const { prefix, recalledFacts } = await params.memoryService.buildContextPrefix(userText, params.signal);
          if (prefix) systemPrompt = prefix + '\n\n' + basePrompt;
          if (recalledFacts.length > 0 && !params.signal?.aborted) {
            params.onEvent({ type: 'memory_recalled', facts: recalledFacts });
          }
        } catch (err) {
          console.warn('[router] memory context failed:', err instanceof Error ? err.message : err);
        }
      }
    }
    if (params.topicSummaryPrefix) {
      systemPrompt = systemPrompt + '\n\n' + params.topicSummaryPrefix;
    }

    const result = await params.ollama.chat({
      messages: params.messages,
      system: systemPrompt,
      signal: params.signal,
      tools: ollamaToolDefs.length > 0 ? ollamaToolDefs : undefined,
    });
    ollamaText = result.text;
    ollamaToolCalls = result.toolCalls;

    // Recovery: qwen sometimes emits tool calls as JSON in content instead of
    // using the tool_calls channel. Parse `{ "name": "...", "arguments": {...} }`
    // and synthesize a proper tool_call so ollama-tool-loop can execute it.
    if (!ollamaToolCalls && ollamaText) {
      const recovered = tryParseToolCallFromContent(ollamaText);
      if (recovered) {
        console.log('[router] Recovered malformed tool call from Ollama content:', recovered.function.name);
        ollamaToolCalls = [recovered];
        ollamaText = '';
      }
    }
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

  // If Ollama called tools, run the Ollama tool-loop
  if (ollamaToolCalls) {
    if (params.signal?.aborted) return;

    params.onEvent({ type: 'assistant_source', source: 'ollama' });

    let loopResult: { escalate: boolean; reason: string };
    try {
      loopResult = await runOllamaToolLoop({
        messages: params.messages,
        ollama: params.ollama!,
        tools: ollamaTools,
        system: systemPrompt,
        onEvent: params.onEvent,
        signal: params.signal,
        pendingConfirms: params.pendingConfirms ?? new Map(),
        pendingPlanReviews: params.pendingPlanReviews ?? new Map(),
        pendingMemoryConfirms: params.pendingMemoryConfirms ?? new Map(),
        piiProxy: params.piiProxy,
        currentUserMessageId: params.currentUserMessageId,
        currentUserMessageTimestamp: params.currentUserMessageTimestamp,
        initialToolCalls: ollamaToolCalls,
      });
    } catch (err) {
      if (params.signal?.aborted) return;
      // Do NOT fall back to Claude here — some tools may have already
      // executed inside the loop.  Replaying from the original messages
      // would risk duplicate side-effects (writes, deploys, etc.).
      console.error(
        '[router] Ollama tool-loop failed (not falling back — tools may have executed):',
        err instanceof Error ? err.message : err,
      );
      params.onEvent({
        type: 'text_delta',
        content: 'An error occurred during tool execution. Please try again.',
      });
      params.onEvent({ type: 'done' });
      return;
    }

    if (loopResult.escalate) {
      await emitEscalationAndFallback(params, loopResult.reason);
      return;
    }

    if (!params.signal?.aborted) {
      params.onEvent({ type: 'done' });
    }
    return;
  }

  // Text-only response — check for escalation markers.
  // Emit the ollama source signal BEFORE the escalation branch so that a
  // later `assistant_source: 'claude'` from callClaudeFallback is correctly
  // recognized as an escalation by downstream consumers (e.g. Discord's
  // `🔵 claude` prefix). Emitting it only on the non-escalate path below
  // would hide the transition.
  if (params.signal?.aborted) return;
  params.onEvent({ type: 'assistant_source', source: 'ollama' });

  const decision = shouldEscalate(ollamaText!);

  if (decision.escalate) {
    if (params.signal?.aborted) return;
    await emitEscalationAndFallback(params, decision.reason);
    return;
  }

  if (params.signal?.aborted) return;
  // qwen2.5 sometimes mirrors the `[DD.MM.YYYY, HH:MM]` prefix that chat.ts
  // prepends to user messages. Claude does not exhibit this quirk.
  params.onEvent({ type: 'text_delta', content: stripTimestampPrefix(ollamaText!) });
  if (params.signal?.aborted) return;
  params.onEvent({ type: 'done' });
}
