import { Chat } from './components/Chat';
import { ReminderAlarm } from './components/ReminderAlarm';
import { useSupervisor } from './hooks/useSupervisor';
import { useTheme } from './hooks/useTheme';

function StatusBar({ workerStatus }: { workerStatus: string }) {
  if (workerStatus === 'running' || workerStatus === 'unknown') return null;

  const isCrash = workerStatus === 'crashed';

  return (
    <div style={{
      padding: '8px 16px',
      background: isCrash ? 'var(--status-crash-bg)' : 'var(--status-restart-bg)',
      color: isCrash ? 'var(--status-crash-text)' : 'var(--status-restart-text)',
      fontSize: 13,
      fontWeight: 500,
      textAlign: 'center',
      animation: 'pulse 2s ease-in-out infinite',
    }}>
      {isCrash ? 'R2 crashed, restarting...' : 'R2 is restarting...'}
    </div>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: string; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        fontSize: 20,
        padding: 4,
        lineHeight: 1,
      }}
    >
      {theme === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19'}
    </button>
  );
}

export default function App() {
  const { workerStatus } = useSupervisor();
  const { theme, toggle } = useTheme();

  return (
    <div style={{
      maxWidth: 640,
      margin: '0 auto',
      height: '100dvh',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <ReminderAlarm />
      <StatusBar workerStatus={workerStatus} />
      <header style={{
        padding: '16px 20px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: 'var(--primary)', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: 'var(--primary-text)', fontWeight: 600, fontSize: 14,
        }}>R2</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>R2</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Personal assistant</div>
        </div>
        <ThemeToggle theme={theme} onToggle={toggle} />
      </header>
      <Chat />
    </div>
  );
}
