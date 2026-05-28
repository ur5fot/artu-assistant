import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createDraftReplyService,
  type DraftState,
} from '../draft-reply-service.js';

type Timer = ReturnType<typeof setTimeout>;
const t = (cb: () => void, ms: number): Timer =>
  setTimeout(cb, ms) as unknown as Timer;

function sampleState(overrides: Partial<DraftState> = {}): DraftState {
  return {
    pendingId: 'p1',
    originalUid: 42,
    accountId: 'acc-1',
    to: 'alice@example.com',
    subject: 'Re: hello',
    inReplyTo: '<orig@example.com>',
    references: ['<orig@example.com>'],
    body: 'draft body',
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe('draft-reply-service', () => {
  it('put / get round-trips a DraftState', () => {
    const svc = createDraftReplyService({ pendingDrafts: new Map() });
    const state = sampleState();
    svc.put(state);
    const stored = svc.get('p1');
    expect(stored).toMatchObject(state);
    expect(stored?.holdTimer).toBeNull();
    expect(stored?.holdSendAt).toBeNull();
  });

  it('get returns null when id is unknown', () => {
    const svc = createDraftReplyService({ pendingDrafts: new Map() });
    expect(svc.get('missing')).toBeNull();
  });

  it('has reflects map membership', () => {
    const svc = createDraftReplyService({ pendingDrafts: new Map() });
    expect(svc.has('p1')).toBe(false);
    svc.put(sampleState());
    expect(svc.has('p1')).toBe(true);
  });

  it('drop removes the entry', () => {
    const svc = createDraftReplyService({ pendingDrafts: new Map() });
    svc.put(sampleState());
    svc.drop('p1');
    expect(svc.has('p1')).toBe(false);
    expect(svc.get('p1')).toBeNull();
  });

  it('drop is silent for unknown id', () => {
    const svc = createDraftReplyService({ pendingDrafts: new Map() });
    expect(() => svc.drop('missing')).not.toThrow();
  });

  it('put overwrites existing state with same pendingId', () => {
    const svc = createDraftReplyService({ pendingDrafts: new Map() });
    svc.put(sampleState({ body: 'first' }));
    svc.put(sampleState({ body: 'second' }));
    expect(svc.get('p1')?.body).toBe('second');
  });

  describe('armHold / disarmHold', () => {
    it('armHold sets holdTimer and holdSendAt', () => {
      vi.useFakeTimers();
      const svc = createDraftReplyService({ pendingDrafts: new Map() });
      svc.put(sampleState());
      const cb = vi.fn();
      const timer = t(cb, 30_000);
      const sendAt = Date.now() + 30_000;
      svc.armHold('p1', timer, sendAt);
      const stored = svc.get('p1');
      expect(stored?.holdTimer).toBe(timer);
      expect(stored?.holdSendAt).toBe(sendAt);
    });

    it('armHold twice clears the previous timer', async () => {
      vi.useFakeTimers();
      const svc = createDraftReplyService({ pendingDrafts: new Map() });
      svc.put(sampleState());
      const first = vi.fn();
      const second = vi.fn();
      svc.armHold('p1', t(first, 30_000), Date.now() + 30_000);
      svc.armHold('p1', t(second, 30_000), Date.now() + 30_000);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('armHold on missing state row is a silent no-op', () => {
      const svc = createDraftReplyService({ pendingDrafts: new Map() });
      const cb = vi.fn();
      const timer = t(cb, 10_000);
      expect(() => svc.armHold('missing', timer, Date.now() + 10_000)).not.toThrow();
      expect(svc.get('missing')).toBeNull();
      clearTimeout(timer);
    });

    it('disarmHold clears the timer and nulls the fields', async () => {
      vi.useFakeTimers();
      const svc = createDraftReplyService({ pendingDrafts: new Map() });
      svc.put(sampleState());
      const cb = vi.fn();
      svc.armHold('p1', t(cb, 30_000), Date.now() + 30_000);
      svc.disarmHold('p1');
      await vi.advanceTimersByTimeAsync(31_000);
      expect(cb).not.toHaveBeenCalled();
      const stored = svc.get('p1');
      expect(stored?.holdTimer).toBeNull();
      expect(stored?.holdSendAt).toBeNull();
    });

    it('disarmHold on an entry with null timer is a no-op', () => {
      const svc = createDraftReplyService({ pendingDrafts: new Map() });
      svc.put(sampleState());
      expect(() => svc.disarmHold('p1')).not.toThrow();
      const stored = svc.get('p1');
      expect(stored?.holdTimer).toBeNull();
      expect(stored?.holdSendAt).toBeNull();
    });

    it('disarmHold on missing state row is a silent no-op', () => {
      const svc = createDraftReplyService({ pendingDrafts: new Map() });
      expect(() => svc.disarmHold('missing')).not.toThrow();
    });

    it('drop after armHold clears the timer — no fire after drop', async () => {
      vi.useFakeTimers();
      const svc = createDraftReplyService({ pendingDrafts: new Map() });
      svc.put(sampleState());
      const cb = vi.fn();
      svc.armHold('p1', t(cb, 30_000), Date.now() + 30_000);
      svc.drop('p1');
      await vi.advanceTimersByTimeAsync(31_000);
      expect(cb).not.toHaveBeenCalled();
      expect(svc.has('p1')).toBe(false);
    });
  });
});
