import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent } from '@r2/shared';
import type { PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PiiProxy } from '../pii/proxy.js';
import type { OllamaClient } from './ollama.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { MemoryService } from '../memory/service.js';
import { shouldEscalate } from './escalation-check.js';
import { getLocalSystemPrompt } from './prompts.js';
import { toOllamaToolDef } from './ollama.js';
import { runOllamaToolLoop } from './ollama-tool-loop.js';

export interface RunChatRequestParams {
  messages: MessageParam[];
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
  pendingPlanReviews?: PendingPlanReviews;
  piiProxy: PiiProxy;
  ollama: OllamaClient | null;
  registry: ToolRegistry;
  memoryService: MemoryService | null;
  forceProvider?: 'claude';
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
  let messagesForClaude = params.messages;
  if (params.memoryService && params.messages.length > 0) {
    const lastUserIdx = [...params.messages].reverse().findIndex((m) => m.role === 'user');
    if (lastUserIdx !== -1) {
      const idx = params.messages.length - 1 - lastUserIdx;
      const msg = params.messages[idx];
      const userText = typeof msg.content === 'string' ? msg.content : '';
      if (userText) {
        try {
          const prefix = await params.memoryService.buildContextPrefix(userText);
          if (prefix) {
            const rewritten = [...params.messages];
            rewritten[idx] = { ...msg, content: `${prefix}\n\n${userText}` };
            messagesForClaude = rewritten;
          }
        } catch (err) {
          console.warn('[router] memory context failed for claude:', err instanceof Error ? err.message : err);
        }
      }
    }
  }
  await params.runLoop({
    messages: messagesForClaude,
    onEvent: params.onEvent,
    signal: params.signal,
    pendingConfirms: params.pendingConfirms,
    pendingPlanReviews: params.pendingPlanReviews,
    piiProxy: params.piiProxy,
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
  try {
    // PII anonymization is NOT applied for the local model — Ollama runs on
    // the user's own machine, so there is no external data boundary to
    // protect. Claude's tool-loop still anonymizes its own input from the
    // original messages when escalation happens.
    const ollamaToolDefs = ollamaTools.map(toOllamaToolDef);

    const basePrompt = getLocalSystemPrompt(toolSummary);
    let systemPrompt = basePrompt;
    if (params.memoryService) {
      const lastUserMsg = params.messages[params.messages.length - 1];
      const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
      if (userText) {
        try {
          const prefix = await params.memoryService.buildContextPrefix(userText);
          if (prefix) systemPrompt = prefix + '\n\n' + basePrompt;
        } catch (err) {
          console.warn('[router] memory context failed:', err instanceof Error ? err.message : err);
        }
      }
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
        system: getLocalSystemPrompt(toolSummary),
        onEvent: params.onEvent,
        signal: params.signal,
        pendingConfirms: params.pendingConfirms ?? new Map(),
        pendingPlanReviews: params.pendingPlanReviews ?? new Map(),
        piiProxy: params.piiProxy,
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

  // Text-only response — check for escalation markers
  const decision = shouldEscalate(ollamaText!);

  if (decision.escalate) {
    if (params.signal?.aborted) return;
    await emitEscalationAndFallback(params, decision.reason);
    return;
  }

  if (params.signal?.aborted) return;
  params.onEvent({ type: 'assistant_source', source: 'ollama' });
  params.onEvent({ type: 'text_delta', content: ollamaText! });
  if (params.signal?.aborted) return;
  params.onEvent({ type: 'done' });
}
