import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runSingleEval, runAllEvals, type EvalResult } from './runner.js';
import type { Eval } from './store.js';

const mockEvaluate = vi.fn();
vi.mock('./evaluator.js', () => ({
  evaluate: (...args: any[]) => mockEvaluate(...args),
}));

describe('runSingleEval', () => {
  beforeEach(() => {
    mockEvaluate.mockReset();
  });

  it('captures text_delta events as actualText', async () => {
    mockEvaluate.mockResolvedValueOnce({ passed: true, reason: 'ok' });

    const fakeRunLoop = vi.fn(async ({ onEvent }) => {
      onEvent({ type: 'text_delta', content: 'Hello ' });
      onEvent({ type: 'text_delta', content: 'world' });
      onEvent({ type: 'done' });
    });

    const e: Eval = { id: 'e1', input: 'hi', expected: 'greeting', toolUseExpected: null, createdAt: '2026-04-11T00:00:00Z' };
    const result = await runSingleEval(e, fakeRunLoop as any);

    expect(result.actualText).toBe('Hello world');
    expect(result.passed).toBe(true);
    expect(mockEvaluate).toHaveBeenCalledWith(expect.objectContaining({
      actualText: 'Hello world',
    }));
  });

  it('captures tool_call_start names as actualToolCalls', async () => {
    mockEvaluate.mockResolvedValueOnce({ passed: true, reason: 'ok' });

    const fakeRunLoop = vi.fn(async ({ onEvent }) => {
      onEvent({ type: 'tool_call_start', toolCall: { id: 't1', name: 'web_search', input: {}, status: 'running' } });
      onEvent({ type: 'tool_call_start', toolCall: { id: 't2', name: 'file_read', input: {}, status: 'running' } });
      onEvent({ type: 'done' });
    });

    const e: Eval = { id: 'e2', input: 'search', expected: 'find', toolUseExpected: null, createdAt: '2026-04-11T00:00:00Z' };
    const result = await runSingleEval(e, fakeRunLoop as any);

    expect(result.actualToolCalls).toEqual(['web_search', 'file_read']);
  });

  it('returns fail result when runLoop throws', async () => {
    const fakeRunLoop = vi.fn(async () => {
      throw new Error('loop crashed');
    });

    const e: Eval = { id: 'e3', input: 'hi', expected: 'greeting', toolUseExpected: null, createdAt: '2026-04-11T00:00:00Z' };
    const result = await runSingleEval(e, fakeRunLoop as any);

    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/run error/);
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it('forwards toolUseExpected to evaluator', async () => {
    mockEvaluate.mockResolvedValueOnce({ passed: true, reason: 'ok' });
    const fakeRunLoop = vi.fn(async ({ onEvent }) => {
      onEvent({ type: 'done' });
    });

    const e: Eval = { id: 'e4', input: 'q', expected: 'exp', toolUseExpected: ['web_search'], createdAt: '2026-04-11T00:00:00Z' };
    await runSingleEval(e, fakeRunLoop as any);

    expect(mockEvaluate).toHaveBeenCalledWith(expect.objectContaining({
      toolUseExpected: ['web_search'],
    }));
  });
});

describe('runAllEvals', () => {
  let tmpDir: string;

  beforeEach(() => {
    mockEvaluate.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-runner-'));
    process.env.EVALS_PATH = path.join(tmpDir, 'evals.json');
  });

  afterEach(() => {
    delete process.env.EVALS_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns zeros when evals file is empty', async () => {
    fs.writeFileSync(process.env.EVALS_PATH!, '[]');
    const fakeRunLoop = vi.fn();

    const result = await runAllEvals(fakeRunLoop as any, { concurrency: 3 });

    expect(result).toEqual({ passed: 0, failed: 0, results: [] });
    expect(fakeRunLoop).not.toHaveBeenCalled();
  });

  it('runs all evals and counts passes/fails', async () => {
    fs.writeFileSync(process.env.EVALS_PATH!, JSON.stringify([
      { id: 'a', input: 'q1', expected: 'e1', toolUseExpected: null, createdAt: '2026-04-11T00:00:00Z' },
      { id: 'b', input: 'q2', expected: 'e2', toolUseExpected: null, createdAt: '2026-04-11T00:00:01Z' },
      { id: 'c', input: 'q3', expected: 'e3', toolUseExpected: null, createdAt: '2026-04-11T00:00:02Z' },
    ]));

    mockEvaluate
      .mockResolvedValueOnce({ passed: true, reason: 'ok' })
      .mockResolvedValueOnce({ passed: false, reason: 'wrong' })
      .mockResolvedValueOnce({ passed: true, reason: 'ok' });

    const fakeRunLoop = vi.fn(async ({ onEvent }) => {
      onEvent({ type: 'text_delta', content: 'response' });
      onEvent({ type: 'done' });
    });

    const result = await runAllEvals(fakeRunLoop as any, { concurrency: 3 });

    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results).toHaveLength(3);
  });

  it('invokes onProgress for each eval', async () => {
    fs.writeFileSync(process.env.EVALS_PATH!, JSON.stringify([
      { id: 'x', input: 'q', expected: 'e', toolUseExpected: null, createdAt: '2026-04-11T00:00:00Z' },
      { id: 'y', input: 'q', expected: 'e', toolUseExpected: null, createdAt: '2026-04-11T00:00:01Z' },
    ]));

    mockEvaluate.mockResolvedValue({ passed: true, reason: 'ok' });

    const fakeRunLoop = vi.fn(async ({ onEvent }) => { onEvent({ type: 'done' }); });
    const progress: string[] = [];

    await runAllEvals(fakeRunLoop as any, { concurrency: 2, onProgress: (m) => progress.push(m) });

    expect(progress.some((p) => p.includes('1/2'))).toBe(true);
    expect(progress.some((p) => p.includes('2/2'))).toBe(true);
  });

  it('respects concurrency limit', async () => {
    fs.writeFileSync(process.env.EVALS_PATH!, JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({
        id: `e${i}`,
        input: 'q',
        expected: 'e',
        toolUseExpected: null,
        createdAt: '2026-04-11T00:00:00Z',
      })),
    ));

    mockEvaluate.mockResolvedValue({ passed: true, reason: 'ok' });

    let active = 0;
    let peak = 0;
    const fakeRunLoop = vi.fn(async ({ onEvent }) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      onEvent({ type: 'done' });
    });

    await runAllEvals(fakeRunLoop as any, { concurrency: 2 });

    expect(peak).toBeLessThanOrEqual(2);
  });
});
