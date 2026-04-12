import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SSEEvent } from '@r2/shared';
import type { ToolCall } from '@r2/shared';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { PendingConfirms } from './confirm.js';
import type { PendingPlanReviews } from './plan-review.js';
import type { PiiProxy } from '../pii/proxy.js';
import type { OllamaClient } from '../ai/ollama.js';
import type { ToolRegistry } from '../tools/registry.js';
import { runChatRequest } from '../ai/router.js';
import { saveMessage } from '../db.js';
import crypto from 'node:crypto';

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString('uk-UA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function addTimestamps(messages: Array<{ role: string; content: string; timestamp?: number }>): MessageParam[] {
  return messages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.timestamp ? `[${formatTimestamp(m.timestamp)}] ${m.content}` : m.content,
  }));
}

function sanitizeError(message: string): string {
  // Strip potentially sensitive details (API keys, internal paths, upstream provider info)
  const lower = message.toLowerCase();
  if (lower.includes('anthropic') || lower.includes('sk-ant-')) {
    return 'AI service temporarily unavailable';
  }
  if (lower.includes('searxng') || lower.includes('web search failed') || lower.includes('search error') || lower.includes('search returned')) {
    return 'Search service temporarily unavailable';
  }
  // For other errors, return a generic message in production
  if (process.env.NODE_ENV === 'production') {
    return 'An internal error occurred';
  }
  return message;
}

interface ChatRouterDeps {
  runLoop: (params: {
    messages: MessageParam[];
    onEvent: (event: SSEEvent) => void;
    signal?: AbortSignal;
    pendingConfirms?: PendingConfirms;
    pendingPlanReviews?: PendingPlanReviews;
    piiProxy: PiiProxy;
  }) => Promise<void>;
  pendingConfirms: PendingConfirms;
  pendingPlanReviews: PendingPlanReviews;
  piiProxy: PiiProxy;
  ollama: OllamaClient | null;
  registry: ToolRegistry;
}

export function createChatRouter({ runLoop, pendingConfirms, pendingPlanReviews, piiProxy, ollama, registry }: ChatRouterDeps): Router {
  const router = Router();

  router.post('/chat', async (req: Request, res: Response) => {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'messages[] required' });
      return;
    }

    const validRoles = new Set(['user', 'assistant']);
    const valid = messages.every(
      (m: unknown) =>
        typeof m === 'object' && m !== null &&
        'role' in m && validRoles.has((m as { role: string }).role) &&
        'content' in m && typeof (m as { content: string }).content === 'string'
    );
    if (!valid) {
      res.status(400).json({ error: 'Each message must have role (user|assistant) and content (string)' });
      return;
    }

    // Save the latest user message to DB
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      try {
        saveMessage({
          messageId: lastMsg.id || crypto.randomUUID(),
          role: 'user',
          content: lastMsg.content,
          timestamp: lastMsg.timestamp || Date.now(),
        });
      } catch (err) {
        console.error('Failed to save user message:', err instanceof Error ? err.message : err);
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const abortController = new AbortController();
    res.on('close', () => abortController.abort());

    // Accumulate assistant response for persistence
    let assistantText = '';
    const assistantToolCalls: ToolCall[] = [];
    let assistantPiiEntities: Array<{ type: string; original: string }> | undefined;
    let assistantSource: 'ollama' | 'claude' | undefined;
    const assistantId = crypto.randomUUID();

    try {
      await runChatRequest({
        messages: addTimestamps(messages),
        signal: abortController.signal,
        pendingConfirms,
        pendingPlanReviews,
        piiProxy,
        ollama,
        registry,
        runLoop,
        onEvent: (event: SSEEvent) => {
          // Accumulate assistant data for persistence
          if (event.type === 'text_delta') {
            assistantText += event.content;
          } else if (event.type === 'tool_call_start') {
            // Skip the synthetic "router" pseudo tool call emitted by the
            // local-LLM router purely to surface an escalation notice in the
            // UI. It is not a real tool invocation and must not be persisted
            // to SQLite — otherwise every escalated turn leaves a fake
            // "router" entry in history on reload.
            if (event.toolCall.id !== 'router') {
              assistantToolCalls.push(event.toolCall);
            }
          } else if (event.type === 'tool_call_result') {
            const tc = assistantToolCalls.find((t) => t.id === event.id);
            if (tc) {
              // Strip heavy presentational fields (e.g. code_task.fullDiff)
              // before persisting. tool-loop splits fullDiff out of the
              // Claude-facing result and re-attaches it for the SSE stream,
              // but we must not store it in SQLite: (a) it was intentionally
              // bypassed by PII anonymization, so persisting the raw diff
              // would leak unmasked secrets; (b) each diff can be tens of KB
              // and bloats the messages table and history loads.
              let persistedResult = event.result;
              if (
                persistedResult &&
                persistedResult.success &&
                persistedResult.data &&
                typeof persistedResult.data === 'object' &&
                !Array.isArray(persistedResult.data) &&
                'fullDiff' in (persistedResult.data as Record<string, unknown>)
              ) {
                const { fullDiff: _fd, ...rest } = persistedResult.data as Record<string, unknown>;
                persistedResult = { ...persistedResult, data: rest };
              }
              tc.result = persistedResult;
              tc.status = event.result.success ? 'done' : 'error';
            }
          } else if (event.type === 'pii_masked') {
            assistantPiiEntities = event.entities;
          } else if (event.type === 'assistant_source') {
            // Router claims the turn; escalation will overwrite ollama with claude
            assistantSource = event.source;
          } else if (event.type === 'done') {
            // Save assistant message on completion
            if (assistantText || assistantToolCalls.length > 0) {
              try {
                saveMessage({
                  messageId: assistantId,
                  role: 'assistant',
                  content: assistantText,
                  toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
                  piiEntities: assistantPiiEntities,
                  timestamp: Date.now(),
                  source: assistantSource,
                });
              } catch (err) {
                console.error('Failed to save assistant message:', err instanceof Error ? err.message : err);
              }
            }
          }

          // Forward to SSE stream
          if (!res.writableEnded && !res.destroyed) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        },
      });
    } catch (error) {
      if (!res.writableEnded && !res.destroyed) {
        const message = error instanceof Error ? error.message : 'Internal server error';
        res.write(`data: ${JSON.stringify({ type: 'error', message: sanitizeError(message) })}\n\n`);
      }
      // Persist any partial assistant output so history/audit survives a
      // mid-loop failure. Without this the text and tool calls already
      // streamed to the client vanish on reload.
      if (assistantText || assistantToolCalls.length > 0) {
        try {
          saveMessage({
            messageId: assistantId,
            role: 'assistant',
            content: assistantText,
            toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
            piiEntities: assistantPiiEntities,
            timestamp: Date.now(),
            source: assistantSource,
          });
        } catch (err) {
          console.error('Failed to save partial assistant message:', err instanceof Error ? err.message : err);
        }
      }
    }

    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  });

  return router;
}
