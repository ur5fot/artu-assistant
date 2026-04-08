import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function resolveRoot(): string {
  const raw = process.env.R2_FILES_ROOT;
  if (!raw) return path.join(os.homedir(), 'Documents', 'r2');
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function isInsideRoot(target: string, rootDir: string): boolean {
  return target === rootDir || target.startsWith(rootDir + path.sep);
}

export function safePath(root: string, userPath: string): string {
  const resolved = path.resolve(root, userPath);
  const normalizedRoot = path.resolve(root);

  // Lexical check first (catches obvious traversal before touching filesystem)
  if (!isInsideRoot(resolved, normalizedRoot)) {
    throw new Error('Path outside allowed directory');
  }

  // Resolve symlinks to prevent symlink traversal attacks
  // If the path exists, check the real path
  try {
    const realPath = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(normalizedRoot);
    if (!isInsideRoot(realPath, realRoot)) {
      throw new Error('Path outside allowed directory');
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.message === 'Path outside allowed directory') {
      throw e;
    }
    // Path doesn't exist yet (e.g. write destination) — check the closest existing ancestor
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
      let ancestor = path.dirname(resolved);
      while (ancestor !== path.dirname(ancestor)) {
        try {
          const realAncestor = fs.realpathSync(ancestor);
          const realRoot = fs.realpathSync(normalizedRoot);
          if (!isInsideRoot(realAncestor, realRoot)) {
            throw new Error('Path outside allowed directory');
          }
          break;
        } catch (innerErr: unknown) {
          if (innerErr instanceof Error && innerErr.message === 'Path outside allowed directory') {
            throw innerErr;
          }
          ancestor = path.dirname(ancestor);
        }
      }
    } else {
      // Unknown errors (EACCES, ELOOP, etc.) — deny access rather than fail open
      throw new Error('Path outside allowed directory');
    }
  }

  return resolved;
}
