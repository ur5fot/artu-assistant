import { describe, it, expect, afterEach } from 'vitest';
import { StatusWsServer } from './ws-server.js';
import WebSocket from 'ws';

describe('StatusWsServer', () => {
  let server: StatusWsServer;

  afterEach(() => {
    server?.close();
  });

  it('accepts connections and sends current status on connect', async () => {
    server = new StatusWsServer({ port: 0 }); // random port
    const port = server.port;

    const ws = new WebSocket(`ws://localhost:${port}`);
    const message = await new Promise<string>((resolve) => {
      ws.on('message', (data) => resolve(data.toString()));
    });

    const parsed = JSON.parse(message);
    expect(parsed.type).toBe('worker_stopped');
    ws.close();
  });

  it('broadcasts events to all connected clients', async () => {
    server = new StatusWsServer({ port: 0 });
    const port = server.port;

    const ws1 = new WebSocket(`ws://localhost:${port}`);
    const ws2 = new WebSocket(`ws://localhost:${port}`);

    // Wait for initial status messages
    await Promise.all([
      new Promise<void>((r) => ws1.on('message', () => r())),
      new Promise<void>((r) => ws2.on('message', () => r())),
    ]);

    // Broadcast an event
    const messages: string[] = [];
    ws1.on('message', (data) => messages.push(data.toString()));
    ws2.on('message', (data) => messages.push(data.toString()));

    server.broadcast({ type: 'worker_ready' });

    // Wait for delivery
    await new Promise((r) => setTimeout(r, 100));

    expect(messages.filter((m) => JSON.parse(m).type === 'worker_ready')).toHaveLength(2);

    ws1.close();
    ws2.close();
  });

  it('handles restart command from client', async () => {
    server = new StatusWsServer({ port: 0 });
    const port = server.port;

    const commands: string[] = [];
    server.onCommand((cmd) => commands.push(cmd.type));

    const ws = new WebSocket(`ws://localhost:${port}`);

    // Wait for initial status message before sending command
    await new Promise<void>((resolve) => {
      ws.on('message', function handler() {
        ws.removeListener('message', handler);
        resolve();
      });
    });

    ws.send(JSON.stringify({ type: 'restart' }));

    await new Promise((r) => setTimeout(r, 100));
    expect(commands).toContain('restart');

    ws.close();
  });
});
