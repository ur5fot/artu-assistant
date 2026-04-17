import type { PendingPlanReviews } from '../routes/plan-review.js';

export interface PlanReviewService {
  hasPending(callId: string): boolean;
  resolveReview(
    callId: string,
    approved: boolean,
    editedPlan?: string,
  ): { ok: true } | { ok: false; reason: 'not_found' };
}

interface Deps {
  pending: PendingPlanReviews;
}

export function createPlanReviewService(deps: Deps): PlanReviewService {
  const { pending } = deps;
  return {
    hasPending(callId) {
      return pending.has(callId);
    },
    resolveReview(callId, approved, editedPlan) {
      const resolve = pending.get(callId);
      if (!resolve) return { ok: false, reason: 'not_found' };
      pending.delete(callId);
      resolve({ approved, editedPlan });
      return { ok: true };
    },
  };
}
