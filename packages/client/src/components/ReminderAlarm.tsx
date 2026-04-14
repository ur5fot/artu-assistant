import { useEffect, useRef, useState, useCallback } from 'react';
import { createAlarmAudio, type AlarmAudio } from '../lib/alarm-audio';

type ReminderPush =
  | { type: 'reminder_ring'; id: number; text: string }
  | { type: 'reminder_stop_ring'; id: number }
  | { type: 'reminder_done'; id: number };

interface ActiveAlarm {
  id: number;
  text: string;
  ringing: boolean;
}

export function ReminderAlarm() {
  const [alarms, setAlarms] = useState<ActiveAlarm[]>([]);
  const audioRef = useRef<AlarmAudio | null>(null);

  if (audioRef.current === null) {
    audioRef.current = createAlarmAudio();
  }
  const audio = audioRef.current;

  const updateAudio = useCallback((next: ActiveAlarm[]) => {
    const anyRinging = next.some((a) => a.ringing);
    if (anyRinging) audio.startLoop();
    else audio.stopLoop();
  }, [audio]);

  useEffect(() => {
    const src = new EventSource('/api/events');
    const onMessage = (ev: MessageEvent) => {
      let data: ReminderPush;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      setAlarms((prev) => {
        let next = prev;
        if (data.type === 'reminder_ring') {
          const existing = prev.find((a) => a.id === data.id);
          if (existing) {
            next = prev.map((a) => (a.id === data.id ? { ...a, ringing: true } : a));
          } else {
            next = [...prev, { id: data.id, text: data.text, ringing: true }];
          }
        } else if (data.type === 'reminder_stop_ring') {
          next = prev.map((a) => (a.id === data.id ? { ...a, ringing: false } : a));
        } else if (data.type === 'reminder_done') {
          next = prev.filter((a) => a.id !== data.id);
        }
        updateAudio(next);
        return next;
      });
    };
    src.addEventListener('message', onMessage);
    return () => {
      src.close();
      audio.stopLoop();
    };
  }, [audio, updateAudio]);

  const handleDismiss = async (id: number) => {
    try {
      const res = await fetch('/api/reminder/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) return;
    } catch {
      return;
    }
    setAlarms((prev) => {
      const next = prev.filter((a) => a.id !== id);
      updateAudio(next);
      return next;
    });
  };

  const handleSnooze = async (id: number) => {
    try {
      const res = await fetch('/api/reminder/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) return;
    } catch {
      return;
    }
    setAlarms((prev) => {
      const next = prev.filter((a) => a.id !== id);
      updateAudio(next);
      return next;
    });
  };

  if (alarms.length === 0) return null;

  return (
    <div
      role="dialog"
      aria-label="Напоминания"
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 1000,
        background: 'var(--bg-panel, #1f1f1f)',
        color: 'var(--text-primary, #f5f5f5)',
        border: '2px solid #c55',
        borderRadius: 12,
        padding: 24,
        minWidth: 320,
        boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
      }}
    >
      {alarms.map((a) => (
        <div key={a.id} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 18, marginBottom: 8 }}>
            ⏰ {a.text} {a.ringing ? '(звонит…)' : '(пауза)'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => handleDismiss(a.id)}>✓ Выключить</button>
            <button onClick={() => handleSnooze(a.id)}>😴 Через 10 мин</button>
          </div>
        </div>
      ))}
    </div>
  );
}
