import type { Message } from '@r2/shared';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PiiBadge } from './PiiBadge';
import { MemoryRecalledCard } from './MemoryRecalledCard';
import { ToolCallCard } from './ToolCallCard';
import { PermissionCard } from './PermissionCard';
import { PlanReviewCard } from './PlanReviewCard';
import { ReminderCard } from './ReminderCard';
import type { PendingConfirm, PendingPlanReview } from '../hooks/useChat';

interface Props {
  message: Message;
  pendingConfirms: Map<string, PendingConfirm>;
  pendingPlanReviews: Map<string, PendingPlanReview>;
  onRespond: (callId: string, allowed: boolean, remember: boolean) => Promise<boolean>;
  onRespondPlanReview: (callId: string, approved: boolean, editedPlan?: string) => Promise<boolean>;
  onForgetFact?: (key: string) => void;
  onDismissReminder?: (id: number) => void;
  onSnoozeReminder?: (id: number) => void;
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

export function MessageBubble({ message, pendingConfirms, pendingPlanReviews, onRespond, onRespondPlanReview, onForgetFact, onDismissReminder, onSnoozeReminder }: Props) {
  const isUser = message.role === 'user';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 12,
    }}>
      <style>{markdownStyles}</style>
      {!isUser && message.recalledFacts && message.recalledFacts.length > 0 && (
        <MemoryRecalledCard facts={message.recalledFacts} onForget={onForgetFact} />
      )}
      {message.toolCalls?.map((tc) => {
        const planReview = pendingPlanReviews.get(tc.id);
        if (planReview) {
          return (
            <PlanReviewCard
              key={tc.id}
              callId={planReview.callId}
              task={planReview.task}
              plan={planReview.plan}
              onRespond={onRespondPlanReview}
            />
          );
        }
        const pending = pendingConfirms.get(tc.id);
        if (pending) {
          return (
            <PermissionCard
              key={tc.id}
              toolCall={tc}
              level={pending.level}
              destructiveWarning={pending.destructiveWarning}
              onRespond={onRespond}
            />
          );
        }
        return <ToolCallCard key={tc.id} toolCall={tc} />;
      })}
      {message.reminder && (
        <ReminderCard
          reminder={message.reminder}
          onDismiss={onDismissReminder ?? (() => {})}
          onSnooze={onSnoozeReminder ?? (() => {})}
        />
      )}
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
      {!isUser && message.source && (
        <div style={{
          fontSize: 10,
          color: '#888',
          marginTop: 2,
          paddingLeft: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}>
          {message.source === 'ollama' ? '🦙 Ollama' : '✨ Claude'}
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
