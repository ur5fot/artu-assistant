import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wrapper = join(here, '..', 'r2-service.sh');

const tmpDirs = [];

// Build a directory of fake executables and return its path. Prepended to PATH
// so these stubs shadow the real lsof/docker while real node/coreutils remain
// reachable (the wrapper needs node + dirname/pwd to run at all).
function makeFakeBin(bins) {
  const dir = mkdtempSync(join(tmpdir(), 'r2-fakebin-'));
  tmpDirs.push(dir);
  for (const [name, body] of Object.entries(bins)) {
    const p = join(dir, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

// Run the wrapper, capturing exit code + stderr (where the script logs).
// spawnSync returns both streams regardless of exit status.
function runWrapper(fakeBin, extraEnv = {}) {
  const res = spawnSync('bash', [wrapper], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ...extraEnv },
    encoding: 'utf8',
  });
  return { code: res.status, stderr: res.stderr ?? '', stdout: res.stdout ?? '' };
}

describe('r2-service.sh wrapper', () => {
  it('refuses to start when the worker port is already in use', () => {
    // Fake lsof reports a LISTENer (exit 0) regardless of port — the guard should
    // fire and abort before reaching docker/exec.
    const fakeBin = makeFakeBin({ lsof: 'exit 0' });
    const { code, stderr } = runWrapper(fakeBin, { R2_SERVICE_NO_EXEC: '1' });

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/already in use/);
  });

  it('treats a failing docker compose as non-fatal and continues to start', () => {
    // No listener (lsof exit 1) so the port guard passes; docker fails (exit 1).
    // The wrapper must swallow the docker failure and reach the exec step.
    const fakeBin = makeFakeBin({ lsof: 'exit 1', docker: 'exit 1' });
    const { code, stderr } = runWrapper(fakeBin, { R2_SERVICE_NO_EXEC: '1' });

    expect(code).toBe(0);
    expect(stderr).toMatch(/docker compose up -d' failed/);
    expect(stderr).toMatch(/skipping supervisor exec/);
  });

  it('proceeds to exec when the port is free and docker succeeds', () => {
    const fakeBin = makeFakeBin({ lsof: 'exit 1', docker: 'exit 0' });
    const { code, stderr } = runWrapper(fakeBin, { R2_SERVICE_NO_EXEC: '1' });

    expect(code).toBe(0);
    expect(stderr).not.toMatch(/already in use/);
    expect(stderr).toMatch(/skipping supervisor exec/);
  });

  it('guards the worker port resolved from a .env file', () => {
    // Build our own .env fixture (PORT=3004) and point the wrapper at it via
    // R2_SERVICE_ENV_FILE so the test doesn't depend on the developer's local,
    // gitignored .env. The guard must check that resolved port. Fake lsof records
    // its args, then reports the port free (exit 1) so startup proceeds — proving
    // which port was actually probed.
    const capDir = mkdtempSync(join(tmpdir(), 'r2-cap-'));
    tmpDirs.push(capDir);
    const capture = join(capDir, 'lsof-args');
    const envFile = join(capDir, '.env');
    writeFileSync(envFile, 'PORT=3004\n');
    const fakeBin = makeFakeBin({ lsof: 'echo "$@" >> "$R2_TEST_LSOF_ARGS"; exit 1' });
    const { code } = runWrapper(fakeBin, {
      R2_SERVICE_NO_EXEC: '1',
      R2_SERVICE_ENV_FILE: envFile,
      R2_TEST_LSOF_ARGS: capture,
    });

    expect(code).toBe(0);
    expect(readFileSync(capture, 'utf8')).toMatch(/-iTCP:3004/);
  });

  it('prefers an exported PORT over the .env value', () => {
    const capDir = mkdtempSync(join(tmpdir(), 'r2-cap-'));
    tmpDirs.push(capDir);
    const capture = join(capDir, 'lsof-args');
    const fakeBin = makeFakeBin({ lsof: 'echo "$@" >> "$R2_TEST_LSOF_ARGS"; exit 1' });
    const { code } = runWrapper(fakeBin, {
      R2_SERVICE_NO_EXEC: '1',
      PORT: '9999',
      R2_TEST_LSOF_ARGS: capture,
    });

    expect(code).toBe(0);
    expect(readFileSync(capture, 'utf8')).toMatch(/-iTCP:9999/);
  });

  it('refuses to start on a node older than 20', () => {
    // node 18 passed the old >=18 guard but is now rejected: the `node --import
    // tsx` exec needs the --import loader hook (node >=20). Empty NVM_DIR so nvm
    // sourcing is skipped and our fake node wins on PATH. Fake docker too so the
    // guard-revert red-green check can't reach real docker.
    const emptyNvm = mkdtempSync(join(tmpdir(), 'r2-nvm-'));
    tmpDirs.push(emptyNvm);
    const fakeBin = makeFakeBin({
      // `node --version` → v18.20.0; `node -p '...major...'` → 18.
      node: 'case "$*" in *--version*) echo v18.20.0 ;; *) echo 18 ;; esac',
      lsof: 'exit 1',
      docker: 'exit 0',
    });
    const { code, stderr } = runWrapper(fakeBin, {
      R2_SERVICE_NO_EXEC: '1',
      NVM_DIR: emptyNvm,
    });

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/too old/);
  });
});
