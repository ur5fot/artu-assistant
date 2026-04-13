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
import type { MemoryService } from '../memory/service.js';
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

function parseCommandArgs(input: string): string[] {
  // Shell-like tokenizer: splits on whitespace, supports "double" and 'single' quotes.
  // Tracks `hasToken` separately from `current` so an empty quoted string ("") still
  // emits a token — otherwise `/cmd path ""` would silently drop the empty arg and
  // fail required-param validation even though the user passed a valid empty value.
  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      current += ch;
      hasToken = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) { tokens.push(current); current = ''; hasToken = false; }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

function sendSlashCommandError(res: Response, message: string, assistantId: string): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const deltaEvent: SSEEvent = { type: 'text_delta', content: message };
  res.write(`data: ${JSON.stringify(deltaEvent)}\n\n`);
  const doneEvent: SSEEvent = { type: 'done' };
  res.write(`data: ${JSON.stringify(doneEvent)}\n\n`);
  res.end();
  try {
    saveMessage({
      messageId: assistantId,
      role: 'assistant',
      content: message,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error('Failed to save slash-command error message:', err instanceof Error ? err.message : err);
  }
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
  memoryService: MemoryService | null;
}

export function createChatRouter({ runLoop, pendingConfirms, pendingPlanReviews, piiProxy, ollama, registry, memoryService }: ChatRouterDeps): Router {
  const router = Router();

  router.post('/chat', async (req: Request, res: Response) => {
    let { messages } = req.body;

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

    // Save the original user message to DB before any rewriting
    const lastMsg = messages[messages.length - 1];
    const originalUserText = lastMsg && lastMsg.role === 'user' && typeof lastMsg.content === 'string'
      ? lastMsg.content
      : '';
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

    // Check if the latest user message is a slash command and rewrite for LLM
    let forceProvider: 'claude' | undefined;
    let recognizedSlashCommand = false;
    const lastUserMsg = messages[messages.length - 1];
    if (lastUserMsg?.role === 'user' && typeof lastUserMsg.content === 'string') {
      const match = lastUserMsg.content.match(/^\/(\S+)\s*(.*)/s);
      if (match) {
        const [, commandName, argsStr] = match;
        const toolDef = registry.getByCommandName(commandName);
        if (toolDef) {
          recognizedSlashCommand = true;
          // Map positional args to tool parameters
          const params: Record<string, unknown> = {};
          const requiredParams = (toolDef.command?.params ?? []).filter((p) => p.required);
          // Extract declared boolean flags from args BEFORE positional parsing so a
          // flag token (e.g. "--показати") never lands in a positional param slot.
          let remainingArgs = argsStr;
          const declaredFlags = toolDef.command?.flags ?? [];
          for (const flag of declaredFlags) {
            const re = new RegExp(`(^|\\s)${flag.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'g');
            if (re.test(remainingArgs)) {
              params[flag.param] = true;
              remainingArgs = remainingArgs.replace(re, ' ');
            }
          }
          const trimmedArgs = remainingArgs.trim();

          // Validation: required params must be provided. Fail fast instead of
          // letting the LLM infer values from prior context (could trigger unintended
          // destructive tool calls such as delete/move/write).
          if (requiredParams.length >= 1 && !trimmedArgs) {
            const usage = requiredParams.map((p) => `<${p.name}>`).join(' ');
            const errId = crypto.randomUUID();
            sendSlashCommandError(
              res,
              `Команда /${commandName} потребує параметри. Використання: /${commandName} ${usage}`,
              errId,
            );
            return;
          }

          if (requiredParams.length === 1 && trimmedArgs) {
            // Single required param: entire args string is the value
            params[requiredParams[0].name] = trimmedArgs;
          } else if (requiredParams.length >= 2 && trimmedArgs) {
            // Multi-param: deterministic shell-like parsing (supports quoted values).
            // First N-1 tokens map to first N-1 required params; the remainder joins
            // into the last param (so file paths with spaces still work unquoted).
            const tokens = parseCommandArgs(trimmedArgs);
            if (tokens.length < requiredParams.length) {
              const usage = requiredParams.map((p) => `<${p.name}>`).join(' ');
              const errId = crypto.randomUUID();
              sendSlashCommandError(
                res,
                `Команда /${commandName} потребує ${requiredParams.length} параметри. Використання: /${commandName} ${usage}`,
                errId,
              );
              return;
            }
            for (let i = 0; i < requiredParams.length - 1; i++) {
              params[requiredParams[i].name] = tokens[i];
            }
            const lastName = requiredParams[requiredParams.length - 1].name;
            params[lastName] = tokens.slice(requiredParams.length - 1).join(' ');
          } else if (requiredParams.length === 0 && trimmedArgs) {
            // No required params but user provided args: pass as-is for optional params
            const optionalParams = (toolDef.command?.params ?? []).filter((p) => !p.required);
            if (optionalParams.length > 0) {
              params[optionalParams[0].name] = trimmedArgs;
            }
          }

          // Rewrite user message to instruct LLM to use the specific tool
          const rewritten = messages.map((m: any, i: number) => {
            if (i === messages.length - 1) {
              const paramDesc = Object.keys(params).length > 0 ? JSON.stringify(params) : 'none';
              const instruction = `[User used command /${commandName}] Use tool "${toolDef.name}" with parameters: ${paramDesc}. Execute the tool and respond with the result.`;
              return { ...m, content: instruction };
            }
            return m;
          });

          // Force Claude for claude-only tools (skip Ollama which can't call them)
          if (toolDef.provider === 'claude') {
            forceProvider = 'claude';
          }

          // Replace messages with rewritten version for the rest of the handler
          messages = rewritten;
        }
        // If command not found, fall through — send as normal message to LLM
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
        memoryService,
        forceProvider,
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

              // Skip indexing slash-command invocations: the literal "/cmd ..."
              // text is a tool dispatcher, not user content worth recalling.
              // Tool results are also intentionally excluded by the memory
              // service itself — they bypass PII masking and would leak secrets.
              if (memoryService && originalUserText && !recognizedSlashCommand) {
                memoryService
                  .indexTurn({
                    userMessage: originalUserText,
                    assistantMessage: assistantText,
                    timestamp: Date.now(),
                  })
                  .catch((err) => console.warn('[memory] indexTurn failed:', err instanceof Error ? err.message : err));
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
