import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SSEEvent } from '@r2/shared';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

interface ChatRouterDeps {
  runLoop: (params: {
    messages: MessageParam[];
    onEvent: (event: SSEEvent) => void;
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

    try {
      await runLoop({
        messages,
        onEvent: (event: SSEEvent) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    }

    res.end();
  });

  return router;
}
