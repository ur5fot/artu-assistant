import { useRef, useEffect, useImperativeHandle, forwardRef, type KeyboardEvent } from 'react';

export interface ChatInputHandle {
  focus: () => void;
}

interface Props {
  onSend: (text: string) => void;
  disabled: boolean;
  onSlashTyped?: () => void;
  inputValue: string;
  onInputChange: (value: string) => void;
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
  { onSend, disabled, onSlashTyped, inputValue, onInputChange },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
  }), []);

  // Focus input when command palette injects a value
  const prevValueRef = useRef(inputValue);
  useEffect(() => {
    if (inputValue !== prevValueRef.current && inputValue.startsWith('/')) {
      inputRef.current?.focus();
    }
    prevValueRef.current = inputValue;
  }, [inputValue]);

  const handleSend = () => {
    if (!inputValue.trim() || disabled) return;
    onSend(inputValue);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    onInputChange(val);
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
        value={inputValue}
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
        disabled={disabled || !inputValue.trim()}
        style={{
          padding: '10px 20px', borderRadius: 10, border: 'none',
          background: 'var(--primary)', color: 'var(--primary-text)', fontSize: 14,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled || !inputValue.trim() ? 0.5 : 1,
        }}
      >Send</button>
    </div>
  );
});
