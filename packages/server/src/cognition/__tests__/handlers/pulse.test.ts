import { describe, it, expect } from 'vitest';
import { pulseHandler } from '../../handlers/pulse.js';

const ctx = { db: {} as any };

describe('pulse handler', () => {
  it('trigger=true on first run (lastFiredAt=null)', () => {
    expect(pulseHandler.trigger({ now: 0, lastFiredAt: null, lastResult: null }, ctx)).toBe(true);
  });

  it('trigger=false within 5 min', () => {
    const now = 10_000_000;
    expect(pulseHandler.trigger({ now, lastFiredAt: now - 4 * 60 * 1000, lastResult: null }, ctx)).toBe(false);
  });

  it('trigger=true after 5 min', () => {
    const now = 10_000_000;
    expect(pulseHandler.trigger({ now, lastFiredAt: now - 5 * 60 * 1000, lastResult: null }, ctx)).toBe(true);
  });

  it('run returns skip with ISO timestamp', async () => {
    const ctx = { db: {} as any, signal: new AbortController().signal };
    const result = await pulseHandler.run(ctx);
    expect(result).toMatchObject({ skip: true });
    if ('skip' in result) {
      expect(result.reason).toMatch(/^alive at \d{4}-\d{2}-\d{2}T/);
    }
  });
});
