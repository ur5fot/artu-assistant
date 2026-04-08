import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveRoot, safePath } from '../src/paths.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('resolveRoot', () => {
  const originalEnv = process.env.R2_FILES_ROOT;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.R2_FILES_ROOT = originalEnv;
    } else {
      delete process.env.R2_FILES_ROOT;
    }
  });

  it('returns R2_FILES_ROOT when set', () => {
    process.env.R2_FILES_ROOT = '/tmp/r2-custom';
    expect(resolveRoot()).toBe('/tmp/r2-custom');
  });

  it('defaults to ~/Documents/r2', () => {
    delete process.env.R2_FILES_ROOT;
    expect(resolveRoot()).toBe(path.join(os.homedir(), 'Documents', 'r2'));
  });

  it('expands bare ~ to home directory', () => {
    process.env.R2_FILES_ROOT = '~';
    expect(resolveRoot()).toBe(os.homedir());
  });

  it('expands ~/path to home directory', () => {
    process.env.R2_FILES_ROOT = '~/my-files';
    expect(resolveRoot()).toBe(path.join(os.homedir(), 'my-files'));
  });
});

describe('safePath', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-paths-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('resolves relative paths within root', () => {
    const result = safePath(tmpRoot, 'subdir/file.txt');
    expect(result).toBe(path.join(tmpRoot, 'subdir', 'file.txt'));
  });

  it('resolves "." to root itself', () => {
    const result = safePath(tmpRoot, '.');
    expect(result).toBe(tmpRoot);
  });

  it('rejects paths that traverse outside root', () => {
    expect(() => safePath(tmpRoot, '../../../etc/passwd')).toThrow('Path outside allowed directory');
  });

  it('rejects absolute paths outside root', () => {
    expect(() => safePath(tmpRoot, '/etc/passwd')).toThrow('Path outside allowed directory');
  });

  it('allows absolute paths inside root', () => {
    const fullPath = path.join(tmpRoot, 'inside.txt');
    const result = safePath(tmpRoot, fullPath);
    expect(result).toBe(fullPath);
  });
});
