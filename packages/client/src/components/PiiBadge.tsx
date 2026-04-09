import { useState } from 'react';

interface Props {
  entities: Array<{ type: string; original: string }>;
}

export function PiiBadge({ entities }: Props) {
  const [expanded, setExpanded] = useState(false);

  // Deduplicate by type+original
  const unique = entities.filter((e, i, arr) =>
    arr.findIndex((x) => x.type === e.type && x.original === e.original) === i
  );

  return (
    <div style={{
      display: 'inline-flex',
      flexDirection: 'column',
      background: '#f0f9ff',
      border: '1px solid #bae6fd',
      borderRadius: 8,
      padding: '4px 8px',
      fontSize: 12,
      color: '#0c4a6e',
      cursor: 'pointer',
      marginBottom: 4,
      maxWidth: '80%',
    }} onClick={() => setExpanded(!expanded)}>
      <span>{'\u{1F6E1}'} {entities.length} PII masked</span>
      {expanded && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#475569' }}>
          {unique.map((e, i) => (
            <div key={i}>{e.type}: <strong>{e.original || '***'}</strong></div>
          ))}
        </div>
      )}
    </div>
  );
}
