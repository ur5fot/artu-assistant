import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../../db.js';
import {
  inQuietHours,
  morningBriefPublishedToday,
  formatDigest,
} from '../../handlers/emailDigest.helpers.js';

beforeEach(() => initDb(':memory:'));

const TZ = 'Europe/Kyiv';

function epochAtKyiv(year: number, month: number, day: number, hour: number): number {
  // Build an approximate Kyiv-local epoch. Kyiv is UTC+2 (or +3 in DST).
  // For test stability we use April (DST=on, UTC+3).
  const utcHour = hour - 3;
  return Date.UTC(year, month - 1, day, utcHour, 0, 0);
}

function insertRun(handlerName: string, firedAt: number, outcome: 'publish' | 'skip' | 'error') {
  getDb().prepare(
    'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
  ).run(handlerName, firedAt, 10, outcome);
}

describe('inQuietHours', () => {
  it('returns true at 23:00 local', () => {
    const now = epochAtKyiv(2026, 4, 24, 23);
    expect(inQuietHours(now, 22, TZ)).toBe(true);
  });

  it('returns true at 04:00 local (past midnight)', () => {
    const now = epochAtKyiv(2026, 4, 24, 4);
    expect(inQuietHours(now, 22, TZ)).toBe(true);
  });

  it('returns false at 14:00 local', () => {
    const now = epochAtKyiv(2026, 4, 24, 14);
    expect(inQuietHours(now, 22, TZ)).toBe(false);
  });
});

describe('morningBriefPublishedToday', () => {
  it('returns false when no runs', () => {
    const now = epochAtKyiv(2026, 4, 24, 10);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(false);
  });

  it('returns true when morningBrief published earlier today', () => {
    const pubAt = epochAtKyiv(2026, 4, 24, 7);
    insertRun('morningBrief', pubAt, 'publish');
    const now = epochAtKyiv(2026, 4, 24, 11);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(true);
  });

  it('returns false when last publish was yesterday', () => {
    const pubAt = epochAtKyiv(2026, 4, 23, 7);
    insertRun('morningBrief', pubAt, 'publish');
    const now = epochAtKyiv(2026, 4, 24, 11);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(false);
  });

  it('returns false when only "skip" or "error" outcomes exist today', () => {
    insertRun('morningBrief', epochAtKyiv(2026, 4, 24, 7), 'skip');
    insertRun('morningBrief', epochAtKyiv(2026, 4, 24, 8), 'error');
    const now = epochAtKyiv(2026, 4, 24, 11);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(false);
  });
});

describe('formatDigest', () => {
  const mk = (importance: number, from = 'Alice <a@b.com>', subject = 'Hi', snippet = 'Hello world') => ({
    id: 1, account_id: 'acc', message_uid: 1, from_addr: from, subject, snippet,
    importance, received_at: 1000, added_at: 1000, delivered_at: null,
  });

  it('renders count line + emoji + score + sender + summary', () => {
    const out = formatDigest([mk(5), mk(4, 'Bob <b@c>', 'Call', 'let us meet tomorrow')]);
    expect(out).toContain('📬');
    expect(out).toContain('2 важных');
    expect(out).toContain('🔴 [5]');
    expect(out).toContain('🟠 [4]');
    expect(out).toContain('Alice');
    expect(out).toContain('Bob');
  });

  it('truncates snippet to 140 chars', () => {
    const long = 'x'.repeat(300);
    const out = formatDigest([mk(5, 'A <a@b>', 'S', long)]);
    const line = out.split('\n').find((l) => l.includes('[5]'))!;
    expect(line.length).toBeLessThan(300);
  });

  it('returns under 2000 chars and appends "…ещё N" tail when overflowing', () => {
    const many = Array.from({ length: 50 }, (_, i) => mk(5, `X${i} <x@y>`, `S${i}`, 'a'.repeat(100)));
    const out = formatDigest(many);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toMatch(/ещё\s+\d+\s+писем/);
  });

  it('strips <email> tail from sender', () => {
    const out = formatDigest([mk(5, 'Alice <alice@bank.com>', 'S', 'txt')]);
    expect(out).toContain('Alice');
    expect(out).not.toContain('<alice@bank.com>');
  });
});
