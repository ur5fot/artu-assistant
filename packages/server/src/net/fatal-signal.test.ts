import { describe, it, expect, vi } from 'vitest';
import { handleFatalSignal } from './fatal-signal.js';

function makeDeps() {
  return {
    onExit: vi.fn(),
    log: vi.fn(),
  };
}

describe('handleFatalSignal', () => {
  it('does NOT exit on a transient network error (worker stays alive)', () => {
    const deps = makeDeps();
    handleFatalSignal('uncaughtException', new Error('Opening handshake has timed out'), deps);
    expect(deps.onExit).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('warn', expect.stringContaining('transient'), expect.any(Error));
  });

  it('does NOT exit on a transient unhandledRejection reason', () => {
    const deps = makeDeps();
    handleFatalSignal('unhandledRejection', Object.assign(new Error('boom'), { code: 'ECONNRESET' }), deps);
    expect(deps.onExit).not.toHaveBeenCalled();
  });

  it('exits with 1 on a fatal (non-transient) error', () => {
    const deps = makeDeps();
    handleFatalSignal('uncaughtException', new TypeError('cannot read x of undefined'), deps);
    expect(deps.onExit).toHaveBeenCalledTimes(1);
    expect(deps.onExit).toHaveBeenCalledWith(1);
    expect(deps.log).toHaveBeenCalledWith('error', expect.stringContaining('fatal'), expect.any(Error));
  });

  it('exits on non-error fatal reasons too', () => {
    const deps = makeDeps();
    handleFatalSignal('unhandledRejection', 'some unexpected string', deps);
    expect(deps.onExit).toHaveBeenCalledWith(1);
  });
});
