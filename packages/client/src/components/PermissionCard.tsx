import { useState, useEffect } from 'react';
import type { ToolCall } from '@r2/shared';

interface Props {
  toolCall: ToolCall;
  level: 'confirm' | 'forbidden';
  onRespond: (callId: string, allowed: boolean, remember: boolean) => void;
}

export function PermissionCard({ toolCall, level, onRespond }: Props) {
  const [responded, setResponded] = useState(false);
  const [decision, setDecision] = useState<'allowed' | 'denied' | null>(null);
  const [remember, setRemember] = useState(false);
  const [pulse, setPulse] = useState(false);

  // Pulse reminder after 60 seconds
  useEffect(() => {
    if (responded) return;
    const timer = setTimeout(() => setPulse(true), 60_000);
    return () => clearTimeout(timer);
  }, [responded]);

  const handleRespond = (allowed: boolean) => {
    setResponded(true);
    setDecision(allowed ? 'allowed' : 'denied');
    onRespond(toolCall.id, allowed, remember);
  };

  const isForbidden = level === 'forbidden';

  const cardStyle: React.CSSProperties = {
    background: isForbidden ? '#FEF2F2' : '#f8f8f8',
    border: isForbidden ? '2px solid #DC2626' : '1px solid #e5e5e5',
    borderRadius: 14,
    padding: 16,
    marginBottom: 6,
    maxWidth: '80%',
    fontSize: 13,
    opacity: responded ? 0.7 : 1,
    animation: pulse && !responded ? 'pulse-border 1.5s ease-in-out infinite' : undefined,
  };

  const params = Object.entries(toolCall.input);

  return (
    <>
      <style>{`
        @keyframes pulse-border {
          0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
          50% { box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.3); }
        }
      `}</style>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            background: isForbidden ? '#DC2626' : '#F59E0B',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 12, fontWeight: 700,
          }}>
            {isForbidden ? '\u{1F534}' : '\u26A0'}
          </div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            {toolCall.name} — {isForbidden ? '\u041E\u043F\u0430\u0441\u043D\u043E\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435' : '\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435'}
          </div>
        </div>

        <div style={{
          background: '#fff', border: '1px solid #e5e5e5',
          borderRadius: 8, padding: 10, marginBottom: 12,
          fontFamily: 'monospace', fontSize: 12,
        }}>
          {params.map(([key, value]) => (
            <div key={key} style={{ marginBottom: 4 }}>
              <span style={{ color: '#666' }}>{key}: </span>
              <span style={{
                display: 'inline-block', maxHeight: 60, overflow: 'hidden',
                wordBreak: 'break-all',
              }}>
                {typeof value === 'string' ? value : JSON.stringify(value)}
              </span>
            </div>
          ))}
        </div>

        {responded ? (
          <div style={{
            fontWeight: 600, fontSize: 13,
            color: decision === 'allowed' ? '#059669' : '#DC2626',
          }}>
            {decision === 'allowed' ? '\u2713 \u0420\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u043E' : '\u2717 \u041E\u0442\u043A\u043B\u043E\u043D\u0435\u043D\u043E'}
          </div>
        ) : (
          <>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 6,
              marginBottom: 10, fontSize: 12, color: '#666', cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              {'\u0417\u0430\u043F\u043E\u043C\u043D\u0438\u0442\u044C'}
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => handleRespond(true)}
                style={{
                  flex: 1, padding: 8, borderRadius: 8, border: 'none',
                  background: '#2A5A8A', color: '#fff', fontSize: 13, cursor: 'pointer',
                }}
              >
                {'\u0420\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u044C'}
              </button>
              <button
                onClick={() => handleRespond(false)}
                style={{
                  flex: 1, padding: 8, borderRadius: 8,
                  border: '1px solid #ddd', background: '#fff',
                  color: '#666', fontSize: 13, cursor: 'pointer',
                }}
              >
                {'\u041E\u0442\u043A\u043B\u043E\u043D\u0438\u0442\u044C'}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
