import { Chat } from './components/Chat';
import { useSupervisor } from './hooks/useSupervisor';

function StatusBar({ workerStatus }: { workerStatus: string }) {
  if (workerStatus === 'running' || workerStatus === 'unknown') return null;

  const isCrash = workerStatus === 'crashed';
  const bg = isCrash ? '#fee2e2' : '#fef3c7';
  const color = isCrash ? '#991b1b' : '#92400e';
  const text = isCrash ? 'R2 crashed, restarting...' : 'R2 is restarting...';

  return (
    <div style={{
      padding: '8px 16px',
      background: bg,
      color,
      fontSize: 13,
      fontWeight: 500,
      textAlign: 'center',
      animation: 'pulse 2s ease-in-out infinite',
    }}>
      {text}
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }`}</style>
    </div>
  );
}

export default function App() {
  const { workerStatus } = useSupervisor();

  return (
    <div style={{
      maxWidth: 640,
      margin: '0 auto',
      height: '100dvh',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <StatusBar workerStatus={workerStatus} />
      <header style={{
        padding: '16px 20px',
        borderBottom: '1px solid #e5e5e5',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: '#2A5A8A', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontWeight: 600, fontSize: 14,
        }}>R2</div>
        <div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>R2</div>
          <div style={{ fontSize: 12, color: '#888' }}>Personal assistant</div>
        </div>
      </header>
      <Chat />
    </div>
  );
}
