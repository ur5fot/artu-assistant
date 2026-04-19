import { describe, it, expect, vi } from 'vitest';
import { createMemoryConfirmService } from '../memory-confirm-service.js';
import type { PendingMemoryConfirms } from '../../routes/memory-confirm.js';

describe('memory-confirm-service', () => {
  it('hasPending: reflects map membership', () => {
    const pending: PendingMemoryConfirms = new Map();
    pending.set('c1', () => {});
    const svc = createMemoryConfirmService({ pending });
    expect(svc.hasPending('c1')).toBe(true);
    expect(svc.hasPending('nope')).toBe(false);
  });

  it('resolve: delivers response to pending waiter and deletes entry', () => {
    const pending: PendingMemoryConfirms = new Map();
    const resolver = vi.fn();
    pending.set('c1', resolver);
    const svc = createMemoryConfirmService({ pending });
    expect(svc.resolve('c1', true, { query: 'user.age' })).toEqual({ ok: true });
    expect(resolver).toHaveBeenCalledWith({ approved: true, editedParams: { query: 'user.age' } });
    expect(pending.has('c1')).toBe(false);
  });

  it('resolve: editedParams optional, defaults to undefined', () => {
    const pending: PendingMemoryConfirms = new Map();
    const resolver = vi.fn();
    pending.set('c1', resolver);
    const svc = createMemoryConfirmService({ pending });
    svc.resolve('c1', false);
    expect(resolver).toHaveBeenCalledWith({ approved: false, editedParams: undefined });
  });

  it('resolve: not_found when id absent', () => {
    const svc = createMemoryConfirmService({ pending: new Map() });
    expect(svc.resolve('nope', true)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('isResolvedByUser: true only after resolve, distinguishes from abort-clearing', () => {
    const pending: PendingMemoryConfirms = new Map();
    pending.set('c1', () => {});
    pending.set('c2', () => {});
    const svc = createMemoryConfirmService({ pending });

    expect(svc.isResolvedByUser('c1')).toBe(false);

    svc.resolve('c1', true);
    pending.delete('c2');

    expect(svc.isResolvedByUser('c1')).toBe(true);
    expect(svc.isResolvedByUser('c2')).toBe(false);
  });
});
