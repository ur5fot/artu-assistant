import type { PendingMemoryConfirms } from '../routes/memory-confirm.js';

export interface MemoryConfirmService {
  hasPending(callId: string): boolean;
  /**
   * True only when `resolve` was called (i.e. user clicked a button). Lets
   * callers distinguish user resolutions from entries dropped by abort.
   */
  isResolvedByUser(callId: string): boolean;
  resolve(
    callId: string,
    approved: boolean,
    editedParams?: Record<string, unknown>,
  ): { ok: true } | { ok: false; reason: 'not_found' };
}

interface Deps {
  pending: PendingMemoryConfirms;
}

const RESOLVED_BY_USER_MAX = 1024;

export function createMemoryConfirmService(deps: Deps): MemoryConfirmService {
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
    resolve(callId, approved, editedParams) {
      const resolve = pending.get(callId);
      if (!resolve) return { ok: false, reason: 'not_found' };
      pending.delete(callId);
      resolvedByUser.add(callId);
      order.push(callId);
      while (order.length > RESOLVED_BY_USER_MAX) {
        const evict = order.shift()!;
        resolvedByUser.delete(evict);
      }
      resolve({ approved, editedParams });
      return { ok: true };
    },
  };
}
