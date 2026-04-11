import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { evalAddTool } from '../index.js';

describe('evalAddTool', () => {
  let tmpDir: string;
  let evalsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-eval-add-'));
    evalsPath = path.join(tmpDir, 'evals.json');
    process.env.EVALS_PATH = evalsPath;
  });

  afterEach(() => {
    delete process.env.EVALS_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates file with first eval', async () => {
    const result = await evalAddTool.handler({
      input: 'what is 2+2',
      expected: 'reply 4',
    });

    expect(result.success).toBe(true);
    const list = JSON.parse(fs.readFileSync(evalsPath, 'utf8'));
    expect(list).toHaveLength(1);
    expect(list[0].input).toBe('what is 2+2');
    expect(list[0].expected).toBe('reply 4');
    expect(list[0].toolUseExpected).toBeNull();
    expect(list[0].id).toBeTruthy();
    expect(list[0].createdAt).toBeTruthy();
  });

  it('appends to existing file', async () => {
    fs.writeFileSync(evalsPath, JSON.stringify([
      { id: 'old', input: 'q', expected: 'e', toolUseExpected: null, createdAt: '2026-04-11T00:00:00Z' },
    ]));

    await evalAddTool.handler({
      input: 'new q',
      expected: 'new e',
    });

    const list = JSON.parse(fs.readFileSync(evalsPath, 'utf8'));
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('old');
  });

  it('stores toolUseExpected array', async () => {
    await evalAddTool.handler({
      input: 'search',
      expected: 'find weather',
      toolUseExpected: ['web_search'],
    });

    const list = JSON.parse(fs.readFileSync(evalsPath, 'utf8'));
    expect(list[0].toolUseExpected).toEqual(['web_search']);
  });

  it('rejects empty input', async () => {
    const result = await evalAddTool.handler({
      input: '',
      expected: 'something',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/required/);
  });

  it('rejects empty expected', async () => {
    const result = await evalAddTool.handler({
      input: 'q',
      expected: '',
    });
    expect(result.success).toBe(false);
  });

  it('has confirm permission level', () => {
    expect(evalAddTool.permissionLevel).toBe('confirm');
  });

  it('atomic write leaves no tmp file', async () => {
    await evalAddTool.handler({ input: 'q', expected: 'e' });
    expect(fs.existsSync(`${evalsPath}.tmp`)).toBe(false);
  });
});
