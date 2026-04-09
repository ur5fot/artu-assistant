import { useState, useEffect, useRef, useCallback } from 'react';

type WorkerStatus = 'running' | 'starting' | 'crashed' | 'restarting' | 'unknown';

interface SupervisorState {
  workerStatus: WorkerStatus;
  connected: boolean;
}

const WS_URL = import.meta.env.VITE_SUPERVISOR_WS_URL || 'ws://localhost:3100';
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000];

function eventToStatus(type: string): WorkerStatus {
  switch (type) {
    case 'worker_ready': return 'running';
    case 'worker_starting': return 'starting';
    case 'worker_crashed': return 'crashed';
    case 'worker_restarting': return 'restarting';
    case 'worker_stopped': return 'starting';
    default: return 'unknown';
  }
}

export function useSupervisor(): SupervisorState {
  const [state, setState] = useState<SupervisorState>({
    workerStatus: 'running',
    connected: false,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempt.current = 0;
        setState((prev) => ({ ...prev, connected: true }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type) {
            setState({
              workerStatus: eventToStatus(data.type),
              connected: true,
            });
          }
        } catch {
          // ignore invalid messages
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setState({ workerStatus: 'running', connected: false });
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      setState({ workerStatus: 'running', connected: false });
      scheduleReconnect();
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt.current, RECONNECT_DELAYS.length - 1)];
    reconnectAttempt.current++;
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      connect();
    }, delay);
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
    };
  }, [connect]);

  return state;
}
