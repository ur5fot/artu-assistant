import { useState, useEffect } from 'react';
import type { ToolCall } from '@r2/shared';

interface Props {
  toolCall: ToolCall;
  level: 'confirm' | 'forbidden';
  destructiveWarning?: { reason: string };
  onRespond: (callId: string, allowed: boolean, remember: boolean) => Promise<boolean>;
}

export function PermissionCard({ toolCall, level, destructiveWarning, onRespond }: Props) {
  const [decision, setDecision] = useState<'allowed' | 'denied' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [remember, setRemember] = useState(false);
  const [pulse, setPulse] = useState(false);
  const responded = decision !== null;
  const isCodeTask = toolCall.name === 'code_task';
  const isForbidden = level === 'forbidden' || Boolean(destructiveWarning);

  useEffect(() => {
    if (responded) return;
    const timer = setTimeout(() => setPulse(true), 60_000);
    return () => clearTimeout(timer);
  }, [responded]);

  const handleRespond = async (allowed: boolean, rememberOverride?: boolean) => {
    setSubmitting(true);
    try {
      const shouldRemember = rememberOverride ?? remember;
      const ok = await onRespond(toolCall.id, allowed, shouldRemember);
      if (ok) setDecision(allowed ? 'allowed' : 'denied');
    } finally {
      setSubmitting(false);
    }
  };

  const cardStyle: React.CSSProperties = {
    background: isForbidden ? '#FEF2F2' : '#f8f8f8',
    border: isForbidden ? '2px solid #DC2626' : '1px solid #e5e5e5',
    borderRadius: 14,
    padding: 16,
    marginBottom: 6,
    maxWidth: '80%',
    fontSize: 13,
    opacity: responded ? 0.7 : submitting ? 0.85 : 1,
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
            {toolCall.name} — {isForbidden ? 'Dangerous action' : 'Confirmation'}
          </div>
        </div>

        {destructiveWarning && (
          <div style={{
            background: '#FEE2E2', border: '1px solid #FCA5A5',
            borderRadius: 6, padding: 8, marginBottom: 10,
            fontSize: 12, color: '#991B1B',
          }}>
            <strong>⚠ Destructive:</strong> {destructiveWarning.reason}
          </div>
        )}

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
            {decision === 'allowed' ? '\u2713 Allowed' : '\u2717 Denied'}
          </div>
        ) : isCodeTask ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button
              onClick={() => handleRespond(true, false)}
              disabled={submitting}
              style={{
                padding: 8, borderRadius: 8, border: 'none',
                background: '#2A5A8A', color: '#fff', fontSize: 13,
                cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.6 : 1,
              }}
            >
              Allow once
            </button>
            <button
              onClick={() => handleRespond(true, true)}
              disabled={submitting || Boolean(destructiveWarning)}
              title={destructiveWarning ? 'Cannot remember destructive actions' : ''}
              style={{
                padding: 8, borderRadius: 8, border: 'none',
                background: '#10B981', color: '#fff', fontSize: 13,
                cursor: submitting || destructiveWarning ? 'not-allowed' : 'pointer',
                opacity: submitting || destructiveWarning ? 0.5 : 1,
              }}
            >
              ⭐ Allow always (auto mode with ralphex)
            </button>
            <button
              onClick={() => handleRespond(false)}
              disabled={submitting}
              style={{
                padding: 8, borderRadius: 8,
                border: '1px solid #ddd', background: '#fff',
                color: '#666', fontSize: 13,
                cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.6 : 1,
              }}
            >
              Deny
            </button>
          </div>
        ) : (
          <>
            {!isForbidden && (
              <label style={{
                display: 'flex', alignItems: 'center', gap: 6,
                marginBottom: 10, fontSize: 12, color: '#666', cursor: 'pointer',
              }}>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember
              </label>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => handleRespond(true)}
                disabled={submitting}
                style={{
                  flex: 1, padding: 8, borderRadius: 8, border: 'none',
                  background: '#2A5A8A', color: '#fff', fontSize: 13,
                  cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.6 : 1,
                }}
              >
                Allow
              </button>
              <button
                onClick={() => handleRespond(false)}
                disabled={submitting}
                style={{
                  flex: 1, padding: 8, borderRadius: 8,
                  border: '1px solid #ddd', background: '#fff',
                  color: '#666', fontSize: 13,
                  cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.6 : 1,
                }}
              >
                Deny
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
