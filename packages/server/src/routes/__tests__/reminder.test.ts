import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createReminderRouter } from '../reminder.js';
import type { ReminderService } from '../../services/reminder-service.js';

function makeService(overrides: Partial<ReminderService> = {}): ReminderService {
  return {
    dismiss: vi.fn().mockReturnValue({ ok: true }),
    snooze: vi.fn().mockReturnValue({ ok: true, snoozedId: 42 }),
    list: vi.fn().mockReturnValue([]),
    ...overrides,
  } as ReminderService;
}

function makeApp(service: ReminderService) {
  const app = express();
  app.use(express.json());
  app.use('/', createReminderRouter({ service }));
  return app;
}

describe('reminder router', () => {
  it('POST /dismiss — 400 on invalid id', async () => {
    const app = makeApp(makeService());
    const res = await request(app).post('/dismiss').send({ id: 'x' });
    expect(res.status).toBe(400);
  });

  it('POST /dismiss — 404 when service returns not_found', async () => {
    const service = makeService({ dismiss: vi.fn().mockReturnValue({ ok: false, reason: 'not_found' }) });
    const app = makeApp(service);
    const res = await request(app).post('/dismiss').send({ id: 5 });
    expect(res.status).toBe(404);
  });

  it('POST /dismiss — 200 on success', async () => {
    const service = makeService();
    const app = makeApp(service);
    const res = await request(app).post('/dismiss').send({ id: 5 });
    expect(res.status).toBe(200);
    expect(service.dismiss).toHaveBeenCalledWith(5);
  });

  it('POST /snooze — 200 with snoozedId', async () => {
    const service = makeService({ snooze: vi.fn().mockReturnValue({ ok: true, snoozedId: 77 }) });
    const app = makeApp(service);
    const res = await request(app).post('/snooze').send({ id: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, snoozedId: 77 });
  });
});
