import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uninstallScript = join(here, '..', 'uninstall-r2-service.sh');

// A label unlikely to collide with anything real on the machine.
const TEST_LABEL = 'com.r2.test-uninstall';

const tmpDirs = [];
function makeTargetDir() {
  const dir = mkdtempSync(join(tmpdir(), 'r2-uninstall-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function runUninstall(targetDir) {
  return execFileSync('bash', [uninstallScript], {
    env: { ...process.env, TARGET_DIR: targetDir, LABEL: TEST_LABEL },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('uninstall-r2-service.sh', () => {
  it('removes the plist from a sandbox TARGET_DIR', () => {
    const targetDir = makeTargetDir();
    const plistPath = join(targetDir, `${TEST_LABEL}.plist`);
    // launchctl unload of a never-loaded plist errors, but the script swallows it
    // (`|| true`), so this exercises the real removal path without side effects.
    writeFileSync(plistPath, '<plist></plist>');

    runUninstall(targetDir);

    expect(existsSync(plistPath)).toBe(false);
  });

  it('is idempotent when no plist is present', () => {
    const targetDir = makeTargetDir();
    // No plist written; a fresh run must still exit 0 and say nothing to do.
    expect(() => runUninstall(targetDir)).not.toThrow();
  });

  it('a second run after removal still succeeds', () => {
    const targetDir = makeTargetDir();
    const plistPath = join(targetDir, `${TEST_LABEL}.plist`);
    writeFileSync(plistPath, '<plist></plist>');

    runUninstall(targetDir);
    expect(existsSync(plistPath)).toBe(false);
    // Re-running with the plist already gone must not fail.
    expect(() => runUninstall(targetDir)).not.toThrow();
  });
});
