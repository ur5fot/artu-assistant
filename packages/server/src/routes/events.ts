import { Router, type Request, type Response } from 'express';
import type { EventEmitter } from 'node:events';
import type { ServerPushEvent } from '@r2/shared';

interface EventsRouterDeps {
  bus: EventEmitter;
}

/**
 * Server-Sent Events endpoint for server→client push (reminder alarms,
 * future real-time events). One connection per browser tab, kept open.
 * Clients use `new EventSource('/api/events')`.
 */
const MAX_SSE_CONNECTIONS = 32;

export function createEventsRouter(deps: EventsRouterDeps): Router {
  const router = Router();
  const { bus } = deps;
  let openConnections = 0;

  bus.setMaxListeners(MAX_SSE_CONNECTIONS + 10);

  router.get('/', (req: Request, res: Response) => {
    if (openConnections >= MAX_SSE_CONNECTIONS) {
      res.status(503).json({ error: 'too many SSE connections' });
      return;
    }
    openConnections++;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let closed = false;
    const safeWrite = (chunk: string) => {
      if (closed || res.writableEnded) return;
      try {
        res.write(chunk);
      } catch {
        cleanup();
      }
    };

    const listener = (event: ServerPushEvent) => {
      safeWrite(`data: ${JSON.stringify(event)}\n\n`);
    };
    bus.on('push', listener);

    const heartbeat = setInterval(() => {
      safeWrite(':heartbeat\n\n');
    }, 20_000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      openConnections--;
      bus.off('push', listener);
      clearInterval(heartbeat);
    };
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('error', cleanup);

    safeWrite(':ok\n\n');
  });

  return router;
}
