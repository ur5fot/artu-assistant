import type { Message } from '@r2/shared';
import { ToolCallCard } from './ToolCallCard';

interface Props {
  message: Message;
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 12,
    }}>
      {message.toolCalls?.map((tc) => (
        <ToolCallCard key={tc.id} toolCall={tc} />
      ))}
      {message.content && (
        <div style={{
          maxWidth: '80%',
          padding: '10px 14px',
          borderRadius: 14,
          fontSize: 14,
          lineHeight: 1.5,
          background: isUser ? '#2A5A8A' : '#f0f0f0',
          color: isUser ? '#fff' : '#222',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {message.content}
        </div>
      )}
    </div>
  );
}
