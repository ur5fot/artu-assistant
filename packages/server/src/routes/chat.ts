import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SSEEvent } from '@r2/shared';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

function sanitizeError(message: string): string {
  // Strip potentially sensitive details (API keys, internal paths, upstream provider info)
  const lower = message.toLowerCase();
  if (lower.includes('anthropic') || lower.includes('sk-ant-')) {
    return 'AI service temporarily unavailable';
  }
  if (lower.includes('brave')) {
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
  }) => Promise<void>;
}

export function createChatRouter({ runLoop }: ChatRouterDeps): Router {
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

    const abortController = new AbortController();
    res.on('close', () => abortController.abort());

    try {
      await runLoop({
        messages,
        signal: abortController.signal,
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
