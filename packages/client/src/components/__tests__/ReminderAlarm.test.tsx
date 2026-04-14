import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { ReminderAlarm } from '../ReminderAlarm';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, Array<(e: any) => void>> = {};
  readyState = 1;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(event: string, fn: (e: any) => void) {
    (this.listeners[event] ||= []).push(fn);
  }
  close() { this.readyState = 2; }
  fire(eventName: string, data: any) {
    const list = this.listeners[eventName] || this.listeners.message || [];
    for (const fn of list) fn({ data: JSON.stringify(data) });
  }
}

const mockAudio = {
  startLoop: vi.fn(),
  stopLoop: vi.fn(),
};

vi.mock('../../lib/alarm-audio', () => ({
  createAlarmAudio: () => mockAudio,
}));

beforeEach(() => {
  (globalThis as any).EventSource = FakeEventSource;
  FakeEventSource.instances = [];
  mockAudio.startLoop.mockClear();
  mockAudio.stopLoop.mockClear();
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }) as any;
});

afterEach(() => {
  cleanup();
});

describe('ReminderAlarm', () => {
  it('is invisible until a reminder_ring event arrives', () => {
    render(<ReminderAlarm />);
    expect(screen.queryByText(/Выключить/)).toBeNull();
  });

  it('shows modal and starts audio on reminder_ring', () => {
    render(<ReminderAlarm />);
    const src = FakeEventSource.instances[0];
    act(() => {
      src.fire('message', { type: 'reminder_ring', id: 42, text: 'выпить воды' });
    });
    expect(screen.getByText(/выпить воды/)).toBeTruthy();
    expect(mockAudio.startLoop).toHaveBeenCalledOnce();
  });

  it('stops audio on reminder_stop_ring but keeps modal', () => {
    render(<ReminderAlarm />);
    const src = FakeEventSource.instances[0];
    act(() => {
      src.fire('message', { type: 'reminder_ring', id: 42, text: 'a' });
      src.fire('message', { type: 'reminder_stop_ring', id: 42 });
    });
    expect(mockAudio.stopLoop).toHaveBeenCalled();
    expect(screen.getByText(/a/)).toBeTruthy();
  });

  it('removes entry on reminder_done', () => {
    render(<ReminderAlarm />);
    const src = FakeEventSource.instances[0];
    act(() => {
      src.fire('message', { type: 'reminder_ring', id: 42, text: 'a' });
      src.fire('message', { type: 'reminder_done', id: 42 });
    });
    expect(screen.queryByText(/a/)).toBeNull();
  });

  it('clicking Dismiss POSTs to /api/reminder/dismiss', async () => {
    render(<ReminderAlarm />);
    const src = FakeEventSource.instances[0];
    act(() => {
      src.fire('message', { type: 'reminder_ring', id: 42, text: 'a' });
    });
    const btn = screen.getByRole('button', { name: /Выключить/ });
    fireEvent.click(btn);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/reminder/dismiss',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('clicking Snooze POSTs to /api/reminder/snooze', async () => {
    render(<ReminderAlarm />);
    const src = FakeEventSource.instances[0];
    act(() => {
      src.fire('message', { type: 'reminder_ring', id: 42, text: 'a' });
    });
    const btn = screen.getByRole('button', { name: /Через 10 мин/ });
    fireEvent.click(btn);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/reminder/snooze',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
