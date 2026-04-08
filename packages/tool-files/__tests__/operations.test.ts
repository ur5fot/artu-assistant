import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile, listFiles, deleteFile, moveFile } from '../src/operations.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('File Operations', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-ops-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('readFile', () => {
    it('reads text file content', async () => {
      fs.writeFileSync(path.join(root, 'hello.txt'), 'Hello World');
      const result = await readFile(root, 'hello.txt');
      expect(result.success).toBe(true);
      expect(result.data).toBe('Hello World');
    });

    it('returns error for non-existent file', async () => {
      const result = await readFile(root, 'missing.txt');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('returns error for file > 1MB', async () => {
      const largeBuf = Buffer.alloc(1024 * 1024 + 1, 'a');
      fs.writeFileSync(path.join(root, 'large.txt'), largeBuf);
      const result = await readFile(root, 'large.txt');
      expect(result.success).toBe(false);
      expect(result.error).toContain('1MB');
    });

    it('returns error for binary file', async () => {
      const buf = Buffer.alloc(512);
      buf[0] = 0x00; // null byte
      fs.writeFileSync(path.join(root, 'binary.bin'), buf);
      const result = await readFile(root, 'binary.bin');
      expect(result.success).toBe(false);
      expect(result.error).toContain('binary');
    });

    it('rejects paths outside root', async () => {
      const result = await readFile(root, '../../../etc/passwd');
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside');
    });
  });

  describe('writeFile', () => {
    it('creates new file with content', async () => {
      const result = await writeFile(root, 'new.txt', 'content');
      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(root, 'new.txt'), 'utf-8')).toBe('content');
    });

    it('creates intermediate directories', async () => {
      const result = await writeFile(root, 'deep/nested/file.txt', 'data');
      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(root, 'deep', 'nested', 'file.txt'), 'utf-8')).toBe('data');
    });

    it('overwrites existing file', async () => {
      fs.writeFileSync(path.join(root, 'exist.txt'), 'old');
      const result = await writeFile(root, 'exist.txt', 'new');
      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(root, 'exist.txt'), 'utf-8')).toBe('new');
    });

    it('rejects paths outside root', async () => {
      const result = await writeFile(root, '../../evil.txt', 'hack');
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside');
    });
  });

  describe('listFiles', () => {
    it('lists directory contents', async () => {
      fs.writeFileSync(path.join(root, 'a.txt'), 'a');
      fs.writeFileSync(path.join(root, 'b.txt'), 'b');
      fs.mkdirSync(path.join(root, 'subdir'));

      const result = await listFiles(root, '.', false);
      expect(result.success).toBe(true);
      const entries = result.data as Array<{ name: string; type: string }>;
      expect(entries).toHaveLength(3);
      expect(entries.some((e) => e.name === 'a.txt' && e.type === 'file')).toBe(true);
      expect(entries.some((e) => e.name === 'subdir' && e.type === 'directory')).toBe(true);
    });

    it('returns error for non-existent directory', async () => {
      const result = await listFiles(root, 'nope', false);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('lists recursively with recursive: true', async () => {
      fs.mkdirSync(path.join(root, 'sub'));
      fs.writeFileSync(path.join(root, 'top.txt'), 'top');
      fs.writeFileSync(path.join(root, 'sub', 'deep.txt'), 'deep');

      const result = await listFiles(root, '.', true);
      expect(result.success).toBe(true);
      const entries = result.data as Array<{ name: string; type: string }>;
      expect(entries.some((e) => e.name === 'sub/deep.txt')).toBe(true);
    });

    it('truncates at 1000 entries', async () => {
      for (let i = 0; i < 1005; i++) {
        fs.writeFileSync(path.join(root, `file_${String(i).padStart(4, '0')}.txt`), '');
      }

      const result = await listFiles(root, '.', false);
      expect(result.success).toBe(true);
      const entries = result.data as Array<{ name: string; type: string }>;
      expect(entries).toHaveLength(1000);
      expect(result.display?.content).toContain('truncated');
    });
  });

  describe('deleteFile', () => {
    it('removes a file', async () => {
      fs.writeFileSync(path.join(root, 'del.txt'), 'bye');
      const result = await deleteFile(root, 'del.txt');
      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(root, 'del.txt'))).toBe(false);
    });

    it('returns error for non-existent file', async () => {
      const result = await deleteFile(root, 'ghost.txt');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('rejects paths outside root', async () => {
      const result = await deleteFile(root, '../../important.txt');
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside');
    });
  });

  describe('moveFile', () => {
    it('moves file to new location', async () => {
      fs.writeFileSync(path.join(root, 'src.txt'), 'data');
      const result = await moveFile(root, 'src.txt', 'dst.txt');
      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(root, 'src.txt'))).toBe(false);
      expect(fs.readFileSync(path.join(root, 'dst.txt'), 'utf-8')).toBe('data');
    });

    it('creates intermediate directories for destination', async () => {
      fs.writeFileSync(path.join(root, 'move-me.txt'), 'data');
      const result = await moveFile(root, 'move-me.txt', 'newdir/moved.txt');
      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(root, 'newdir', 'moved.txt'), 'utf-8')).toBe('data');
    });

    it('returns error when source does not exist', async () => {
      const result = await moveFile(root, 'nope.txt', 'dst.txt');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('rejects source paths outside root', async () => {
      const result = await moveFile(root, '../../etc/passwd', 'stolen.txt');
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside');
    });

    it('rejects destination paths outside root', async () => {
      fs.writeFileSync(path.join(root, 'legit.txt'), 'data');
      const result = await moveFile(root, 'legit.txt', '../../escaped.txt');
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside');
    });
  });
});
