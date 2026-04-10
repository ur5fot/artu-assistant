import { useState } from 'react';

interface Props {
  callId: string;
  task: string;
  plan: string;
  onRespond: (callId: string, approved: boolean, editedPlan?: string) => Promise<boolean>;
}

export function PlanReviewCard({ callId, task, plan, onRespond }: Props) {
  const [editedPlan, setEditedPlan] = useState(plan);
  const [submitting, setSubmitting] = useState(false);
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);

  const handle = async (approved: boolean) => {
    setSubmitting(true);
    try {
      const ok = await onRespond(callId, approved, approved ? editedPlan : undefined);
      if (ok) setDecision(approved ? 'approved' : 'rejected');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      background: '#f8f8f8',
      border: '1px solid #e5e5e5',
      borderRadius: 14,
      padding: 16,
      marginBottom: 6,
      maxWidth: '80%',
      fontSize: 13,
      opacity: decision ? 0.7 : submitting ? 0.85 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{
          width: 28, height: 28, borderRadius: '50%',
          background: '#10B981', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14,
        }}>📋</div>
        <div style={{ fontWeight: 600 }}>Review plan before running</div>
      </div>

      <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
        <strong>Task:</strong> {task}
      </div>

      <textarea
        value={editedPlan}
        onChange={(e) => setEditedPlan(e.target.value)}
        disabled={decision !== null || submitting}
        rows={15}
        style={{
          width: '100%',
          fontFamily: 'SF Mono, Menlo, monospace',
          fontSize: 11,
          padding: 10,
          border: '1px solid #e5e5e5',
          borderRadius: 8,
          marginBottom: 10,
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />

      {decision ? (
        <div style={{
          fontWeight: 600,
          color: decision === 'approved' ? '#059669' : '#DC2626',
        }}>
          {decision === 'approved' ? '✓ Plan approved, running...' : '✗ Plan rejected'}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => handle(true)}
            disabled={submitting}
            style={{
              flex: 1, padding: 10, borderRadius: 8, border: 'none',
              background: '#2A5A8A', color: '#fff', fontSize: 13,
              cursor: submitting ? 'wait' : 'pointer',
            }}
          >
            Run plan
          </button>
          <button
            onClick={() => handle(false)}
            disabled={submitting}
            style={{
              flex: 1, padding: 10, borderRadius: 8,
              border: '1px solid #ddd', background: '#fff',
              color: '#666', fontSize: 13,
              cursor: submitting ? 'wait' : 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
