import { useRef, useEffect, useState, useCallback } from 'react';
import { useChat } from '../hooks/useChat';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { StatusBar } from './StatusBar';
import { CommandPalette } from './CommandPalette';

export function Chat() {
  const { messages, loading, error, send, pendingConfirms, respondToConfirm, pendingPlanReviews, respondToPlanReview, historyLoaded, lastResponseTime, lastSource } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Cmd+K to open palette
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (!loading) setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [loading]);

  const handleSlashTyped = useCallback(() => {
    if (!loading) {
      setPaletteOpen(true);
      setInputValue('');
    }
  }, [loading]);

  const handleCommandSelect = useCallback((cmd: { name: string; params?: Array<{ name: string; required: boolean }> }) => {
    setPaletteOpen(false);
    const hasRequiredParams = cmd.params?.some((p) => p.required);
    if (hasRequiredParams) {
      setInputValue(`/${cmd.name} `);
    } else {
      setInputValue('');
      send(`/${cmd.name}`);
    }
  }, [send]);

  const handleSend = useCallback((text: string) => {
    setInputValue('');
    send(text);
  }, [send]);

  return (
    <>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        {messages.length === 0 && (
          <div style={{
            textAlign: 'center', color: 'var(--text-muted)',
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
          <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '4px 0' }}>
            R2 thinking...
          </div>
        )}
        {error && (
          <div style={{ fontSize: 13, color: 'var(--error)', padding: '4px 0' }}>
            Error: {error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <ChatInput
        onSend={handleSend}
        disabled={loading || !historyLoaded}
        onSlashTyped={handleSlashTyped}
        inputValue={inputValue}
        onInputChange={setInputValue}
      />
      <StatusBar
        source={lastSource}
        messageCount={messages.length}
        responseTime={lastResponseTime}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={handleCommandSelect}
      />
    </>
  );
}
