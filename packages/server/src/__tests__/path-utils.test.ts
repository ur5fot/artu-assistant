import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveProjectPath, getProjectRoot } from '../path-utils.js';

describe('resolveProjectPath — DI projectRoot, no cwd reads', () => {
  const projectRoot = '/proj';

  it('relative ./data/x.db → /proj/data/x.db', () => {
    expect(
      resolveProjectPath('./data/x.db', ['data', 'r2.db'], { projectRoot }),
    ).toBe(path.resolve('/proj', './data/x.db'));
  });

  it('relative data/x.db (no leading ./) → /proj/data/x.db', () => {
    expect(
      resolveProjectPath('data/x.db', ['data', 'r2.db'], { projectRoot }),
    ).toBe(path.resolve('/proj', 'data/x.db'));
  });

  it('relative ../sibling/x.db → /sibling/x.db (normalized — .. allowed)', () => {
    expect(
      resolveProjectPath('../sibling/x.db', ['data', 'r2.db'], { projectRoot }),
    ).toBe(path.resolve('/proj', '../sibling/x.db'));
  });

  it('absolute /abs/x.db → passthrough', () => {
    expect(
      resolveProjectPath('/abs/x.db', ['data', 'r2.db'], { projectRoot }),
    ).toBe('/abs/x.db');
  });

  it('undefined env → default joined under projectRoot', () => {
    expect(
      resolveProjectPath(undefined, ['data', 'x.db'], { projectRoot }),
    ).toBe(path.resolve('/proj', 'data', 'x.db'));
  });

  it('empty string env → treated as undefined, uses default', () => {
    expect(
      resolveProjectPath('', ['data', 'x.db'], { projectRoot }),
    ).toBe(path.resolve('/proj', 'data', 'x.db'));
  });

  it('whitespace-only env → treated as unset, uses default', () => {
    expect(
      resolveProjectPath('   ', ['data', 'x.db'], { projectRoot }),
    ).toBe(path.resolve('/proj', 'data', 'x.db'));
  });

  it('two different projectRoots yield two different results for same relative env (cwd-independence property)', () => {
    const a = resolveProjectPath('./data/x.db', ['data', 'x.db'], {
      projectRoot: '/projA',
    });
    const b = resolveProjectPath('./data/x.db', ['data', 'x.db'], {
      projectRoot: '/projB',
    });
    expect(a).toBe('/projA/data/x.db');
    expect(b).toBe('/projB/data/x.db');
  });

  it('absolute env is cwd-independent AND projectRoot-independent', () => {
    const a = resolveProjectPath('/abs/x.db', ['data', 'x.db'], {
      projectRoot: '/projA',
    });
    const b = resolveProjectPath('/abs/x.db', ['data', 'x.db'], {
      projectRoot: '/projB',
    });
    expect(a).toBe('/abs/x.db');
    expect(b).toBe('/abs/x.db');
  });
});

describe('getProjectRoot — sanity check on real build', () => {
  it('returns an absolute path', () => {
    const root = getProjectRoot();
    expect(path.isAbsolute(root)).toBe(true);
  });

  it('lands on the repo root (basename ends in R2-D2)', () => {
    const root = getProjectRoot();
    expect(path.basename(root)).toBe('R2-D2');
  });
});

describe('resolveProjectPath — default projectRoot fallback (no opts)', () => {
  it('without opts, uses getProjectRoot() and joins default parts', () => {
    const resolved = resolveProjectPath(undefined, ['data', 'r2.db']);
    expect(resolved).toBe(path.resolve(getProjectRoot(), 'data', 'r2.db'));
  });

  it('without opts, relative env resolves under real project root', () => {
    const resolved = resolveProjectPath('./data/x.db', ['data', 'r2.db']);
    expect(resolved).toBe(path.resolve(getProjectRoot(), './data/x.db'));
  });
});
