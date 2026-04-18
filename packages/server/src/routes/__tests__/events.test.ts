import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createEventsRouter } from '../events.js';
import type { ReminderStore } from '../../reminders/store.js';

function makeStore(): ReminderStore {
  return { list: () => [] } as unknown as ReminderStore;
}

function openStream(port: number, path: string): Promise<{
  req: http.ClientRequest;
  chunks: string[];
  whenChunk: (predicate: (buf: string) => boolean, timeoutMs?: number) => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let buf = '';
    const waiters: Array<{ predicate: (b: string) => boolean; resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];

    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        chunks.push(c);
        buf += c;
        for (let i = waiters.length - 1; i >= 0; i--) {
          const w = waiters[i]!;
          if (w.predicate(buf)) {
            clearTimeout(w.timer);
            waiters.splice(i, 1);
            w.resolve();
          }
        }
      });
    });
    req.on('error', reject);
    req.end();

    resolve({
      req,
      chunks,
      whenChunk: (predicate, timeoutMs = 500) =>
        new Promise<void>((res, rej) => {
          if (predicate(buf)) return res();
          const timer = setTimeout(() => rej(new Error('timeout waiting for chunk')), timeoutMs);
          waiters.push({ predicate, resolve: res, reject: rej, timer });
        }),
    });
  });
}

describe('events router — SSE filter', () => {
  it('forwards reminder_ring but filters server-internal cognition_publish', async () => {
    const bus = new EventEmitter();
    const app = express();
    app.use('/api/events', createEventsRouter({ bus, store: makeStore() }));
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    try {
      const stream = await openStream(port, '/api/events/');
      // Wait for the ":ok" sentinel so the listener is wired before emit.
      await stream.whenChunk((b) => b.includes(':ok'));

      bus.emit('push', { type: 'cognition_publish', runId: 1, handler: 'h', content: 'secret' });
      bus.emit('push', { type: 'reminder_ring', id: 7, text: 'hello' });
      await stream.whenChunk((b) => b.includes('reminder_ring'));

      const joined = stream.chunks.join('');
      expect(joined).toContain('reminder_ring');
      expect(joined).not.toContain('cognition_publish');
      expect(joined).not.toContain('secret');

      stream.req.destroy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
