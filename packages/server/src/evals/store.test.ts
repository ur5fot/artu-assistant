import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadEvals, saveEval, type Eval } from './store.js';
import { resolveProjectPath, getProjectRoot } from '../path-utils.js';

describe('eval store', () => {
  let tmpDir: string;
  let evalsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-evals-'));
    evalsPath = path.join(tmpDir, 'evals.json');
    process.env.EVALS_PATH = evalsPath;
  });

  afterEach(() => {
    delete process.env.EVALS_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when file does not exist', async () => {
    const evals = await loadEvals();
    expect(evals).toEqual([]);
  });

  it('returns empty array when file has empty JSON array', async () => {
    fs.writeFileSync(evalsPath, '[]');
    const evals = await loadEvals();
    expect(evals).toEqual([]);
  });

  it('throws on malformed JSON', async () => {
    fs.writeFileSync(evalsPath, 'not json');
    await expect(loadEvals()).rejects.toThrow(/Failed to parse/);
  });

  it('saves and loads a single eval', async () => {
    const e: Eval = {
      id: 'eval-1',
      input: 'hello',
      expected: 'reply with world',
      toolUseExpected: null,
      createdAt: '2026-04-11T00:00:00.000Z',
    };
    await saveEval(e);
    const list = await loadEvals();
    expect(list).toEqual([e]);
  });

  it('appends a second eval without losing the first', async () => {
    await saveEval({
      id: 'a',
      input: 'q1',
      expected: 'e1',
      toolUseExpected: null,
      createdAt: '2026-04-11T00:00:00.000Z',
    });
    await saveEval({
      id: 'b',
      input: 'q2',
      expected: 'e2',
      toolUseExpected: ['web_search'],
      createdAt: '2026-04-11T00:00:01.000Z',
    });

    const list = await loadEvals();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('a');
    expect(list[1].id).toBe('b');
    expect(list[1].toolUseExpected).toEqual(['web_search']);
  });

  it('creates parent directory if missing', async () => {
    evalsPath = path.join(tmpDir, 'sub', 'evals.json');
    process.env.EVALS_PATH = evalsPath;

    await saveEval({
      id: 'x',
      input: 'q',
      expected: 'e',
      toolUseExpected: null,
      createdAt: '2026-04-11T00:00:00.000Z',
    });

    expect(fs.existsSync(evalsPath)).toBe(true);
  });

  it('atomic write: uses tmp + rename', async () => {
    await saveEval({
      id: 'atomic',
      input: 'q',
      expected: 'e',
      toolUseExpected: null,
      createdAt: '2026-04-11T00:00:00.000Z',
    });
    expect(fs.existsSync(`${evalsPath}.tmp`)).toBe(false);
    expect(fs.existsSync(evalsPath)).toBe(true);
  });
});

describe('eval store path resolution', () => {
  afterEach(() => {
    delete process.env.EVALS_PATH;
  });

  it('relative EVALS_PATH resolves identically regardless of injected projectRoot', () => {
    const a = resolveProjectPath('./data/evals.json', ['data', 'evals.json'], {
      projectRoot: '/proj',
    });
    const b = resolveProjectPath('./data/evals.json', ['data', 'evals.json'], {
      projectRoot: '/proj',
    });
    expect(a).toBe(b);
    expect(a).toBe(path.resolve('/proj', 'data', 'evals.json'));
  });

  it('relative EVALS_PATH is anchored at projectRoot (cwd-independent)', () => {
    const fromRoot = resolveProjectPath('./data/evals.json', ['data', 'evals.json'], {
      projectRoot: '/proj-a',
    });
    const fromSub = resolveProjectPath('./data/evals.json', ['data', 'evals.json'], {
      projectRoot: '/proj-b/packages/server',
    });
    expect(fromRoot).toBe('/proj-a/data/evals.json');
    expect(fromSub).toBe('/proj-b/packages/server/data/evals.json');
  });

  it('absolute EVALS_PATH passes through unchanged', () => {
    const abs = path.resolve(os.tmpdir(), 'abs-evals.json');
    const result = resolveProjectPath(abs, ['data', 'evals.json'], {
      projectRoot: '/proj',
    });
    expect(result).toBe(abs);
  });

  it('unset EVALS_PATH falls back to repo-root data/evals.json', () => {
    const result = resolveProjectPath(undefined, ['data', 'evals.json']);
    expect(result).toBe(path.resolve(getProjectRoot(), 'data', 'evals.json'));
  });

  it('empty EVALS_PATH falls back to repo-root data/evals.json', () => {
    const result = resolveProjectPath('', ['data', 'evals.json']);
    expect(result).toBe(path.resolve(getProjectRoot(), 'data', 'evals.json'));
  });
});
