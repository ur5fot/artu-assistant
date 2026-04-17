import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createConfirmRouter } from '../confirm.js';
import type { PermissionService } from '../../services/permission-service.js';

function makeService(overrides: Partial<PermissionService> = {}): PermissionService {
  return {
    hasPending: vi.fn().mockReturnValue(true),
    resolveConfirm: vi.fn().mockReturnValue({ ok: true }),
    ...overrides,
  } as PermissionService;
}

function makeApp(service: PermissionService) {
  const app = express();
  app.use(express.json());
  app.use('/api', createConfirmRouter({ service }));
  return app;
}

describe('POST /api/confirm', () => {
  it('returns 400 when callId missing', async () => {
    const service = makeService();
    const app = makeApp(service);

    const res = await request(app)
      .post('/api/confirm')
      .send({ allowed: true })
      .expect(400);

    expect(res.body.error).toContain('callId');
    expect(service.resolveConfirm).not.toHaveBeenCalled();
  });

  it('returns 400 when allowed missing', async () => {
    const service = makeService();
    const app = makeApp(service);

    const res = await request(app)
      .post('/api/confirm')
      .send({ callId: 'call_1' })
      .expect(400);

    expect(res.body.error).toContain('allowed');
    expect(service.resolveConfirm).not.toHaveBeenCalled();
  });

  it('POST /confirm — 404 when service returns not_found', async () => {
    const service = makeService({
      resolveConfirm: vi.fn().mockReturnValue({ ok: false, reason: 'not_found' }),
    });
    const app = makeApp(service);
    const res = await request(app)
      .post('/api/confirm')
      .send({ callId: 'xx', allowed: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });

  it('defaults remember to false when omitted', async () => {
    const service = makeService();
    const app = makeApp(service);

    await request(app)
      .post('/api/confirm')
      .send({ callId: 'call_1', allowed: true })
      .expect(200);

    expect(service.resolveConfirm).toHaveBeenCalledWith('call_1', true, false);
  });

  it('resolves pending confirm and returns ok', async () => {
    const service = makeService();
    const app = makeApp(service);

    const res = await request(app)
      .post('/api/confirm')
      .send({ callId: 'call_1', allowed: true, remember: false })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(service.resolveConfirm).toHaveBeenCalledWith('call_1', true, false);
  });

  it('passes remember=true through to service', async () => {
    const service = makeService();
    const app = makeApp(service);

    await request(app)
      .post('/api/confirm')
      .send({ callId: 'call_1', allowed: false, remember: true })
      .expect(200);

    expect(service.resolveConfirm).toHaveBeenCalledWith('call_1', false, true);
  });
});
