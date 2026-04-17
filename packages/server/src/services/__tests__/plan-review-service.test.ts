import { describe, it, expect, vi } from 'vitest';
import { createPlanReviewService } from '../plan-review-service.js';
import type { PendingPlanReviews } from '../../routes/plan-review.js';

describe('plan-review-service', () => {
  it('hasPending: reflects map membership', () => {
    const pending: PendingPlanReviews = new Map();
    pending.set('p1', () => {});
    const svc = createPlanReviewService({ pending });
    expect(svc.hasPending('p1')).toBe(true);
    expect(svc.hasPending('nope')).toBe(false);
  });

  it('resolveReview: resolves and deletes', () => {
    const pending: PendingPlanReviews = new Map();
    const resolver = vi.fn();
    pending.set('p1', resolver);
    const svc = createPlanReviewService({ pending });
    expect(svc.resolveReview('p1', true)).toEqual({ ok: true });
    expect(resolver).toHaveBeenCalledWith({ approved: true, editedPlan: undefined });
    expect(pending.has('p1')).toBe(false);
  });

  it('resolveReview: passes editedPlan through', () => {
    const pending: PendingPlanReviews = new Map();
    const resolver = vi.fn();
    pending.set('p1', resolver);
    const svc = createPlanReviewService({ pending });
    svc.resolveReview('p1', true, 'edited text');
    expect(resolver).toHaveBeenCalledWith({ approved: true, editedPlan: 'edited text' });
  });

  it('resolveReview: not_found when absent', () => {
    const svc = createPlanReviewService({ pending: new Map() });
    expect(svc.resolveReview('xx', false)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('isResolvedByUser: true only after resolveReview, distinguishes from abort-clearing', () => {
    const pending: PendingPlanReviews = new Map();
    pending.set('p1', () => {});
    pending.set('p2', () => {});
    const svc = createPlanReviewService({ pending });

    expect(svc.isResolvedByUser('p1')).toBe(false);

    svc.resolveReview('p1', true);
    pending.delete('p2');

    expect(svc.isResolvedByUser('p1')).toBe(true);
    expect(svc.isResolvedByUser('p2')).toBe(false);
  });
});
