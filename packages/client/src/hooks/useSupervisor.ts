import { useState, useEffect, useRef, useCallback } from 'react';

type WorkerStatus = 'running' | 'starting' | 'crashed' | 'restarting' | 'unknown';

interface SupervisorState {
  workerStatus: WorkerStatus;
  connected: boolean;
}

const WS_URL = import.meta.env.VITE_SUPERVISOR_WS_URL;
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000];

function eventToStatus(type: string): WorkerStatus {
  switch (type) {
    case 'worker_ready': return 'running';
    case 'worker_starting': return 'starting';
    case 'worker_crashed': return 'crashed';
    case 'worker_restarting': return 'restarting';
    case 'worker_stopped': return 'unknown';
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
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!WS_URL) return; // No supervisor URL configured (dev mode)
    if (!mountedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) { ws.close(); return; }
        reconnectAttempt.current = 0;
        setState((prev) => ({ ...prev, connected: true }));
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
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
        // Guard against stale socket closing after a new one was assigned (e.g. StrictMode re-mount)
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        if (!mountedRef.current) return;
        setState({ workerStatus: 'unknown', connected: false });
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      if (!mountedRef.current) return;
      setState({ workerStatus: 'unknown', connected: false });
      scheduleReconnect();
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt.current, RECONNECT_DELAYS.length - 1)];
    reconnectAttempt.current++;
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      connect();
    }, delay);
  }, [connect]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      wsRef.current?.close();
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
    };
  }, [connect]);

  return state;
}
