import type { PendingConfirms } from '../routes/confirm.js';

export interface PermissionService {
  hasPending(callId: string): boolean;
  /**
   * True only when `resolveConfirm` was called (i.e. user clicked a button).
   * Distinguishes user-resolved entries from entries cleared by request
   * abort/timeout, both of which drop the callId from `pending`.
   */
  isResolvedByUser(callId: string): boolean;
  resolveConfirm(
    callId: string,
    allowed: boolean,
    remember: boolean,
  ): { ok: true } | { ok: false; reason: 'not_found' };
}

interface Deps {
  pending: PendingConfirms;
}

// Bounded to avoid unbounded growth in long-lived processes. Each entry is a
// short callId string, so 1024 is plenty of headroom for concurrent sessions.
const RESOLVED_BY_USER_MAX = 1024;

export function createPermissionService(deps: Deps): PermissionService {
  const { pending } = deps;
  const resolvedByUser = new Set<string>();
  const order: string[] = [];
  return {
    hasPending(callId) {
      return pending.has(callId);
    },
    isResolvedByUser(callId) {
      return resolvedByUser.has(callId);
    },
    resolveConfirm(callId, allowed, remember) {
      const resolve = pending.get(callId);
      if (!resolve) return { ok: false, reason: 'not_found' };
      pending.delete(callId);
      resolvedByUser.add(callId);
      order.push(callId);
      while (order.length > RESOLVED_BY_USER_MAX) {
        const evict = order.shift()!;
        resolvedByUser.delete(evict);
      }
      resolve({ allowed, remember });
      return { ok: true };
    },
  };
}
