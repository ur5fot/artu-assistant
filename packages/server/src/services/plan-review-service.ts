import type { PendingPlanReviews } from '../routes/plan-review.js';

export interface PlanReviewService {
  hasPending(callId: string): boolean;
  /**
   * True only when `resolveReview` was called (i.e. user clicked a button).
   * Distinguishes user-resolved entries from entries cleared by request
   * abort/timeout, both of which drop the callId from `pending`.
   */
  isResolvedByUser(callId: string): boolean;
  resolveReview(
    callId: string,
    approved: boolean,
    editedPlan?: string,
  ): { ok: true } | { ok: false; reason: 'not_found' };
}

interface Deps {
  pending: PendingPlanReviews;
}

const RESOLVED_BY_USER_MAX = 1024;

export function createPlanReviewService(deps: Deps): PlanReviewService {
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
    resolveReview(callId, approved, editedPlan) {
      const resolve = pending.get(callId);
      if (!resolve) return { ok: false, reason: 'not_found' };
      pending.delete(callId);
      resolvedByUser.add(callId);
      order.push(callId);
      while (order.length > RESOLVED_BY_USER_MAX) {
        const evict = order.shift()!;
        resolvedByUser.delete(evict);
      }
      resolve({ approved, editedPlan });
      return { ok: true };
    },
  };
}
