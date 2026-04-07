import { Chat } from './components/Chat';

export default function App() {
  return (
    <div style={{
      maxWidth: 640,
      margin: '0 auto',
      height: '100dvh',
      display: 'flex',
      flexDirection: 'column',
    }}>
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
