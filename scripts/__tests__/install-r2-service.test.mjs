import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const installScript = join(here, '..', 'install-r2-service.sh');
// Canonical absolute path the install script bakes into the plist (it resolves
// SCRIPT_DIR via `cd ... pwd`, so join() — which normalizes — matches).
const wrapperPath = join(here, '..', 'r2-service.sh');

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
    // A log dir that must NOT be created by --no-load, and a non-default shell so
    // a broken env-var contract (generator falling back to its defaults) is caught
    // rather than silently passing — this is the bug that broke in commit 4742a19.
    const logDir = join(targetDir, 'logs-should-not-exist');
    const shellPath = '/bin/bash';

    execFileSync('bash', [installScript, '--no-load'], {
      env: {
        ...process.env,
        TARGET_DIR: targetDir,
        LABEL: TEST_LABEL,
        LOG_DIR: logDir,
        SHELL_PATH: shellPath,
      },
    });

    // 1. Plist created in the sandbox TARGET_DIR.
    const plistPath = join(targetDir, `${TEST_LABEL}.plist`);
    expect(existsSync(plistPath)).toBe(true);

    const xml = readFileSync(plistPath, 'utf8');
    expect(xml).toContain(`<string>${TEST_LABEL}</string>`);
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(xml).toContain('<key>KeepAlive</key>');
    // Strict assertions on the full env-var contract (WRAPPER_PATH / SHELL_PATH /
    // OUT_LOG / ERR_LOG). Each value differs from the generator's own defaults, so
    // a name mismatch that falls back to a default would fail here.
    expect(xml).toContain(`<string>${wrapperPath}</string>`);
    expect(xml).toContain(`<string>${shellPath}</string>`);
    expect(xml).toContain(`<string>${join(logDir, 'r2-supervisor.out.log')}</string>`);
    expect(xml).toContain(`<string>${join(logDir, 'r2-supervisor.err.log')}</string>`);

    // 2. Plist is structurally valid (when plutil is available).
    const plutil = which('plutil');
    if (plutil) {
      execFileSync(plutil, ['-lint', plistPath]);
    }

    // 3a. --no-load must not create the log directory (documented contract).
    expect(existsSync(logDir)).toBe(false);

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
