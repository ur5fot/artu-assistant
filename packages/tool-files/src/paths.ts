import path from 'node:path';
import os from 'node:os';

export function resolveRoot(): string {
  return process.env.R2_FILES_ROOT || path.join(os.homedir(), 'Documents', 'r2');
}

export function safePath(root: string, userPath: string): string {
  const resolved = path.resolve(root, userPath);
  const normalizedRoot = path.resolve(root);

  if (!resolved.startsWith(normalizedRoot)) {
    throw new Error('Path outside allowed directory');
  }

  return resolved;
}
