import { useRef, useEffect } from 'react';
import { useChat } from '../hooks/useChat';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { StatusBar } from './StatusBar';

export function Chat() {
  const { messages, loading, error, send, pendingConfirms, respondToConfirm, pendingPlanReviews, respondToPlanReview, historyLoaded, lastResponseTime, lastSource } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  return (
    <>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        {messages.length === 0 && (
          <div style={{
            textAlign: 'center', color: '#aaa',
            marginTop: '30vh', fontSize: 14,
          }}>
            R2 ready. What do you need?
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            pendingConfirms={pendingConfirms}
            pendingPlanReviews={pendingPlanReviews}
            onRespond={respondToConfirm}
            onRespondPlanReview={respondToPlanReview}
          />
        ))}
        {loading && (
          <div style={{ fontSize: 13, color: '#aaa', padding: '4px 0' }}>
            R2 thinking...
          </div>
        )}
        {error && (
          <div style={{ fontSize: 13, color: '#c00', padding: '4px 0' }}>
            Error: {error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <ChatInput onSend={send} disabled={loading || !historyLoaded} />
      <StatusBar
        source={lastSource}
        messageCount={messages.length}
        responseTime={lastResponseTime}
      />
    </>
  );
}
