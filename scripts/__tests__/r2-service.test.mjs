import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
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
});
