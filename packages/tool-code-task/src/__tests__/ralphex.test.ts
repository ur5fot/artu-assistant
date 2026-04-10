import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: any[]) => mockSpawn(...args) }));

import { buildPlanContent, runRalphex } from '../ralphex.js';

function makeChild(exitCode: number, stdoutData: string[] = []) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setTimeout(() => {
    for (const data of stdoutData) {
      child.stdout.emit('data', Buffer.from(data + '\n'));
    }
    child.emit('exit', exitCode);
  }, 5);
  return child;
}

describe('buildPlanContent', () => {
  it('includes task and context', () => {
    const plan = buildPlanContent('add dark mode', 'use tailwind');
    expect(plan).toContain('add dark mode');
    expect(plan).toContain('use tailwind');
    expect(plan).toContain('- [ ]');
  });

  it('handles missing context', () => {
    const plan = buildPlanContent('simple task');
    expect(plan).toContain('simple task');
    expect(plan).toContain('none');
  });
});

describe('runRalphex', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('calls requestPlanReview with draft plan', async () => {
    mockSpawn.mockReturnValue(makeChild(0));
    const mockReview = vi.fn().mockResolvedValue({ approved: false });

    await expect(runRalphex({
      workdir: os.tmpdir(),
      task: 'test task',
      onProgress: () => {},
      requestPlanReview: mockReview,
    })).rejects.toThrow(/rejected/i);

    expect(mockReview).toHaveBeenCalledWith(expect.stringContaining('test task'));
  });

  it('spawns ralphex with argv form', async () => {
    mockSpawn.mockReturnValue(makeChild(0));

    await runRalphex({
      workdir: os.tmpdir(),
      task: 'test',
      onProgress: () => {},
      requestPlanReview: async () => ({ approved: true }),
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'ralphex',
      expect.arrayContaining(['--max-iterations']),
      expect.objectContaining({ shell: false }),
    );
  });

  it('uses editedPlan when provided', async () => {
    const customPlan = '# Custom\n\n- [ ] Do thing';
    let capturedContent = '';

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const planPath = args[args.length - 1];
      capturedContent = fs.readFileSync(planPath, 'utf8');
      return makeChild(0);
    });

    await runRalphex({
      workdir: os.tmpdir(),
      task: 'test',
      onProgress: () => {},
      requestPlanReview: async () => ({ approved: true, editedPlan: customPlan }),
    });

    expect(capturedContent).toBe(customPlan);
  });

  it('streams stdout via onProgress', async () => {
    mockSpawn.mockReturnValue(makeChild(0, ['line 1', 'line 2']));
    const progress: string[] = [];

    await runRalphex({
      workdir: os.tmpdir(),
      task: 'test',
      onProgress: (m) => progress.push(m),
      requestPlanReview: async () => ({ approved: true }),
    });

    expect(progress).toContain('line 1');
    expect(progress).toContain('line 2');
  });

  it('does not spawn if signal is already aborted before start', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(runRalphex({
      workdir: os.tmpdir(),
      task: 'test',
      onProgress: () => {},
      requestPlanReview: async () => ({ approved: true }),
      signal: controller.signal,
    })).rejects.toThrow(/abort/i);

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('sends SIGTERM on abort and escalates to SIGKILL if child ignores it', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    mockSpawn.mockReturnValue(child);

    const controller = new AbortController();

    const runPromise = runRalphex({
      workdir: os.tmpdir(),
      task: 'test',
      onProgress: () => {},
      requestPlanReview: async () => ({ approved: true }),
      signal: controller.signal,
    });

    // Let plan review resolve and spawn happen.
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // Child ignores SIGTERM for longer than the escalation window.
    await vi.advanceTimersByTimeAsync(6000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    // Finally the child exits; promise should reject with the exit error.
    child.emit('exit', 137);
    await expect(runPromise).rejects.toThrow();

    vi.useRealTimers();
  });

  it('throws on non-zero exit', async () => {
    mockSpawn.mockReturnValue(makeChild(1));

    await expect(runRalphex({
      workdir: os.tmpdir(),
      task: 'test',
      onProgress: () => {},
      requestPlanReview: async () => ({ approved: true }),
    })).rejects.toThrow(/exit.*1/);
  });
});
