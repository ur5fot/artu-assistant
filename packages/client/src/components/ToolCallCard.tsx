import { useState } from 'react';
import type { ToolCall } from '@r2/shared';
import { DiffView } from './DiffView';

interface Props {
  toolCall: ToolCall;
}

interface CodeTaskData {
  summary?: string;
  files?: Array<{ path: string; added: number; removed: number }>;
  shortDiff?: string;
  fullDiff?: string;
  commit?: string;
  mode?: 'once' | 'ralphex';
  durationMs?: number;
  blockedFiles?: string[];
}

export function ToolCallCard({ toolCall }: Props) {
  if (toolCall.name === 'code_task') {
    return <CodeTaskCard toolCall={toolCall} />;
  }

  // Generic rendering for other tools
  const { result } = toolCall;
  const statusIcon = toolCall.status === 'running' ? '⏵' : toolCall.status === 'done' ? '✓' : '✗';
  const statusColor = toolCall.status === 'running' ? '#888' : toolCall.status === 'done' ? '#059669' : '#DC2626';

  return (
    <div style={{
      background: '#f8f8f8', border: '1px solid #e5e5e5', borderRadius: 10,
      padding: 10, marginBottom: 6, maxWidth: '80%', fontSize: 12,
    }}>
      <div style={{ fontWeight: 600, color: statusColor, marginBottom: 4 }}>
        {statusIcon} {toolCall.name}
      </div>
      {result?.display?.content && (
        <div style={{ fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap', color: '#444' }}>
          {result.display.content.slice(0, 400)}
        </div>
      )}
      {result?.error && (
        <div style={{ color: '#DC2626', fontSize: 11 }}>{result.error}</div>
      )}
    </div>
  );
}

function CodeTaskCard({ toolCall }: { toolCall: ToolCall }) {
  const [showFullDiff, setShowFullDiff] = useState(false);
  const data = (toolCall.result?.data ?? {}) as CodeTaskData;
  const task = typeof toolCall.input.task === 'string' ? toolCall.input.task : '';

  if (toolCall.status === 'running') {
    return (
      <div style={{
        background: '#f8f8f8', border: '1px solid #e5e5e5', borderRadius: 10,
        padding: 12, marginBottom: 6, maxWidth: '80%', fontSize: 13,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>🛠 code_task</div>
        <div style={{ color: '#666', fontSize: 12, marginBottom: 8 }}>
          Task: "{task}"
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          color: '#888', fontSize: 12, fontStyle: 'italic',
        }}>
          <span className="r2-pulse-dot">⏵</span>
          {toolCall.progress ?? 'Starting...'}
        </div>
        <style>{`
          @keyframes r2-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
          .r2-pulse-dot { animation: r2-pulse 1.2s ease-in-out infinite; }
        `}</style>
      </div>
    );
  }

  if (toolCall.status === 'error' || !toolCall.result?.success) {
    return (
      <div style={{
        background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 10,
        padding: 12, marginBottom: 6, maxWidth: '80%', fontSize: 13,
      }}>
        <div style={{ fontWeight: 600, color: '#991B1B', marginBottom: 4 }}>
          ✗ code_task failed
        </div>
        <div style={{ fontSize: 12, color: '#991B1B' }}>
          {toolCall.result?.error ?? 'Unknown error'}
        </div>
      </div>
    );
  }

  const durationSec = data.durationMs ? Math.round(data.durationMs / 1000) : 0;
  const mins = Math.floor(durationSec / 60);
  const secs = durationSec % 60;
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  return (
    <div style={{
      background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10,
      padding: 12, marginBottom: 6, maxWidth: '80%', fontSize: 13,
    }}>
      <div style={{ fontWeight: 600, color: '#065f46', marginBottom: 4 }}>
        ✓ code_task ({timeStr})
      </div>
      {task && (
        <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
          Task: "{task}"
        </div>
      )}
      {data.commit && (
        <div style={{ fontSize: 11, color: '#888', fontFamily: 'monospace', marginBottom: 8 }}>
          Commit: {data.commit.slice(0, 7)} ({data.mode ?? 'once'})
        </div>
      )}
      {data.files && data.files.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            📁 {data.files.length} files changed
          </div>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 11, color: '#444' }}>
            {data.files.map((f) => (
              <li key={f.path}>
                <span style={{ fontFamily: 'monospace' }}>{f.path}</span>{' '}
                <span style={{ color: '#059669' }}>+{f.added}</span>{' '}
                <span style={{ color: '#DC2626' }}>-{f.removed}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.blockedFiles && data.blockedFiles.length > 0 && (
        <div style={{
          background: '#fef3c7', border: '1px solid #fcd34d',
          borderRadius: 6, padding: 8, marginBottom: 8,
          fontSize: 11, color: '#92400e',
        }}>
          <strong>⚠ {data.blockedFiles.length} files blocked by denylist:</strong>{' '}
          {data.blockedFiles.join(', ')}
        </div>
      )}
      {(data.shortDiff || data.fullDiff) && (
        <div>
          <button
            onClick={() => setShowFullDiff(!showFullDiff)}
            style={{
              background: 'none', border: 'none', color: '#2A5A8A',
              cursor: 'pointer', padding: 0, fontSize: 12, marginBottom: 4,
            }}
          >
            {showFullDiff ? 'Hide diff ▲' : 'Show diff ▼'}
          </button>
          {showFullDiff && (
            <DiffView diff={data.fullDiff ?? data.shortDiff ?? ''} />
          )}
        </div>
      )}
    </div>
  );
}
