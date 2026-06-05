import { describe, it, expect } from 'vitest';
import { isTransientNetworkError } from './transient-error.js';

describe('isTransientNetworkError', () => {
  it('classifies errno codes on .code as transient', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE']) {
      const err = Object.assign(new Error('boom'), { code });
      expect(isTransientNetworkError(err), code).toBe(true);
    }
  });

  it('classifies the real worker-crash message as transient', () => {
    // Exact text from the raw `ws` 'error' that crashed the worker on 2026-06-05.
    expect(isTransientNetworkError(new Error('Opening handshake has timed out'))).toBe(true);
  });

  it('classifies WebSocket / connect-timeout / DNS messages as transient', () => {
    expect(isTransientNetworkError(new Error('WebSocket was closed before the connection was established'))).toBe(true);
    expect(isTransientNetworkError(new Error('Connect Timeout Error'))).toBe(true);
    expect(isTransientNetworkError(new Error('getaddrinfo EAI_AGAIN gateway.discord.gg'))).toBe(true);
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true);
  });

  it('recognizes errno code embedded in the message (no .code)', () => {
    expect(isTransientNetworkError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true);
  });

  it('accepts plain strings and loose objects', () => {
    expect(isTransientNetworkError('ETIMEDOUT')).toBe(true);
    expect(isTransientNetworkError({ code: 'ENOTFOUND' })).toBe(true);
    expect(isTransientNetworkError({ message: 'Opening handshake has timed out' })).toBe(true);
  });

  it('treats real bugs as fatal (not transient)', () => {
    expect(isTransientNetworkError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(isTransientNetworkError(new Error('assertion failed'))).toBe(false);
    expect(isTransientNetworkError(new RangeError('out of range'))).toBe(false);
  });

  it('handles null/undefined/non-error inputs safely', () => {
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
    expect(isTransientNetworkError(42)).toBe(false);
  });
});
