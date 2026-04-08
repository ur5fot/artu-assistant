import path from 'node:path';
import os from 'node:os';

export function resolveRoot(): string {
  const raw = process.env.R2_FILES_ROOT;
  if (!raw) return path.join(os.homedir(), 'Documents', 'r2');
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

export function safePath(root: string, userPath: string): string {
  const resolved = path.resolve(root, userPath);
  const normalizedRoot = path.resolve(root);

  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new Error('Path outside allowed directory');
  }

  return resolved;
}
