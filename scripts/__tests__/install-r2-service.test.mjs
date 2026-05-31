import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const installScript = join(here, '..', 'install-r2-service.sh');

// A label unlikely to collide with anything real, so we can assert the system
// LaunchAgents dir / launchctl were never touched by the dry run.
const TEST_LABEL = 'com.r2.test-install-drynrun';

const tmpDirs = [];
function makeTargetDir() {
  const dir = mkdtempSync(join(tmpdir(), 'r2-install-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function which(bin) {
  try {
    return execFileSync('which', [bin]).toString().trim();
  } catch {
    return null;
  }
}

describe('install-r2-service.sh --no-load (dry run)', () => {
  it('writes a valid plist to TARGET_DIR and leaves the system untouched', () => {
    const targetDir = makeTargetDir();

    execFileSync('bash', [installScript, '--no-load'], {
      env: { ...process.env, TARGET_DIR: targetDir, LABEL: TEST_LABEL },
    });

    // 1. Plist created in the sandbox TARGET_DIR.
    const plistPath = join(targetDir, `${TEST_LABEL}.plist`);
    expect(existsSync(plistPath)).toBe(true);

    const xml = readFileSync(plistPath, 'utf8');
    expect(xml).toContain(`<string>${TEST_LABEL}</string>`);
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(xml).toContain('<key>KeepAlive</key>');
    // The wrapper path baked in must point at the real r2-service.sh.
    expect(xml).toContain('scripts/r2-service.sh');

    // 2. Plist is structurally valid (when plutil is available).
    const plutil = which('plutil');
    if (plutil) {
      execFileSync(plutil, ['-lint', plistPath]);
    }

    // 3. The real LaunchAgents directory was not written to.
    const systemPlist = join(homedir(), 'Library', 'LaunchAgents', `${TEST_LABEL}.plist`);
    expect(existsSync(systemPlist)).toBe(false);

    // 4. launchctl was not asked to load the service.
    const launchctl = which('launchctl');
    if (launchctl) {
      let listing = '';
      try {
        listing = execFileSync(launchctl, ['list']).toString();
      } catch {
        listing = '';
      }
      expect(listing).not.toContain(TEST_LABEL);
    }
  });

  it('rejects unknown arguments', () => {
    const targetDir = makeTargetDir();
    expect(() =>
      execFileSync('bash', [installScript, '--bogus'], {
        env: { ...process.env, TARGET_DIR: targetDir, LABEL: TEST_LABEL },
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});
