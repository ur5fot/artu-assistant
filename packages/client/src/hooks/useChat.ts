import { useState, useCallback, useRef, useEffect } from 'react';
import type { Message, ToolCall } from '@r2/shared';
import { connectSSE, type SSEConnection } from '../utils/sse';

export interface PendingConfirm {
  callId: string;
  level: 'confirm' | 'forbidden';
  destructiveWarning?: { reason: string };
}

export interface PendingPlanReview {
  callId: string;
  task: string;
  plan: string;
}

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirms, setPendingConfirms] = useState<Map<string, PendingConfirm>>(new Map());
  const [pendingPlanReviews, setPendingPlanReviews] = useState<Map<string, PendingPlanReview>>(new Map());
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const connectionRef = useRef<SSEConnection | null>(null);

  const sendingRef = useRef(false);

  const send = useCallback((text: string) => {
    if (!text.trim() || sendingRef.current || !historyLoaded) return;

    sendingRef.current = true;
    setError(null);
    setLoading(true);

    // Abort any existing connection before starting a new one
    connectionRef.current?.abort();
    setPendingConfirms(new Map());
    setPendingPlanReviews(new Map());

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text.trim(),
      timestamp: Date.now(),
    };

    const assistantId = crypto.randomUUID();
    let assistantText = '';
    const toolCalls: ToolCall[] = [];
    let piiEntities: Array<{ type: string; original: string }> | undefined;

    setMessages((prev) => [...prev, userMessage]);

    connectionRef.current = connectSSE({
      messages: [...messages, userMessage].map((m) => ({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp })),
      onEvent: (event) => {
        switch (event.type) {
          case 'text_delta':
            assistantText += event.content;
            setMessages((prev) => {
              const base = prev[prev.length - 1]?.id === assistantId ? prev.slice(0, -1) : prev;
              return [
                ...base,
                {
                  id: assistantId,
                  role: 'assistant' as const,
                  content: assistantText,
                  toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined,
                  timestamp: Date.now(),
                  piiEntities,
                },
              ];
            });
            break;

          case 'tool_call_start':
            toolCalls.push(event.toolCall);
            setMessages((prev) => {
              const base = prev[prev.length - 1]?.id === assistantId ? prev.slice(0, -1) : prev;
              return [
                ...base,
                {
                  id: assistantId,
                  role: 'assistant' as const,
                  content: assistantText,
                  toolCalls: [...toolCalls],
                  timestamp: Date.now(),
                  piiEntities,
                },
              ];
            });
            break;

          case 'tool_call_result': {
            const tc = toolCalls.find((t) => t.id === event.id);
            if (tc) {
              tc.result = event.result;
              tc.status = event.result.success ? 'done' : 'error';
            }
            setMessages((prev) => {
              const base = prev[prev.length - 1]?.id === assistantId ? prev.slice(0, -1) : prev;
              return [
                ...base,
                {
                  id: assistantId,
                  role: 'assistant' as const,
                  content: assistantText,
                  toolCalls: [...toolCalls],
                  timestamp: Date.now(),
                  piiEntities,
                },
              ];
            });
            break;
          }

          case 'tool_confirm_request':
            setPendingConfirms((prev) => {
              const next = new Map(prev);
              next.set(event.toolCall.id, {
                callId: event.toolCall.id,
                level: event.level,
                destructiveWarning: event.destructiveWarning,
              });
              return next;
            });
            // Don't push to toolCalls — tool_call_start already added this tool call.
            // Just trigger a re-render so MessageBubble picks up the pending confirm.
            setMessages((prev) => {
              const base = prev[prev.length - 1]?.id === assistantId ? prev.slice(0, -1) : prev;
              return [
                ...base,
                {
                  id: assistantId,
                  role: 'assistant' as const,
                  content: assistantText,
                  toolCalls: [...toolCalls],
                  timestamp: Date.now(),
                  piiEntities,
                },
              ];
            });
            break;

          case 'tool_plan_review':
            setPendingPlanReviews((prev) => {
              const next = new Map(prev);
              next.set(event.id, { callId: event.id, task: event.task, plan: event.plan });
              return next;
            });
            setMessages((prev) => {
              const base = prev[prev.length - 1]?.id === assistantId ? prev.slice(0, -1) : prev;
              return [
                ...base,
                {
                  id: assistantId,
                  role: 'assistant' as const,
                  content: assistantText,
                  toolCalls: [...toolCalls],
                  timestamp: Date.now(),
                  piiEntities,
                },
              ];
            });
            break;

          case 'tool_progress': {
            const tc = toolCalls.find((t) => t.id === event.id);
            if (tc) tc.progress = event.message;
            setMessages((prev) => {
              const base = prev[prev.length - 1]?.id === assistantId ? prev.slice(0, -1) : prev;
              return [
                ...base,
                {
                  id: assistantId,
                  role: 'assistant' as const,
                  content: assistantText,
                  toolCalls: [...toolCalls],
                  timestamp: Date.now(),
                  piiEntities,
                },
              ];
            });
            break;
          }

          case 'pii_masked':
            piiEntities = event.entities;
            setMessages((prev) => {
              const base = prev[prev.length - 1]?.id === assistantId ? prev.slice(0, -1) : prev;
              return [
                ...base,
                {
                  id: assistantId,
                  role: 'assistant' as const,
                  content: assistantText,
                  toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined,
                  timestamp: Date.now(),
                  piiEntities,
                },
              ];
            });
            break;

          case 'error':
            setError(event.message);
            setLoading(false);
            sendingRef.current = false;
            break;

          case 'done':
            setLoading(false);
            sendingRef.current = false;
            break;
        }
      },
      onError: (err) => {
        setError(err.message);
        setLoading(false);
        sendingRef.current = false;
      },
    });
  }, [messages, historyLoaded]);

  const stop = useCallback(() => {
    connectionRef.current?.abort();
    connectionRef.current = null;
    setPendingConfirms(new Map());
    setPendingPlanReviews(new Map());
    setLoading(false);
    sendingRef.current = false;
  }, []);

  const respondToConfirm = useCallback(async (callId: string, allowed: boolean, remember: boolean): Promise<boolean> => {
    try {
      const res = await fetch('/api/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId, allowed, remember }),
      });
      if (!res.ok) {
        console.error('Confirm response failed:', res.status, await res.text());
        return false;
      }
      setPendingConfirms((prev) => {
        const next = new Map(prev);
        next.delete(callId);
        return next;
      });
      return true;
    } catch (err) {
      console.error('Failed to send confirm response:', err);
      return false;
    }
  }, []);

  const respondToPlanReview = useCallback(async (callId: string, approved: boolean, editedPlan?: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/plan-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId, approved, editedPlan }),
      });
      if (!res.ok) {
        console.error('Plan review response failed:', res.status, await res.text());
        return false;
      }
      setPendingPlanReviews((prev) => {
        const next = new Map(prev);
        next.delete(callId);
        return next;
      });
      return true;
    } catch (err) {
      console.error('Failed to send plan review response:', err);
      return false;
    }
  }, []);

  // Clean up SSE connection on unmount
  useEffect(() => {
    return () => {
      connectionRef.current?.abort();
    };
  }, []);

  // Load chat history on mount
  useEffect(() => {
    fetch('/api/messages')
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load messages: ${res.status}`);
        return res.json();
      })
      .then((msgs: Message[]) => {
        if (msgs.length > 0) {
          setMessages((prev) => (prev.length > 0 ? prev : msgs));
        }
      })
      .catch((err) => {
        console.error('Failed to load chat history:', err);
      })
      .finally(() => {
        setHistoryLoaded(true);
      });
  }, []);

  return {
    messages,
    loading,
    error,
    send,
    stop,
    pendingConfirms,
    respondToConfirm,
    pendingPlanReviews,
    respondToPlanReview,
    historyLoaded,
  };
}
