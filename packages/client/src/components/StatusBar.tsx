interface Props {
  source: 'ollama' | 'claude' | null;
  messageCount: number;
  responseTime: number | null;
}

export function StatusBar({ source, messageCount, responseTime }: Props) {
  const modelName = source === 'ollama'
    ? 'Ollama'
    : source === 'claude'
      ? 'Claude'
      : 'R2';

  return (
    <div style={{
      padding: '4px 16px',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 11,
      color: 'var(--text-secondary)',
    }}>
      <span>{modelName}</span>
      <span>{messageCount} повідомлень</span>
      <span>{responseTime !== null ? `${responseTime.toFixed(1)}s` : '—'}</span>
    </div>
  );
}
