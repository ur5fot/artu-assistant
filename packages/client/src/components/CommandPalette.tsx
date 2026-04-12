import { useState, useEffect, useRef, useCallback } from 'react';

interface CommandDef {
  name: string;
  tool: string;
  description: string;
  params?: Array<{ name: string; required: boolean; description?: string }>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (command: CommandDef) => void;
}

export function CommandPalette({ open, onClose, onSelect }: Props) {
  const [commands, setCommands] = useState<CommandDef[]>([]);
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/commands')
      .then((res) => res.json())
      .then(setCommands)
      .catch((err) => console.error('Failed to load commands:', err));
  }, []);

  useEffect(() => {
    if (open) {
      setFilter('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const filtered = commands.filter((c) =>
    c.name.toLowerCase().includes(filter.toLowerCase()) ||
    c.description.toLowerCase().includes(filter.toLowerCase()),
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        onSelect(filtered[selectedIndex]);
      }
    }
  }, [filtered, selectedIndex, onClose, onSelect]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '20vh', zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg)', borderRadius: 12,
          border: '1px solid var(--border)', width: 400,
          maxHeight: 360, display: 'flex', flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{ padding: '12px 12px 8px' }}>
          <input
            ref={inputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Знайти команду..."
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 8,
              border: '1px solid var(--border)', fontSize: 14,
              outline: 'none', background: 'var(--surface)',
              color: 'var(--text)',
            }}
          />
        </div>
        <div style={{ overflowY: 'auto', padding: '0 4px 8px' }}>
          {filtered.length === 0 && (
            <div style={{ padding: '12px', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
              Нічого не знайдено
            </div>
          )}
          {filtered.map((cmd, i) => (
            <div
              key={cmd.name}
              onClick={() => onSelect(cmd)}
              style={{
                padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 10,
                background: i === selectedIndex ? 'var(--surface-alt)' : 'transparent',
                margin: '0 4px',
              }}
            >
              <span style={{
                fontFamily: 'monospace', fontSize: 13,
                color: 'var(--primary)', fontWeight: 600,
              }}>
                /{cmd.name}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {cmd.description}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
