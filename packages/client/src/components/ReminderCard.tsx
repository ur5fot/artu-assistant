import type { ReminderInfo } from '@r2/shared';

interface Props {
  reminder: ReminderInfo;
  onDismiss: (id: number) => void;
  onSnooze: (id: number) => void;
}

const borderColors: Record<ReminderInfo['status'], string> = {
  ringing: '#DC2626',
  paused: '#D97706',
  done: '#888',
  dismissed: '#888',
};

export function ReminderCard({ reminder, onDismiss, onSnooze }: Props) {
  const isActive = reminder.status === 'ringing' || reminder.status === 'paused';

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderLeft: `4px solid ${borderColors[reminder.status]}`,
      borderRadius: 10,
      padding: 12,
      marginBottom: 6,
      maxWidth: '80%',
      fontSize: 13,
    }}>
      <div style={{
        fontWeight: 600,
        marginBottom: isActive ? 8 : 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        <span style={reminder.status === 'ringing' ? {
          animation: 'pulse 1s ease-in-out infinite',
        } : undefined}>⏰</span>
        {reminder.text}
        {reminder.status === 'paused' && (
          <span style={{ fontSize: 11, color: '#D97706', fontWeight: 400 }}>(пауза)</span>
        )}
        {reminder.status === 'done' && (
          <span style={{ fontSize: 11, color: '#888', fontWeight: 400 }}>(пропущено)</span>
        )}
        {reminder.status === 'dismissed' && (
          <span style={{ fontSize: 11, color: '#888', fontWeight: 400 }}>(выключено)</span>
        )}
      </div>
      {isActive && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => onDismiss(reminder.id)}
            style={{
              padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)',
              background: 'var(--card-bg)', cursor: 'pointer', fontSize: 12, color: 'var(--text)',
            }}
          >
            ✓ Выключить
          </button>
          <button
            onClick={() => onSnooze(reminder.id)}
            style={{
              padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)',
              background: 'var(--card-bg)', cursor: 'pointer', fontSize: 12, color: 'var(--text)',
            }}
          >
            😴 Через 10 мин
          </button>
        </div>
      )}
    </div>
  );
}
