import { describe, it, expect, vi } from 'vitest';
import { createPermissionService } from '../permission-service.js';
import type { PendingConfirms } from '../../routes/confirm.js';

describe('permission-service', () => {
  it('hasPending: true when callId is in the map', () => {
    const pending: PendingConfirms = new Map();
    pending.set('c1', () => {});
    const svc = createPermissionService({ pending });
    expect(svc.hasPending('c1')).toBe(true);
    expect(svc.hasPending('c2')).toBe(false);
  });

  it('resolveConfirm: calls resolver, deletes entry, returns ok', () => {
    const pending: PendingConfirms = new Map();
    const resolver = vi.fn();
    pending.set('c1', resolver);
    const svc = createPermissionService({ pending });
    expect(svc.resolveConfirm('c1', true, false)).toEqual({ ok: true });
    expect(resolver).toHaveBeenCalledWith({ allowed: true, remember: false });
    expect(pending.has('c1')).toBe(false);
  });

  it('resolveConfirm: returns not_found for unknown callId', () => {
    const pending: PendingConfirms = new Map();
    const svc = createPermissionService({ pending });
    expect(svc.resolveConfirm('c-x', true, false)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('isResolvedByUser: true only after resolveConfirm, distinguishes from abort-clearing', () => {
    const pending: PendingConfirms = new Map();
    pending.set('c1', () => {});
    pending.set('c2', () => {});
    const svc = createPermissionService({ pending });

    expect(svc.isResolvedByUser('c1')).toBe(false);
    expect(svc.isResolvedByUser('c2')).toBe(false);

    svc.resolveConfirm('c1', true, false);
    // c2 cleared by abort (simulated: direct delete, bypassing service)
    pending.delete('c2');

    expect(svc.isResolvedByUser('c1')).toBe(true);
    expect(svc.isResolvedByUser('c2')).toBe(false);
  });
});
