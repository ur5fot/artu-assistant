import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SSEEvent } from '@r2/shared';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { PendingConfirms } from './confirm.js';

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
    pendingConfirms: PendingConfirms;
  }) => Promise<void>;
  pendingConfirms: PendingConfirms;
}

export function createChatRouter({ runLoop, pendingConfirms }: ChatRouterDeps): Router {
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

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const abortController = new AbortController();
    res.on('close', () => abortController.abort());

    try {
      await runLoop({
        messages: addTimestamps(messages),
        signal: abortController.signal,
        pendingConfirms,
        onEvent: (event: SSEEvent) => {
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
    }

    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  });

  return router;
}
