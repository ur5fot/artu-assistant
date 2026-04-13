import type { RecalledFact } from '@r2/shared';

interface Props {
  facts: RecalledFact[];
  onForget?: (key: string) => void;
}

export function MemoryRecalledCard({ facts, onForget }: Props) {
  if (!facts || facts.length === 0) return null;
  return (
    <div style={{
      maxWidth: '80%',
      marginBottom: 6,
      padding: '6px 10px',
      borderRadius: 10,
      background: 'rgba(90, 140, 200, 0.08)',
      border: '1px solid rgba(90, 140, 200, 0.25)',
      fontSize: 12,
      color: '#445',
      lineHeight: 1.5,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>🧠 Згадав</div>
      {facts.map((f) => (
        <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: 'SF Mono, Menlo, monospace' }}>{f.key}</span>
          <span>= {f.value}</span>
          {f.importance >= 10 && <span title="важливо">⭐</span>}
          {onForget && (
            <button
              type="button"
              onClick={() => onForget(f.key)}
              title={`Забути ${f.key}`}
              style={{
                marginLeft: 'auto',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 12,
                color: '#888',
                padding: '0 4px',
              }}
            >
              🗑
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
