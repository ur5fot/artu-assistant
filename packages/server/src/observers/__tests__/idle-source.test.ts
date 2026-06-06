import { describe, it, expect, vi } from 'vitest';
import {
  parseIdleSeconds,
  createIoregIdleSource,
  type ExecRunner,
} from '../idle-source.js';

// A realistic slice of `ioreg -c IOHIDSystem` output. HIDIdleTime is in ns.
const IOREG_SAMPLE = `+-o IOHIDSystem  <class IOHIDSystem, id 0x100000abc, registered, matched, active, busy 0 (0 ms), retain 12>
    {
      "IOClass" = "IOHIDSystem"
      "HIDIdleTime" = 12345678900
      "IOProviderClass" = "IOResources"
    }`;

describe('parseIdleSeconds', () => {
  it('parses HIDIdleTime ns into rounded seconds', () => {
    // 12_345_678_900 ns ≈ 12.35 s → 12
    expect(parseIdleSeconds(IOREG_SAMPLE)).toBe(12);
  });

  it('rounds to the nearest second', () => {
    expect(parseIdleSeconds('"HIDIdleTime" = 1600000000')).toBe(2); // 1.6 s → 2
    expect(parseIdleSeconds('"HIDIdleTime" = 1400000000')).toBe(1); // 1.4 s → 1
  });

  it('returns 0 for zero idle (active right now)', () => {
    expect(parseIdleSeconds('"HIDIdleTime" = 0')).toBe(0);
  });

  it('parses large idle values (overnight)', () => {
    // 8 hours = 28800 s = 28_800_000_000_000 ns
    expect(parseIdleSeconds('"HIDIdleTime" = 28800000000000')).toBe(28800);
  });

  it('tolerates extra whitespace around the assignment', () => {
    expect(parseIdleSeconds('  "HIDIdleTime"   =    3000000000  ')).toBe(3);
  });

  it('returns null when HIDIdleTime field is absent', () => {
    expect(parseIdleSeconds('"SomethingElse" = 5')).toBeNull();
  });

  it('returns null for empty output', () => {
    expect(parseIdleSeconds('')).toBeNull();
  });

  it('returns null for garbage output', () => {
    expect(parseIdleSeconds('this is not ioreg output at all')).toBeNull();
  });

  it('returns null when value is non-numeric', () => {
    expect(parseIdleSeconds('"HIDIdleTime" = abc')).toBeNull();
  });
});

describe('createIoregIdleSource.getIdleSeconds', () => {
  function withExec(exec: ExecRunner) {
    return createIoregIdleSource({ exec });
  }

  it('returns parsed seconds from injected ioreg output', async () => {
    const exec = vi.fn<ExecRunner>().mockResolvedValue(IOREG_SAMPLE);
    const src = withExec(exec);
    expect(await src.getIdleSeconds()).toBe(12);
    expect(exec).toHaveBeenCalledWith('ioreg', ['-c', 'IOHIDSystem']);
  });

  it('returns null when exec yields null (command failure / non-macOS)', async () => {
    const src = withExec(async () => null);
    expect(await src.getIdleSeconds()).toBeNull();
  });

  it('returns null when exec output is unparseable', async () => {
    const src = withExec(async () => 'unexpected garbage');
    expect(await src.getIdleSeconds()).toBeNull();
  });

  it('returns null when exec throws', async () => {
    const src = withExec(async () => {
      throw new Error('spawn ENOENT');
    });
    expect(await src.getIdleSeconds()).toBeNull();
  });

  it('returns null for empty stdout', async () => {
    const src = withExec(async () => '');
    expect(await src.getIdleSeconds()).toBeNull();
  });
});
