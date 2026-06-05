/**
 * Shared classifier for transient network errors.
 *
 * A flapping VPN/DNS (relay switch, sleep/wake) surfaces as a small set of
 * recoverable error codes and gateway/WebSocket messages. We treat these as
 * "wait and retry" rather than fatal so the worker neither crashes nor exits.
 *
 * Used by:
 *  - the worker process-level safety net (uncaughtException/unhandledRejection),
 *    so a raw `ws` 'error' (e.g. "Opening handshake has timed out") can no
 *    longer take down the whole process;
 *  - Discord login/connect retry (`isRetryableError`).
 */

/** errno-style codes that mean "the network blinked", not "the code is wrong". */
const TRANSIENT_CODES = [
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
];

// Substrings (lowercased) seen in transient gateway/WebSocket/DNS failures.
// Note: 'timeout' and 'network' are intentionally broad — they preserve the
// pre-existing isRetryableError login-retry contract. The process-level crash
// net shares this classifier, so a genuine bug whose message happens to contain
// these words is ridden out rather than exited; the reconnect loop and the rest
// of R2's resilience bound the blast radius. Tightening this would break the
// Discord login retry, so it's kept as-is by design.
const TRANSIENT_MESSAGES = [
  'opening handshake has timed out',
  'websocket',
  'connect timeout',
  'timeout',
  'socket hang up',
  'fetch failed',
  'network',
  'getaddrinfo',
];

function collectStrings(err: unknown): { code: string; message: string } {
  let code = '';
  let message = '';
  if (err instanceof Error) {
    message = err.message;
    // Node attaches the errno code on `.code`; preserve it even when typed loosely.
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') code = c;
  } else if (typeof err === 'string') {
    message = err;
  } else if (err && typeof err === 'object') {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') code = c;
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') message = m;
  }
  return { code: code.toUpperCase(), message: message.toLowerCase() };
}

/**
 * True when `err` looks like a transient network blip we should ride out.
 * False for genuine bugs (TypeError, assertion failures, etc.).
 */
export function isTransientNetworkError(err: unknown): boolean {
  const { code, message } = collectStrings(err);
  if (code && TRANSIENT_CODES.includes(code)) return true;
  if (!message) return false;
  if (TRANSIENT_CODES.some((c) => message.includes(c.toLowerCase()))) return true;
  return TRANSIENT_MESSAGES.some((m) => message.includes(m));
}
