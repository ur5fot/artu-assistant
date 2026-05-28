import { describe, it, expect } from 'vitest';
import {
  createDraftReplyService,
  type DraftState,
} from '../draft-reply-service.js';

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

describe('draft-reply-service', () => {
  it('put / get round-trips a DraftState', () => {
    const svc = createDraftReplyService({ pendingDrafts: new Map() });
    const state = sampleState();
    svc.put(state);
    expect(svc.get('p1')).toEqual(state);
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
});
