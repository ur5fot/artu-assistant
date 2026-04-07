import { useState, type KeyboardEvent } from 'react';

interface Props {
  onSend: (text: string) => void;
  disabled: boolean;
}

export function ChatInput({ onSend, disabled }: Props) {
  const [input, setInput] = useState('');

  const handleSend = () => {
    if (!input.trim() || disabled) return;
    onSend(input);
    setInput('');
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div style={{
      padding: '12px 16px',
      borderTop: '1px solid #e5e5e5',
      display: 'flex',
      gap: 8,
    }}>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message R2..."
        disabled={disabled}
        style={{
          flex: 1, padding: '10px 14px', borderRadius: 10,
          border: '1px solid #ddd', fontSize: 14, outline: 'none',
        }}
      />
      <button
        onClick={handleSend}
        disabled={disabled || !input.trim()}
        style={{
          padding: '10px 20px', borderRadius: 10, border: 'none',
          background: '#2A5A8A', color: '#fff', fontSize: 14,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled || !input.trim() ? 0.5 : 1,
        }}
      >Send</button>
    </div>
  );
}
