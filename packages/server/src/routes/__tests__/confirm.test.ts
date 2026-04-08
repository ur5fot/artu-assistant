import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createConfirmRouter, type PendingConfirms } from '../confirm.js';

describe('POST /api/confirm', () => {
  it('returns 400 when callId missing', async () => {
    const app = express();
    app.use(express.json());
    const pending: PendingConfirms = new Map();
    app.use('/api', createConfirmRouter(pending));

    const res = await request(app)
      .post('/api/confirm')
      .send({ allowed: true })
      .expect(400);

    expect(res.body.error).toContain('callId');
  });

  it('returns 404 when callId not found', async () => {
    const app = express();
    app.use(express.json());
    const pending: PendingConfirms = new Map();
    app.use('/api', createConfirmRouter(pending));

    const res = await request(app)
      .post('/api/confirm')
      .send({ callId: 'nonexistent', allowed: true })
      .expect(404);

    expect(res.body.error).toContain('not found');
  });

  it('resolves pending confirm and returns ok', async () => {
    const app = express();
    app.use(express.json());
    const pending: PendingConfirms = new Map();
    const resolve = vi.fn();
    pending.set('call_1', resolve);
    app.use('/api', createConfirmRouter(pending));

    const res = await request(app)
      .post('/api/confirm')
      .send({ callId: 'call_1', allowed: true, remember: false })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(resolve).toHaveBeenCalledWith({ allowed: true, remember: false });
    expect(pending.has('call_1')).toBe(false);
  });
});
