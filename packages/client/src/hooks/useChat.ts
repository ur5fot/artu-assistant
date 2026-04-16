import { useState, useCallback, useRef, useEffect } from 'react';
import type { Message, ToolCall, RecalledFact, ServerPushEvent } from '@r2/shared';
import { connectSSE, type SSEConnection } from '../utils/sse';
import { createAlarmAudio, type AlarmAudio } from '../lib/alarm-audio';

// crypto.randomUUID is gated behind secure context (HTTPS / localhost). When
// the app is served over plain HTTP on a non-localhost host (e.g. Tailscale
// MagicDNS, LAN IP), window.crypto.randomUUID is undefined and every send
// crashes. Fall back to a tiny RFC-4122 v4 generator built from getRandomValues,
// which is available in all non-secure contexts too.
const randomId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

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
  const [lastResponseTime, setLastResponseTime] = useState<number | null>(null);
  const [lastSource, setLastSource] = useState<'ollama' | 'claude' | null>(null);
  const connectionRef = useRef<SSEConnection | null>(null);
  const alarmRef = useRef<AlarmAudio | null>(null);
  if (alarmRef.current === null) {
    alarmRef.current = createAlarmAudio();
  }
  const alarm = alarmRef.current;

  const sendingRef = useRef(false);
  const sendStartRef = useRef<number>(0);

  const send = useCallback((text: string) => {
    if (!text.trim() || !historyLoaded) return;

    // If a previous request is still marked in-flight, assume it's stuck
    // (server never emitted `done`/`error`) and force-reset so the new send
    // isn't silently dropped.
    if (sendingRef.current) {
      connectionRef.current?.abort();
      connectionRef.current = null;
      sendingRef.current = false;
      setLoading(false);
    }

    sendingRef.current = true;
    sendStartRef.current = Date.now();
    setError(null);
    setLoading(true);

    // Abort any existing connection before starting a new one
    connectionRef.current?.abort();
    setPendingConfirms(new Map());
    setPendingPlanReviews(new Map());

    const userMessage: Message = {
      id: randomId(),
      role: 'user',
      content: text.trim(),
      timestamp: Date.now(),
    };

    const assistantId = randomId();
    let assistantText = '';
    const toolCalls: ToolCall[] = [];
    let piiEntities: Array<{ type: string; original: string }> | undefined;
    let source: 'ollama' | 'claude' | undefined;
    let recalledFacts: RecalledFact[] | undefined;

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
                  source,
                  recalledFacts,
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
                  source,
                  recalledFacts,
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
                  source,
                  recalledFacts,
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
                  source,
                  recalledFacts,
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
                  source,
                  recalledFacts,
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
                  source,
                  recalledFacts,
                },
              ];
            });
            break;
          }

          case 'assistant_source':
            source = event.source;
            setLastSource(event.source);
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
                  source,
                  recalledFacts,
                },
              ];
            });
            break;

          case 'memory_recalled':
            recalledFacts = event.facts;
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
                  source,
                  recalledFacts,
                },
              ];
            });
            break;

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
                  source,
                  recalledFacts,
                },
              ];
            });
            break;

          case 'error':
            setError(event.message);
            setLastResponseTime(null);
            setLoading(false);
            sendingRef.current = false;
            break;

          case 'done':
            setLastResponseTime((Date.now() - sendStartRef.current) / 1000);
            setLoading(false);
            sendingRef.current = false;
            break;
        }
      },
      onError: (err) => {
        setError(err.message);
        setLastResponseTime(null);
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

  // Listen to server push events (reminders) via a dedicated EventSource
  useEffect(() => {
    const src = new EventSource('/api/events');
    const onMessage = (ev: MessageEvent) => {
      let data: ServerPushEvent;
      try { data = JSON.parse(ev.data); } catch { return; }

      if (data.type === 'reminder_ring') {
        alarm.startLoop();
        const reminderId = `reminder-${data.id}`;
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === reminderId);
          if (existing) {
            return prev.map((m) =>
              m.id === reminderId
                ? { ...m, reminder: { id: data.id, text: data.text, status: 'ringing' as const } }
                : m,
            );
          }
          return [
            ...prev,
            {
              id: reminderId,
              role: 'assistant' as const,
              content: '',
              timestamp: Date.now(),
              reminder: { id: data.id, text: data.text, status: 'ringing' as const },
            },
          ];
        });
      } else if (data.type === 'reminder_stop_ring') {
        alarm.stopLoop();
        setMessages((prev) =>
          prev.map((m) =>
            m.reminder?.id === data.id
              ? { ...m, reminder: { ...m.reminder!, status: 'paused' as const } }
              : m,
          ),
        );
      } else if (data.type === 'reminder_done') {
        alarm.stopLoop();
        setMessages((prev) =>
          prev.map((m) =>
            m.reminder?.id === data.id
              ? { ...m, reminder: { ...m.reminder!, status: 'done' as const } }
              : m,
          ),
        );
      }
    };
    src.addEventListener('message', onMessage);
    return () => {
      src.close();
      alarm.stopLoop();
    };
  }, [alarm]);

  const dismissReminder = useCallback(async (id: number) => {
    try {
      const res = await fetch('/api/reminder/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) return;
    } catch { return; }
    alarm.stopLoop();
    setMessages((prev) =>
      prev.map((m) =>
        m.reminder?.id === id
          ? { ...m, reminder: { ...m.reminder!, status: 'dismissed' as const } }
          : m,
      ),
    );
  }, [alarm]);

  const snoozeReminder = useCallback(async (id: number) => {
    try {
      const res = await fetch('/api/reminder/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) return;
    } catch { return; }
    alarm.stopLoop();
    setMessages((prev) =>
      prev.map((m) =>
        m.reminder?.id === id
          ? { ...m, reminder: { ...m.reminder!, status: 'dismissed' as const } }
          : m,
      ),
    );
  }, [alarm]);

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
    lastResponseTime,
    lastSource,
    dismissReminder,
    snoozeReminder,
  };
}
