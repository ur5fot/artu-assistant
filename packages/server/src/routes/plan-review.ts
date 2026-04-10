import { Router } from 'express';
import type { Request, Response } from 'express';
import type { PlanReviewResponse } from '@r2/shared';

export type { PlanReviewResponse };
export type PendingPlanReviews = Map<string, (response: PlanReviewResponse) => void>;

export function createPlanReviewRouter(pendingPlanReviews: PendingPlanReviews): Router {
  const router = Router();

  router.post('/plan-review', (req: Request, res: Response) => {
    const { callId, approved, editedPlan } = req.body;

    if (!callId || typeof callId !== 'string') {
      res.status(400).json({ error: 'callId (string) required' });
      return;
    }
    if (typeof approved !== 'boolean') {
      res.status(400).json({ error: 'approved (boolean) required' });
      return;
    }

    const resolve = pendingPlanReviews.get(callId);
    if (!resolve) {
      res.status(404).json({ error: `Pending plan review "${callId}" not found` });
      return;
    }

    pendingPlanReviews.delete(callId);
    resolve({
      approved,
      editedPlan: typeof editedPlan === 'string' ? editedPlan : undefined,
    });
    res.json({ ok: true });
  });

  return router;
}
