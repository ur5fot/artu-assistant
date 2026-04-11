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
    mockTryRun.mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }); // status --porcelain (clean)
    mockRun
      .mockResolvedValueOnce('') // fetch origin
      .mockResolvedValueOnce('') // checkout master
      .mockResolvedValueOnce(''); // pull origin master
    mockTryRun
      .mockResolvedValueOnce({ ok: true, stdout: 'old1234', code: 0 }) // rev-parse HEAD (before)
      .mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }) // merge
      .mockResolvedValueOnce({ ok: true, stdout: 'abc1234deadbeef', code: 0 }); // rev-parse HEAD (after)
    mockRun.mockResolvedValueOnce(''); // push
    mockTryRun.mockResolvedValueOnce({
      ok: true,
      stdout: ' 5 files changed, 30 insertions(+)',
      code: 0,
    }); // shortstat

    const res = await request(app).post('/api/merge').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      commit: 'abc1234deadbeef',
      filesChanged: 5,
      message: expect.stringContaining('abc1234'),
    });
  });

  it('returns 409 on dirty working tree', async () => {
    mockTryRun.mockResolvedValueOnce({ ok: true, stdout: ' M src/foo.ts', code: 0 });

    const res = await request(app).post('/api/merge').send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/working tree/i);
  });

  it('returns 409 on merge conflict', async () => {
    mockTryRun.mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }); // status clean
    mockRun
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    mockTryRun
      .mockResolvedValueOnce({ ok: true, stdout: 'old1234', code: 0 }) // rev-parse HEAD before
      .mockResolvedValueOnce({ ok: false, stdout: '', code: 1 }) // merge fails
      .mockResolvedValueOnce({ ok: false, stdout: 'src/a.ts\nsrc/b.ts', code: 0 }) // diff --name-only
      .mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }); // merge --abort

    const res = await request(app).post('/api/merge').send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/conflict/);
    expect(res.body.conflicts).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns 500 when push fails and rolls back merge commit to captured SHA', async () => {
    mockTryRun.mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }); // status clean
    mockRun
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    mockTryRun
      .mockResolvedValueOnce({ ok: true, stdout: 'old1234', code: 0 }) // rev-parse HEAD before
      .mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }) // merge
      .mockResolvedValueOnce({ ok: true, stdout: 'new5678', code: 0 }); // rev-parse HEAD after
    mockRun.mockRejectedValueOnce(new Error('push rejected'));
    mockTryRun
      .mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }) // pre-rollback status (still clean)
      .mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }); // reset --hard <headBefore>

    const res = await request(app).post('/api/merge').send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/push/i);
    expect(mockTryRun).toHaveBeenCalledWith('git', ['reset', '--hard', 'old1234'], expect.any(String));
  });

  it('skips destructive rollback when worktree became dirty mid-request', async () => {
    mockTryRun.mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }); // initial status clean
    mockRun
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    mockTryRun
      .mockResolvedValueOnce({ ok: true, stdout: 'old1234', code: 0 }) // before
      .mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }) // merge
      .mockResolvedValueOnce({ ok: true, stdout: 'new5678', code: 0 }); // after
    mockRun.mockRejectedValueOnce(new Error('push rejected'));
    mockTryRun.mockResolvedValueOnce({ ok: true, stdout: ' M src/user-edit.ts', code: 0 }); // dirty now

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post('/api/merge').send({});
    errorSpy.mockRestore();

    expect(res.status).toBe(500);
    expect(mockTryRun).not.toHaveBeenCalledWith('git', ['reset', '--hard', 'old1234'], expect.any(String));
  });

  it('returns 500 when fetch fails', async () => {
    mockTryRun.mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }); // status clean
    mockRun.mockRejectedValueOnce(new Error('network'));

    const res = await request(app).post('/api/merge').send({});

    expect(res.status).toBe(500);
  });

  it('reports up-to-date when merge produces no new commit', async () => {
    mockTryRun.mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }); // status clean
    mockRun
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    mockTryRun
      .mockResolvedValueOnce({ ok: true, stdout: 'same1234', code: 0 }) // before
      .mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }) // merge (already up to date)
      .mockResolvedValueOnce({ ok: true, stdout: 'same1234', code: 0 }); // after (unchanged)
    // no push expected when no merge commit was created

    const res = await request(app).post('/api/merge').send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.filesChanged).toBe(0);
    expect(res.body.message).toMatch(/up to date/i);
  });
});
