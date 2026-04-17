import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPlanReviewRouter } from './plan-review.js';
import type { PlanReviewService } from '../services/plan-review-service.js';

function makeService(overrides: Partial<PlanReviewService> = {}): PlanReviewService {
  return {
    hasPending: vi.fn().mockReturnValue(true),
    resolveReview: vi.fn().mockReturnValue({ ok: true }),
    ...overrides,
  } as PlanReviewService;
}

function makeApp(service: PlanReviewService) {
  const app = express();
  app.use(express.json());
  app.use('/api', createPlanReviewRouter({ service }));
  return app;
}

describe('POST /api/plan-review', () => {
  it('rejects missing callId', async () => {
    const app = makeApp(makeService());
    const res = await request(app).post('/api/plan-review').send({ approved: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/callId/);
  });

  it('rejects missing approved', async () => {
    const app = makeApp(makeService());
    const res = await request(app).post('/api/plan-review').send({ callId: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/approved/);
  });

  it('returns 404 when service returns not_found', async () => {
    const service = makeService({
      resolveReview: vi.fn().mockReturnValue({ ok: false, reason: 'not_found' }),
    });
    const app = makeApp(service);
    const res = await request(app).post('/api/plan-review').send({ callId: 'x', approved: true });
    expect(res.status).toBe(404);
  });

  it('resolves pending via service with editedPlan', async () => {
    const service = makeService();
    const app = makeApp(service);
    const res = await request(app).post('/api/plan-review').send({
      callId: 'c1',
      approved: true,
      editedPlan: '# Plan',
    });

    expect(res.status).toBe(200);
    expect(service.resolveReview).toHaveBeenCalledWith('c1', true, '# Plan');
  });

  it('handles approved=false with undefined editedPlan', async () => {
    const service = makeService();
    const app = makeApp(service);
    await request(app).post('/api/plan-review').send({ callId: 'c2', approved: false });

    expect(service.resolveReview).toHaveBeenCalledWith('c2', false, undefined);
  });
});
