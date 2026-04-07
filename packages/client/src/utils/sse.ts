import type { SSEEvent } from '@r2/shared';

export interface SSEConnection {
  abort: () => void;
}

interface SSEParams {
  messages: Array<{ role: string; content: string }>;
  onEvent: (event: SSEEvent) => void;
  onError: (error: Error) => void;
}

export function connectSSE({ messages, onEvent, onError }: SSEParams): SSEConnection {
  const controller = new AbortController();

  (async () => {
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event: SSEEvent = JSON.parse(line.slice(6));
            onEvent(event);
          } catch {
            // skip malformed events
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        onError(err instanceof Error ? err : new Error('Connection failed'));
      }
    }
  })();

  return { abort: () => controller.abort() };
}
