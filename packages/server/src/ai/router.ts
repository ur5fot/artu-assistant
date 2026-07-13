import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent, ToolDefinition } from '@r2/shared';
import type { PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PendingMemoryConfirms } from '../routes/memory-confirm.js';
import type { PiiProxy } from '../pii/proxy.js';
import type { OllamaClient, OllamaToolCall } from './ollama.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { MemoryService } from '../memory/service.js';
import { shouldEscalate } from './escalation-check.js';
import { getLocalSystemPrompt } from './prompts.js';
import { toOllamaToolDef } from './ollama.js';
import { runOllamaToolLoop } from './ollama-tool-loop.js';
import { stripTimestampPrefix } from './timestamp-strip.js';
import { sanitizeHistory } from './sanitize-history.js';
import { buildLocalContext } from './local-context.js';
import { decideLocalRoute, type LocalDomain } from './local-route.js';
import { logLocalRoute } from './local-telemetry.js';

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
  /** Original user text when chat.ts rewrites a slash command for the LLM. */
  memoryQuery?: string;
  /** Exact tool selected by a recognized slash command. */
  requestedToolName?: string;
  currentUserMessageId?: string;
  currentUserMessageTimestamp?: number;
  forceProvider?: 'claude';
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
  if (!params.signal?.aborted) params.onEvent({ type: 'assistant_source', source: 'claude' });

  let messagesForClaude = params.messages;
  if ((params.memoryService || params.topicSummaryPrefix) && params.messages.length > 0) {
    const lastUserIdx = [...params.messages].reverse().findIndex((message) => message.role === 'user');
    if (lastUserIdx !== -1) {
      const index = params.messages.length - 1 - lastUserIdx;
      const message = params.messages[index];
      const rawText = typeof message.content === 'string' ? message.content : '';
      const userText = params.memoryQuery ?? stripTimestampPrefix(rawText);
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
      const prefixParts = [memoryPrefix, params.topicSummaryPrefix].filter((value): value is string => !!value);
      if (prefixParts.length > 0) {
        const rewritten = [...params.messages];
        rewritten[index] = { ...message, content: `${prefixParts.join('\n\n')}\n\n${rawText}` };
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

function tryParseToolCallFromContent(text: string): OllamaToolCall | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.includes('"name"') && trimmed.includes('"arguments"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof parsed.name === 'string' &&
        typeof parsed.arguments === 'object' &&
        parsed.arguments !== null
      ) {
        return { function: { name: parsed.name, arguments: parsed.arguments as Record<string, unknown> } };
      }
    } catch {
      // Try qwen's function-call notation below.
    }
  }

  const match = trimmed.match(/^([a-z_][a-z0-9_]*)\s+(\{[\s\S]*\})\s*$/i);
  if (!match) return null;
  try {
    const args = JSON.parse(match[2]);
    return typeof args === 'object' && args !== null
      ? { function: { name: match[1], arguments: args as Record<string, unknown> } }
      : null;
  } catch {
    return null;
  }
}

function messageText(message: MessageParam): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n');
}

function routingText(params: RunChatRequestParams): string {
  const userMessages = params.messages.filter((message) => message.role === 'user');
  const current = params.memoryQuery ?? stripTimestampPrefix(messageText(userMessages.at(-1) ?? params.messages.at(-1)!));
  if (params.requestedToolName || current.trim().split(/\s+/).length > 3 || userMessages.length < 2) {
    return current;
  }
  const previous = stripTimestampPrefix(messageText(userMessages.at(-2)!));
  return `${previous}\n${current}`;
}

async function emitEscalationAndFallback(params: RunChatRequestParams, reason: string): Promise<void> {
  const message = `Escalating to Claude (${reason})`;
  params.onEvent({
    type: 'tool_call_start',
    toolCall: { id: 'router', name: 'router', input: { reason }, status: 'running' },
  });
  params.onEvent({ type: 'tool_progress', id: 'router', message });
  params.onEvent({
    type: 'tool_call_result',
    id: 'router',
    result: { success: true, display: { type: 'text', content: message } },
  });
  await callClaudeFallback(params);
}

export async function runChatRequest(input: RunChatRequestParams): Promise<void> {
  const startedAt = Date.now();
  const params = { ...input, messages: sanitizeHistory(input.messages) };
  const record = (event: {
    provider: 'ollama' | 'claude';
    routeReason: string;
    domain?: LocalDomain | null;
    tools?: string[];
    estimatedPromptTokens?: number;
    fallbackReason?: string;
  }) => logLocalRoute({
    provider: event.provider,
    routeReason: event.routeReason,
    domain: event.domain ?? null,
    tools: event.tools ?? [],
    estimatedPromptTokens: event.estimatedPromptTokens,
    latencyMs: Date.now() - startedAt,
    fallbackReason: event.fallbackReason,
  });
  const runClaude = async (reason: string, fallbackReason?: string, domain: LocalDomain | null = null, tools: string[] = [], estimatedPromptTokens?: number) => {
    try {
      await callClaudeFallback(params);
    } finally {
      record({ provider: 'claude', routeReason: reason, domain, tools, estimatedPromptTokens, fallbackReason });
    }
  };

  const mode = process.env.LOCAL_LLM_MODE || 'enabled';
  if (mode === 'disabled') return runClaude('local_llm_disabled');
  if (params.ollama === null) return runClaude('ollama_not_configured');
  if (params.forceProvider === 'claude') return runClaude('forced_claude');

  const hasUnsupportedContent = params.messages.some((message) => {
    if (typeof message.content === 'string') return false;
    if (Array.isArray(message.content)) return message.content.some((block: any) => block?.type !== 'text');
    return true;
  });
  if (hasUnsupportedContent) return runClaude('unsupported_local_content');

  const route = decideLocalRoute({
    text: routingText(params),
    requestedToolName: params.requestedToolName,
  });
  if (route.provider === 'claude') return runClaude(route.reason, undefined, route.domain);

  const ollamaTools: ToolDefinition[] = [];
  for (const name of route.toolNames) {
    const tool = params.registry.get(name);
    if (!tool || tool.provider === 'claude') {
      return runClaude(route.reason, `local_tool_unavailable:${name}`, route.domain, route.toolNames);
    }
    ollamaTools.push(tool);
  }
  const ollamaToolDefs = ollamaTools.map(toOllamaToolDef);
  const basePrompt = getLocalSystemPrompt(route.domain ?? 'chat');
  const requiredContext = buildLocalContext({
    messages: params.messages,
    system: basePrompt,
    tools: ollamaToolDefs,
  });
  if (!requiredContext.fits) {
    return runClaude(route.reason, requiredContext.reason, route.domain, route.toolNames, requiredContext.estimatedPromptTokens);
  }

  let memoryPrefix: string | null = null;
  if (params.memoryService) {
    const query = params.memoryQuery ?? stripTimestampPrefix(messageText(params.messages.at(-1)!));
    if (query) {
      try {
        const { prefix, recalledFacts } = await params.memoryService.buildContextPrefix(query, params.signal);
        memoryPrefix = prefix || null;
        if (recalledFacts.length > 0 && !params.signal?.aborted) {
          params.onEvent({ type: 'memory_recalled', facts: recalledFacts });
        }
      } catch (err) {
        console.warn('[router] memory context failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  const localContext = buildLocalContext({
    messages: params.messages,
    system: basePrompt,
    tools: ollamaToolDefs,
    memoryPrefix,
    topicSummaryPrefix: params.topicSummaryPrefix,
  });
  if (!localContext.fits) {
    return runClaude(route.reason, localContext.reason, route.domain, route.toolNames, localContext.estimatedPromptTokens);
  }

  let ollamaText = '';
  let ollamaToolCalls: OllamaToolCall[] | undefined;
  try {
    const result = await params.ollama.chat({
      messages: localContext.messages,
      system: localContext.system,
      signal: params.signal,
      tools: ollamaToolDefs.length > 0 ? ollamaToolDefs : undefined,
    });
    ollamaText = result.text;
    ollamaToolCalls = result.toolCalls;
    if (!ollamaToolCalls?.length && ollamaText) {
      const recovered = tryParseToolCallFromContent(ollamaText);
      if (recovered) {
        console.info('[router] recovered malformed Ollama tool call:', recovered.function.name);
        ollamaToolCalls = [recovered];
        ollamaText = '';
      }
    }
  } catch (err) {
    if (params.signal?.aborted) return;
    console.warn('[router] Ollama failed, falling back to Claude:', err instanceof Error ? err.message : err);
    return runClaude(route.reason, 'ollama_request_failed', route.domain, route.toolNames, localContext.estimatedPromptTokens);
  }

  if (params.signal?.aborted) return;
  params.onEvent({ type: 'assistant_source', source: 'ollama' });

  if (ollamaToolCalls?.length) {
    let loopResult: Awaited<ReturnType<typeof runOllamaToolLoop>>;
    try {
      loopResult = await runOllamaToolLoop({
        messages: localContext.messages,
        ollama: params.ollama,
        tools: ollamaTools,
        system: localContext.system,
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
      console.error('[router] local read-only tool loop failed:', err instanceof Error ? err.message : err);
      try {
        await emitEscalationAndFallback(params, 'local_tool_loop_failed');
      } finally {
        record({
          provider: 'claude',
          routeReason: route.reason,
          domain: route.domain,
          tools: route.toolNames,
          estimatedPromptTokens: localContext.estimatedPromptTokens,
          fallbackReason: 'local_tool_loop_failed',
        });
      }
      return;
    }

    if (loopResult.escalate) {
      try {
        await emitEscalationAndFallback(params, loopResult.reason);
      } finally {
        record({
          provider: 'claude',
          routeReason: route.reason,
          domain: route.domain,
          tools: route.toolNames,
          estimatedPromptTokens: localContext.estimatedPromptTokens,
          fallbackReason: loopResult.reason,
        });
      }
      return;
    }

    if (!params.signal?.aborted) params.onEvent({ type: 'done' });
    record({
      provider: 'ollama',
      routeReason: route.reason,
      domain: route.domain,
      tools: route.toolNames,
      estimatedPromptTokens: localContext.estimatedPromptTokens,
    });
    return;
  }

  const escalation = shouldEscalate(ollamaText);
  if (escalation.escalate) {
    try {
      await emitEscalationAndFallback(params, escalation.reason);
    } finally {
      record({
        provider: 'claude',
        routeReason: route.reason,
        domain: route.domain,
        tools: route.toolNames,
        estimatedPromptTokens: localContext.estimatedPromptTokens,
        fallbackReason: escalation.reason,
      });
    }
    return;
  }

  params.onEvent({ type: 'text_delta', content: stripTimestampPrefix(ollamaText) });
  if (!params.signal?.aborted) params.onEvent({ type: 'done' });
  record({
    provider: 'ollama',
    routeReason: route.reason,
    domain: route.domain,
    tools: route.toolNames,
    estimatedPromptTokens: localContext.estimatedPromptTokens,
  });
}
