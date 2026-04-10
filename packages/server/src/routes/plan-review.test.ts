import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPlanReviewRouter, type PendingPlanReviews } from './plan-review.js';

describe('POST /api/plan-review', () => {
  let app: express.Express;
  let pending: PendingPlanReviews;

  beforeEach(() => {
    pending = new Map();
    app = express();
    app.use(express.json());
    app.use('/api', createPlanReviewRouter(pending));
  });

  it('rejects missing callId', async () => {
    const res = await request(app).post('/api/plan-review').send({ approved: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/callId/);
  });

  it('rejects missing approved', async () => {
    const res = await request(app).post('/api/plan-review').send({ callId: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/approved/);
  });

  it('returns 404 for unknown callId', async () => {
    const res = await request(app).post('/api/plan-review').send({ callId: 'x', approved: true });
    expect(res.status).toBe(404);
  });

  it('resolves pending and removes from map', async () => {
    let received: any = null;
    pending.set('c1', (r) => { received = r; });

    const res = await request(app).post('/api/plan-review').send({
      callId: 'c1',
      approved: true,
      editedPlan: '# Plan',
    });

    expect(res.status).toBe(200);
    expect(received).toEqual({ approved: true, editedPlan: '# Plan' });
    expect(pending.has('c1')).toBe(false);
  });

  it('handles approved=false', async () => {
    let received: any = null;
    pending.set('c2', (r) => { received = r; });

    await request(app).post('/api/plan-review').send({ callId: 'c2', approved: false });

    expect(received).toEqual({ approved: false, editedPlan: undefined });
  });
});
