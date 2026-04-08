import fs from 'node:fs';
import path from 'node:path';
import type { ToolResult } from '@r2/shared';
import { safePath } from './paths.js';

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_LIST_ENTRIES = 1000;

export async function readFile(root: string, filePath: string): Promise<ToolResult> {
  let resolved: string;
  try {
    resolved = safePath(root, filePath);
  } catch {
    return { success: false, error: 'Path outside allowed directory' };
  }

  if (!fs.existsSync(resolved)) {
    return { success: false, error: `File not found: ${filePath}` };
  }

  const stat = fs.statSync(resolved);
  if (stat.size > MAX_FILE_SIZE) {
    return { success: false, error: `File exceeds 1MB limit (${stat.size} bytes)` };
  }

  // Check for binary content
  const fd = fs.openSync(resolved, 'r');
  const checkBuf = Buffer.alloc(Math.min(512, stat.size));
  fs.readSync(fd, checkBuf, 0, checkBuf.length, 0);
  fs.closeSync(fd);

  if (checkBuf.includes(0x00)) {
    return { success: false, error: 'Cannot read binary file' };
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  return {
    success: true,
    data: content,
    display: { type: 'code', content },
  };
}

export async function writeFile(root: string, filePath: string, content: string): Promise<ToolResult> {
  let resolved: string;
  try {
    resolved = safePath(root, filePath);
  } catch {
    return { success: false, error: 'Path outside allowed directory' };
  }

  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(resolved, content, 'utf-8');
  return {
    success: true,
    data: { path: filePath, bytes: Buffer.byteLength(content) },
    display: { type: 'text', content: `Written ${filePath} (${Buffer.byteLength(content)} bytes)` },
  };
}

function collectEntries(
  root: string,
  dir: string,
  prefix: string,
  recursive: boolean,
  entries: Array<{ name: string; type: string }>,
): void {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    if (entries.length >= MAX_LIST_ENTRIES) return;
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    const type = item.isDirectory() ? 'directory' : 'file';
    entries.push({ name, type });
    if (recursive && item.isDirectory()) {
      collectEntries(root, path.join(dir, item.name), name, true, entries);
    }
  }
}

export async function listFiles(root: string, dirPath: string, recursive: boolean): Promise<ToolResult> {
  let resolved: string;
  try {
    resolved = safePath(root, dirPath);
  } catch {
    return { success: false, error: 'Path outside allowed directory' };
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { success: false, error: `Directory not found: ${dirPath}` };
  }

  const entries: Array<{ name: string; type: string }> = [];
  collectEntries(root, resolved, '', recursive, entries);

  // Count total if we hit the limit
  let totalCount = entries.length;
  if (entries.length >= MAX_LIST_ENTRIES) {
    // Re-count total for truncation message
    const countAll = (d: string): number => {
      let count = 0;
      const items = fs.readdirSync(d, { withFileTypes: true });
      for (const item of items) {
        count++;
        if (recursive && item.isDirectory()) {
          count += countAll(path.join(d, item.name));
        }
      }
      return count;
    };
    totalCount = countAll(resolved);
  }

  const truncated = totalCount > MAX_LIST_ENTRIES;
  const displayLines = entries.map((e) => `${e.type === 'directory' ? '[dir]' : '     '} ${e.name}`);
  const displayContent = truncated
    ? displayLines.join('\n') + `\n\n(truncated, ${MAX_LIST_ENTRIES} of ${totalCount} total)`
    : displayLines.join('\n');

  return {
    success: true,
    data: entries,
    display: { type: 'text', content: displayContent },
  };
}

export async function deleteFile(root: string, filePath: string): Promise<ToolResult> {
  let resolved: string;
  try {
    resolved = safePath(root, filePath);
  } catch {
    return { success: false, error: 'Path outside allowed directory' };
  }

  if (!fs.existsSync(resolved)) {
    return { success: false, error: `File not found: ${filePath}` };
  }

  fs.unlinkSync(resolved);
  return {
    success: true,
    data: { path: filePath },
    display: { type: 'text', content: `Deleted ${filePath}` },
  };
}

export async function moveFile(root: string, source: string, destination: string): Promise<ToolResult> {
  let resolvedSrc: string;
  let resolvedDst: string;
  try {
    resolvedSrc = safePath(root, source);
  } catch {
    return { success: false, error: 'Source path outside allowed directory' };
  }
  try {
    resolvedDst = safePath(root, destination);
  } catch {
    return { success: false, error: 'Destination path outside allowed directory' };
  }

  if (!fs.existsSync(resolvedSrc)) {
    return { success: false, error: `Source not found: ${source}` };
  }

  const dstDir = path.dirname(resolvedDst);
  if (!fs.existsSync(dstDir)) {
    fs.mkdirSync(dstDir, { recursive: true });
  }

  fs.renameSync(resolvedSrc, resolvedDst);
  return {
    success: true,
    data: { source, destination },
    display: { type: 'text', content: `Moved ${source} → ${destination}` },
  };
}
