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
export function createEventsRouter(deps: EventsRouterDeps): Router {
  const router = Router();
  const { bus } = deps;

  router.get('/', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    res.write(':ok\n\n');

    const listener = (event: ServerPushEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    bus.on('push', listener);

    const heartbeat = setInterval(() => {
      res.write(':heartbeat\n\n');
    }, 20_000);

    const cleanup = () => {
      bus.off('push', listener);
      clearInterval(heartbeat);
    };
    _req.on('close', cleanup);
    _req.on('aborted', cleanup);
  });

  return router;
}
