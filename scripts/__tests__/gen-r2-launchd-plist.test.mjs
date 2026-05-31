import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generatePlist } from '../gen-r2-launchd-plist.mjs';

const baseOpts = {
  label: 'com.r2.supervisor',
  repoPath: '/Users/dim/code/R2-D2',
  shellPath: '/bin/zsh',
  wrapperPath: '/Users/dim/code/R2-D2/scripts/r2-service.sh',
  outLog: '/Users/dim/Library/Logs/r2-supervisor.out.log',
  errLog: '/Users/dim/Library/Logs/r2-supervisor.err.log',
  throttle: 10,
};

function plutilAvailable() {
  try {
    execFileSync('/usr/bin/plutil', ['-help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('generatePlist', () => {
  it('returns a valid plist XML preamble', () => {
    const xml = generatePlist(baseOpts);
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('<!DOCTYPE plist PUBLIC');
    expect(xml).toContain('<plist version="1.0">');
    expect(xml.trimEnd()).toMatch(/<\/plist>$/);
  });

  it('includes all required launchd keys', () => {
    const xml = generatePlist(baseOpts);
    for (const key of [
      'Label',
      'ProgramArguments',
      'RunAtLoad',
      'KeepAlive',
      'StandardOutPath',
      'StandardErrorPath',
      'WorkingDirectory',
      'ThrottleInterval',
    ]) {
      expect(xml).toContain(`<key>${key}</key>`);
    }
  });

  it('interpolates the label', () => {
    const xml = generatePlist(baseOpts);
    expect(xml).toContain('<key>Label</key>');
    expect(xml).toContain('<string>com.r2.supervisor</string>');
  });

  it('builds ProgramArguments as [shellPath, "-lc", \'exec "$0"\', wrapperPath]', () => {
    const xml = generatePlist(baseOpts);
    const argsBlock = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
    expect(argsBlock).toBeTruthy();
    const strings = [...argsBlock[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1]);
    // wrapperPath is passed as $0 (quoted in `exec "$0"`) so paths with spaces or
    // shell metacharacters survive intact.
    expect(strings).toEqual([
      '/bin/zsh',
      '-lc',
      'exec "$0"',
      '/Users/dim/code/R2-D2/scripts/r2-service.sh',
    ]);
  });

  it('sets WorkingDirectory to repoPath', () => {
    const xml = generatePlist(baseOpts);
    expect(xml).toMatch(
      /<key>WorkingDirectory<\/key>\s*<string>\/Users\/dim\/code\/R2-D2<\/string>/,
    );
  });

  it('sets RunAtLoad and KeepAlive to true', () => {
    const xml = generatePlist(baseOpts);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it('wires the log paths', () => {
    const xml = generatePlist(baseOpts);
    expect(xml).toMatch(
      /<key>StandardOutPath<\/key>\s*<string>\/Users\/dim\/Library\/Logs\/r2-supervisor\.out\.log<\/string>/,
    );
    expect(xml).toMatch(
      /<key>StandardErrorPath<\/key>\s*<string>\/Users\/dim\/Library\/Logs\/r2-supervisor\.err\.log<\/string>/,
    );
  });

  it('sets ThrottleInterval from opts', () => {
    const xml = generatePlist(baseOpts);
    expect(xml).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  });

  it('escapes XML-special characters in values', () => {
    const xml = generatePlist({ ...baseOpts, label: 'com.r2.<a&b>' });
    expect(xml).toContain('<string>com.r2.&lt;a&amp;b&gt;</string>');
    expect(xml).not.toContain('com.r2.<a&b>');
  });

  it('escapes XML-special characters in every interpolated field', () => {
    const xml = generatePlist({
      ...baseOpts,
      repoPath: '/tmp/a&b',
      wrapperPath: '/tmp/<w>.sh',
      outLog: '/tmp/o&ut.log',
      errLog: '/tmp/e<rr>.log',
    });
    expect(xml).toContain('<string>/tmp/a&amp;b</string>');
    expect(xml).toContain('<string>/tmp/&lt;w&gt;.sh</string>');
    expect(xml).toContain('<string>/tmp/o&amp;ut.log</string>');
    expect(xml).toContain('<string>/tmp/e&lt;rr&gt;.log</string>');
    expect(xml).not.toMatch(/<string>[^<]*&(?!amp;|lt;|gt;)/);
  });

  it('throws when a required field is missing or empty', () => {
    expect(() => generatePlist({ ...baseOpts, label: '' })).toThrow(/label/);
    expect(() => generatePlist({ ...baseOpts, repoPath: 42 })).toThrow(/repoPath/);
    const { wrapperPath, ...noWrapper } = baseOpts;
    void wrapperPath;
    expect(() => generatePlist(noWrapper)).toThrow(/wrapperPath/);
  });

  it.runIf(plutilAvailable())('produces output that passes plutil -lint', () => {
    const xml = generatePlist(baseOpts);
    const dir = mkdtempSync(join(tmpdir(), 'r2-plist-'));
    const file = join(dir, 'test.plist');
    try {
      writeFileSync(file, xml);
      const out = execFileSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' });
      expect(out).toContain('OK');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
