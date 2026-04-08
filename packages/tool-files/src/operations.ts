import fs from 'node:fs';
import path from 'node:path';
import type { ToolResult } from '@r2/shared';
import { safePath } from './paths.js';

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_LIST_ENTRIES = 1000;
const MAX_RECURSION_DEPTH = 20;

function ensureRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true });
}

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

  try {
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_FILE_SIZE) {
      return { success: false, error: `File exceeds 1MB limit (${stat.size} bytes)` };
    }

    const rawBuf = fs.readFileSync(resolved);

    // Check for binary content in first 512 bytes
    const checkLen = Math.min(512, rawBuf.length);
    for (let i = 0; i < checkLen; i++) {
      if (rawBuf[i] === 0x00) {
        return { success: false, error: 'Cannot read binary file' };
      }
    }

    const content = rawBuf.toString('utf-8');
    return {
      success: true,
      data: content,
      display: { type: 'code', content },
    };
  } catch {
    return { success: false, error: `Failed to read file: ${filePath}` };
  }
}

export async function writeFile(root: string, filePath: string, content: string): Promise<ToolResult> {
  ensureRoot(root);

  let resolved: string;
  try {
    resolved = safePath(root, filePath);
  } catch {
    return { success: false, error: 'Path outside allowed directory' };
  }

  const contentSize = Buffer.byteLength(content);
  if (contentSize > MAX_FILE_SIZE) {
    return { success: false, error: `Content exceeds 1MB limit (${contentSize} bytes)` };
  }

  try {
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
  } catch {
    return { success: false, error: `Failed to write file: ${filePath}` };
  }
}

function collectEntries(
  dir: string,
  prefix: string,
  recursive: boolean,
  entries: Array<{ name: string; type: string }>,
  depth: number = 0,
): void {
  if (depth > MAX_RECURSION_DEPTH) return;
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    if (entries.length >= MAX_LIST_ENTRIES) return;
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    const type = item.isDirectory() ? 'directory' : 'file';
    entries.push({ name, type });
    if (recursive && item.isDirectory() && !item.isSymbolicLink()) {
      collectEntries(path.join(dir, item.name), name, true, entries, depth + 1);
    }
  }
}

export async function listFiles(root: string, dirPath: string, recursive: boolean): Promise<ToolResult> {
  ensureRoot(root);

  let resolved: string;
  try {
    resolved = safePath(root, dirPath);
  } catch {
    return { success: false, error: 'Path outside allowed directory' };
  }

  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { success: false, error: `Directory not found: ${dirPath}` };
    }

    const entries: Array<{ name: string; type: string }> = [];
    collectEntries(resolved, '', recursive, entries);

    const truncated = entries.length >= MAX_LIST_ENTRIES;
    const displayLines = entries.map((e) => `${e.type === 'directory' ? '[dir]' : '     '} ${e.name}`);
    let displayContent = displayLines.join('\n');
    if (truncated) {
      displayContent += `\n\n(truncated, showing first ${MAX_LIST_ENTRIES} entries)`;
    }

    return {
      success: true,
      data: entries,
      display: { type: 'text', content: displayContent },
    };
  } catch {
    return { success: false, error: `Failed to list directory: ${dirPath}` };
  }
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

  try {
    if (fs.statSync(resolved).isDirectory()) {
      return { success: false, error: 'Cannot delete directories' };
    }

    fs.unlinkSync(resolved);
    return {
      success: true,
      data: { path: filePath },
      display: { type: 'text', content: `Deleted ${filePath}` },
    };
  } catch {
    return { success: false, error: `Failed to delete file: ${filePath}` };
  }
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

  try {
    if (!fs.existsSync(resolvedSrc)) {
      return { success: false, error: `Source not found: ${source}` };
    }

    if (fs.statSync(resolvedSrc).isDirectory()) {
      return { success: false, error: 'Cannot move directories' };
    }

    const dstDir = path.dirname(resolvedDst);
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true });
    }

    // Use link+unlink to move without overwrite race (link fails atomically if dest exists).
    // Fall back to copy+unlink when hard links aren't supported (EXDEV, EPERM, ENOTSUP, EOPNOTSUPP).
    const fallbackCodes = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP']);
    try {
      fs.linkSync(resolvedSrc, resolvedDst);
    } catch (linkErr: unknown) {
      const code = linkErr instanceof Error && 'code' in linkErr
        ? (linkErr as NodeJS.ErrnoException).code
        : undefined;
      if (code && fallbackCodes.has(code)) {
        fs.copyFileSync(resolvedSrc, resolvedDst, fs.constants.COPYFILE_EXCL);
      } else {
        throw linkErr;
      }
    }
    try {
      fs.unlinkSync(resolvedSrc);
    } catch (unlinkErr: unknown) {
      // Rollback: remove destination we created since move didn't complete
      try { fs.unlinkSync(resolvedDst); } catch { /* best-effort cleanup */ }
      throw unlinkErr;
    }

    return {
      success: true,
      data: { source, destination },
      display: { type: 'text', content: `Moved ${source} → ${destination}` },
    };
  } catch (e: unknown) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'EEXIST') {
      return { success: false, error: `Destination already exists: ${destination}` };
    }
    return { success: false, error: `Failed to move file: ${source}` };
  }
}
