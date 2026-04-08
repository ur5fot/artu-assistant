import type { Message } from '@r2/shared';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PiiBadge } from './PiiBadge';
import { ToolCallCard } from './ToolCallCard';
import { PermissionCard } from './PermissionCard';
import type { PendingConfirm } from '../hooks/useChat';

interface Props {
  message: Message;
  pendingConfirms: Map<string, PendingConfirm>;
  onRespond: (callId: string, allowed: boolean, remember: boolean) => Promise<boolean>;
}

const markdownStyles = `
.r2-markdown h1, .r2-markdown h2, .r2-markdown h3 { margin: 8px 0 4px; }
.r2-markdown h1 { font-size: 1.2em; }
.r2-markdown h2 { font-size: 1.1em; }
.r2-markdown h3 { font-size: 1em; }
.r2-markdown p { margin: 4px 0; }
.r2-markdown ul, .r2-markdown ol { margin: 4px 0; padding-left: 20px; }
.r2-markdown li { margin: 2px 0; }
.r2-markdown code {
  background: rgba(0,0,0,0.08); padding: 1px 4px; border-radius: 3px;
  font-size: 0.9em; font-family: 'SF Mono', Menlo, monospace;
}
.r2-markdown pre {
  background: rgba(0,0,0,0.06); padding: 8px 10px; border-radius: 6px;
  overflow-x: auto; margin: 6px 0;
}
.r2-markdown pre code { background: none; padding: 0; }
.r2-markdown table {
  border-collapse: collapse; width: 100%; margin: 6px 0; font-size: 13px;
}
.r2-markdown th, .r2-markdown td {
  border: 1px solid rgba(0,0,0,0.15); padding: 4px 8px; text-align: left;
}
.r2-markdown th { font-weight: 600; background: rgba(0,0,0,0.04); }
.r2-markdown blockquote {
  border-left: 3px solid rgba(0,0,0,0.2); margin: 6px 0; padding: 2px 10px; color: #555;
}
.r2-markdown a { color: #2A5A8A; text-decoration: underline; }
.r2-markdown strong { font-weight: 600; }
.r2-markdown hr { border: none; border-top: 1px solid rgba(0,0,0,0.1); margin: 8px 0; }
`;

export function MessageBubble({ message, pendingConfirms, onRespond }: Props) {
  const isUser = message.role === 'user';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 12,
    }}>
      <style>{markdownStyles}</style>
      {message.toolCalls?.map((tc) => {
        const pending = pendingConfirms.get(tc.id);
        if (pending) {
          return (
            <PermissionCard
              key={tc.id}
              toolCall={tc}
              level={pending.level}
              onRespond={onRespond}
            />
          );
        }
        return <ToolCallCard key={tc.id} toolCall={tc} />;
      })}
      {message.piiEntities && message.piiEntities.length > 0 && (
        <PiiBadge entities={message.piiEntities} />
      )}
      {message.content && (
        <div style={{
          maxWidth: '80%',
          padding: '10px 14px',
          borderRadius: 14,
          fontSize: 14,
          lineHeight: 1.5,
          background: isUser ? '#2A5A8A' : '#f0f0f0',
          color: isUser ? '#fff' : '#222',
          wordBreak: 'break-word',
        }}>
          {isUser ? (
            <span style={{ whiteSpace: 'pre-wrap' }}>{message.content}</span>
          ) : (
            <div className="r2-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
      {message.timestamp > 0 && (
        <div style={{
          fontSize: 11,
          color: '#aaa',
          marginTop: 2,
          paddingLeft: isUser ? 0 : 4,
          paddingRight: isUser ? 4 : 0,
        }}>
          {new Date(message.timestamp).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  );
}
