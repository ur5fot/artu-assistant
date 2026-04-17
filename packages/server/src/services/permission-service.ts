import type { PendingConfirms } from '../routes/confirm.js';

export interface PermissionService {
  hasPending(callId: string): boolean;
  resolveConfirm(
    callId: string,
    allowed: boolean,
    remember: boolean,
  ): { ok: true } | { ok: false; reason: 'not_found' };
}

interface Deps {
  pending: PendingConfirms;
}

export function createPermissionService(deps: Deps): PermissionService {
  const { pending } = deps;
  return {
    hasPending(callId) {
      return pending.has(callId);
    },
    resolveConfirm(callId, allowed, remember) {
      const resolve = pending.get(callId);
      if (!resolve) return { ok: false, reason: 'not_found' };
      pending.delete(callId);
      resolve({ allowed, remember });
      return { ok: true };
    },
  };
}
