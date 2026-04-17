import { Router, type Request, type Response } from 'express';
import type { PlanReviewResponse } from '@r2/shared';
import type { PlanReviewService } from '../services/plan-review-service.js';

export type { PlanReviewResponse };
export type PendingPlanReviews = Map<string, (response: PlanReviewResponse) => void>;

interface Deps {
  service: PlanReviewService;
}

export function createPlanReviewRouter(deps: Deps): Router {
  const router = Router();
  const { service } = deps;

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

    const result = service.resolveReview(
      callId,
      approved,
      typeof editedPlan === 'string' ? editedPlan : undefined,
    );
    if (!result.ok) {
      res.status(404).json({ error: `Pending plan review "${callId}" not found` });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
