import { useState, useRef, useEffect, type KeyboardEvent } from 'react';

interface Props {
  onSend: (text: string) => void;
  disabled: boolean;
  onSlashTyped?: () => void;
  inputValue?: string;
  onInputChange?: (value: string) => void;
}

export function ChatInput({ onSend, disabled, onSlashTyped, inputValue, onInputChange }: Props) {
  const [localInput, setLocalInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Support controlled mode from parent (for command palette injection)
  const input = inputValue !== undefined ? inputValue : localInput;
  const setInput = (v: string) => {
    if (onInputChange) onInputChange(v);
    else setLocalInput(v);
  };

  // Focus input when inputValue changes externally (command selected)
  useEffect(() => {
    if (inputValue !== undefined) {
      inputRef.current?.focus();
    }
  }, [inputValue]);

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

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInput(val);
    // If user just typed `/` as the first character, open palette
    if (val === '/' && onSlashTyped) {
      onSlashTyped();
    }
  };

  return (
    <div style={{
      padding: '12px 16px',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      gap: 8,
    }}>
      <input
        ref={inputRef}
        value={input}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Message R2..."
        disabled={disabled}
        style={{
          flex: 1, padding: '10px 14px', borderRadius: 10,
          border: '1px solid var(--border)', fontSize: 14, outline: 'none',
          background: 'var(--bg)', color: 'var(--text)',
        }}
      />
      <button
        onClick={handleSend}
        disabled={disabled || !input.trim()}
        style={{
          padding: '10px 20px', borderRadius: 10, border: 'none',
          background: 'var(--primary)', color: 'var(--primary-text)', fontSize: 14,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled || !input.trim() ? 0.5 : 1,
        }}
      >Send</button>
    </div>
  );
}
