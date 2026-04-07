import { useState, useCallback, useRef } from 'react';
import type { Message, ToolCall, ToolResult } from '@r2/shared';
import { connectSSE, type SSEConnection } from '../utils/sse';

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectionRef = useRef<SSEConnection | null>(null);

  const send = useCallback((text: string) => {
    if (!text.trim() || loading) return;

    setError(null);

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text.trim(),
      timestamp: Date.now(),
    };

    setMessages((prev) => {
      const updated = [...prev, userMessage];
      startStream(updated);
      return updated;
    });

    function startStream(allMessages: Message[]) {
      setLoading(true);

      const assistantId = crypto.randomUUID();
      let assistantText = '';
      const toolCalls: ToolCall[] = [];

      connectionRef.current = connectSSE({
        messages: allMessages.map((m) => ({ role: m.role, content: m.content })),
        onEvent: (event) => {
          switch (event.type) {
            case 'text_delta':
              assistantText += event.content;
              setMessages([
                ...allMessages,
                {
                  id: assistantId,
                  role: 'assistant',
                  content: assistantText,
                  toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined,
                  timestamp: Date.now(),
                },
              ]);
              break;

            case 'tool_call_start':
              toolCalls.push(event.toolCall);
              setMessages([
                ...allMessages,
                {
                  id: assistantId,
                  role: 'assistant',
                  content: assistantText,
                  toolCalls: [...toolCalls],
                  timestamp: Date.now(),
                },
              ]);
              break;

            case 'tool_call_result': {
              const tc = toolCalls.find((t) => t.id === event.id);
              if (tc) {
                tc.result = event.result;
                tc.status = event.result.success ? 'done' : 'error';
              }
              setMessages([
                ...allMessages,
                {
                  id: assistantId,
                  role: 'assistant',
                  content: assistantText,
                  toolCalls: [...toolCalls],
                  timestamp: Date.now(),
                },
              ]);
              break;
            }

            case 'error':
              setError(event.message);
              setLoading(false);
              break;

            case 'done':
              setLoading(false);
              break;
          }
        },
        onError: (err) => {
          setError(err.message);
          setLoading(false);
        },
      });
    }
  }, [loading]);

  const stop = useCallback(() => {
    connectionRef.current?.abort();
    setLoading(false);
  }, []);

  return { messages, loading, error, send, stop };
}
