import { describe, it, expect } from 'vitest';
import { envInt } from '../env-utils.js';

describe('envInt — EMAIL_SEND_HOLD_SECONDS bounds (min=0, max=300, default=30)', () => {
  const parse = (raw: string | undefined) => envInt(raw, 30, 0, 300);

  it('returns default 30 when env var is undefined', () => {
    expect(parse(undefined)).toBe(30);
  });

  it('returns default 30 when env var is non-numeric', () => {
    expect(parse('abc')).toBe(30);
  });

  it('returns 30 for explicit "30"', () => {
    expect(parse('30')).toBe(30);
  });

  it('allows 0 (bypass mode — kill switch)', () => {
    expect(parse('0')).toBe(0);
  });

  it('allows 300 (upper bound)', () => {
    expect(parse('300')).toBe(300);
  });

  it('allows values between 1 and 299', () => {
    expect(parse('1')).toBe(1);
    expect(parse('60')).toBe(60);
    expect(parse('299')).toBe(299);
  });

  it('falls back to 30 on negative input', () => {
    expect(parse('-1')).toBe(30);
    expect(parse('-30')).toBe(30);
  });

  it('falls back to 30 when exceeding upper bound 300', () => {
    expect(parse('301')).toBe(30);
    expect(parse('1000')).toBe(30);
  });

  it('floors fractional values within bounds', () => {
    expect(parse('30.9')).toBe(30);
    expect(parse('0.5')).toBe(0);
  });
});
