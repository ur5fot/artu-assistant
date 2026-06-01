#!/usr/bin/env node
// Pure generator for the R2 supervisor LaunchAgent plist.
//
// Two-level supervision: launchd (KeepAlive) -> supervisor (fork + auto-restart)
// -> worker. This module only PRODUCES the plist XML; it performs no system
// mutations (no launchctl, no writes to ~/Library/LaunchAgents). Installation
// lives in install-r2-service.sh.

import { fileURLToPath } from 'node:url';

/** Escape a string for safe inclusion inside an XML text node. */
function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Build a launchd plist for the R2 supervisor.
 *
 * @param {object} opts
 * @param {string} opts.label        - launchd Label (e.g. com.r2.supervisor)
 * @param {string} opts.repoPath     - repo root -> WorkingDirectory
 * @param {string} opts.shellPath    - login shell (e.g. /bin/zsh)
 * @param {string} opts.wrapperPath  - path to r2-service.sh
 * @param {string} opts.outLog       - StandardOutPath
 * @param {string} opts.errLog       - StandardErrorPath
 * @param {number} [opts.throttle=10] - ThrottleInterval seconds (anti tight-loop)
 * @returns {string} valid plist XML
 */
export function generatePlist(opts) {
  const { label, repoPath, shellPath, wrapperPath, outLog, errLog } = opts;
  const throttle = opts.throttle ?? 10;

  for (const [key, val] of Object.entries({
    label,
    repoPath,
    shellPath,
    wrapperPath,
    outLog,
    errLog,
  })) {
    if (typeof val !== 'string' || val.length === 0) {
      throw new Error(`generatePlist: missing or invalid "${key}"`);
    }
  }

  // Run the wrapper as `zsh -lc 'exec "$0"' <wrapperPath>`: the login shell sources
  // the profile (nvm → node on PATH), then execs the wrapper. Passing wrapperPath as
  // $0 (not inline in the -c string) keeps the shell from word-splitting paths with
  // spaces or interpreting shell metacharacters in them — `exec "$0"` is quoted.
  const programArgs = [shellPath, '-lc', 'exec "$0"', wrapperPath]
    .map((a) => `      <string>${xmlEscape(a)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(repoPath)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${Number(throttle)}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLog)}</string>
</dict>
</plist>
`;
}

// CLI mode: print the plist to stdout. Parameters come from env (preferred,
// used by install-r2-service.sh) with sensible defaults.
function main() {
  const home = process.env.HOME ?? '';
  const repoPath = process.env.REPO_PATH ?? process.cwd();
  const label = process.env.LABEL ?? 'com.r2.supervisor';
  const opts = {
    label,
    repoPath,
    shellPath: process.env.SHELL_PATH ?? '/bin/zsh',
    wrapperPath: process.env.WRAPPER_PATH ?? `${repoPath}/scripts/r2-service.sh`,
    outLog: process.env.OUT_LOG ?? `${home}/Library/Logs/r2-supervisor.out.log`,
    errLog: process.env.ERR_LOG ?? `${home}/Library/Logs/r2-supervisor.err.log`,
    throttle: process.env.THROTTLE ? Number(process.env.THROTTLE) : 10,
  };
  process.stdout.write(generatePlist(opts));
}

// Run as CLI only when invoked directly (not when imported by tests).
// Compare decoded filesystem paths so repos with spaces or URL-special chars
// (which import.meta.url percent-encodes but argv[1] does not) still match.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
