import { WebSocketServer, WebSocket } from 'ws';

export interface SupervisorEvent {
  type: 'worker_starting' | 'worker_ready' | 'worker_crashed' | 'worker_restarting' | 'worker_stopped';
  code?: number | null;
  signal?: string | null;
  delayMs?: number;
}

export interface SupervisorCommand {
  type: 'restart';
}

export class StatusWsServer {
  private wss: WebSocketServer;
  private currentStatus: SupervisorEvent = { type: 'worker_stopped' };
  private commandHandler: ((cmd: SupervisorCommand) => void) | null = null;

  constructor(options: { port: number }) {
    this.wss = new WebSocketServer({ port: options.port });

    this.wss.on('connection', (ws) => {
      // Send current status on connect
      ws.send(JSON.stringify(this.currentStatus));

      ws.on('message', (data) => {
        try {
          const cmd = JSON.parse(data.toString()) as SupervisorCommand;
          if (cmd.type && this.commandHandler) {
            this.commandHandler(cmd);
          }
        } catch {
          // ignore invalid messages
        }
      });
    });
  }

  get port(): number {
    const addr = this.wss.address();
    if (typeof addr === 'object' && addr !== null) {
      return addr.port;
    }
    return 0;
  }

  broadcast(event: SupervisorEvent): void {
    this.currentStatus = event;
    const data = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  onCommand(handler: (cmd: SupervisorCommand) => void): void {
    this.commandHandler = handler;
  }

  close(): void {
    for (const client of this.wss.clients) {
      client.close();
    }
    this.wss.close();
  }
}
