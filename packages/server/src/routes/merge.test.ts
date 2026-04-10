import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockRun = vi.fn();
const mockTryRun = vi.fn();

vi.mock('@r2/tool-code-task', () => ({
  run: (...args: any[]) => mockRun(...args),
  tryRun: (...args: any[]) => mockTryRun(...args),
}));

import { createMergeRouter } from './merge.js';

describe('POST /api/merge', () => {
  let app: express.Express;

  beforeEach(() => {
    mockRun.mockReset();
    mockTryRun.mockReset();
    app = express();
    app.use(express.json());
    app.use('/api', createMergeRouter());
  });

  it('happy path: merges dev into master and pushes', async () => {
    mockRun
      .mockResolvedValueOnce('') // fetch origin
      .mockResolvedValueOnce('') // checkout master
      .mockResolvedValueOnce(''); // pull origin master
    mockTryRun.mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }); // merge
    mockRun.mockResolvedValueOnce(''); // push
    mockTryRun
      .mockResolvedValueOnce({ ok: true, stdout: 'abc1234deadbeef', code: 0 }) // rev-parse HEAD
      .mockResolvedValueOnce({ ok: true, stdout: ' 5 files changed, 30 insertions(+)', code: 0 }); // shortstat

    const res = await request(app).post('/api/merge').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      commit: 'abc1234deadbeef',
      filesChanged: 5,
      message: expect.stringContaining('abc1234'),
    });
  });

  it('returns 409 on merge conflict', async () => {
    mockRun
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    mockTryRun.mockResolvedValueOnce({ ok: false, stdout: '', code: 1 }); // merge fails
    mockTryRun.mockResolvedValueOnce({ ok: false, stdout: 'src/a.ts\nsrc/b.ts', code: 0 }); // diff --name-only --diff-filter=U
    mockTryRun.mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }); // merge --abort

    const res = await request(app).post('/api/merge').send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/conflict/);
    expect(res.body.conflicts).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns 500 when push fails', async () => {
    mockRun
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    mockTryRun.mockResolvedValueOnce({ ok: true, stdout: '', code: 0 });
    mockRun.mockRejectedValueOnce(new Error('push rejected'));

    const res = await request(app).post('/api/merge').send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/push/i);
  });

  it('returns 500 when fetch fails', async () => {
    mockRun.mockRejectedValueOnce(new Error('network'));

    const res = await request(app).post('/api/merge').send({});

    expect(res.status).toBe(500);
  });
});
