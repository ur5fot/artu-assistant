import type { ToolCall } from '@r2/shared';

interface Props {
  toolCall: ToolCall;
}

const STATUS_LABELS: Record<ToolCall['status'], string> = {
  running: 'Running...',
  done: 'Done',
  error: 'Error',
};

export function ToolCallCard({ toolCall }: Props) {
  return (
    <div style={{
      fontSize: 12,
      color: '#666',
      background: '#f8f8f8',
      border: '1px solid #e5e5e5',
      borderRadius: 8,
      padding: '8px 12px',
      marginBottom: 6,
      maxWidth: '80%',
    }}>
      <div style={{ fontWeight: 600 }}>
        {toolCall.name} — {STATUS_LABELS[toolCall.status]}
      </div>
      {toolCall.result?.display && (
        <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', color: '#444' }}>
          {toolCall.result.display.content}
        </div>
      )}
      {toolCall.result?.error && (
        <div style={{ marginTop: 4, color: '#c00' }}>
          {toolCall.result.error}
        </div>
      )}
    </div>
  );
}
