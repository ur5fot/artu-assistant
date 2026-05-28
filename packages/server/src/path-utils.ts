import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DO NOT MOVE THIS FILE — path walk assumes packages/server/src/ depth.
const here = path.dirname(fileURLToPath(import.meta.url));
const cachedProjectRoot = path.resolve(here, '..', '..', '..');

export function getProjectRoot(): string {
  return cachedProjectRoot;
}

export interface ResolveProjectPathOpts {
  projectRoot?: string;
}

export function resolveProjectPath(
  envValue: string | undefined,
  defaultRelativeParts: string[],
  opts: ResolveProjectPathOpts = {},
): string {
  const projectRoot = opts.projectRoot ?? getProjectRoot();

  if (envValue === undefined || envValue.trim() === '') {
    return path.resolve(projectRoot, ...defaultRelativeParts);
  }

  if (path.isAbsolute(envValue)) {
    return envValue;
  }

  return path.resolve(projectRoot, envValue);
}
