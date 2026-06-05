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

function insertRun(
  handlerName: string,
  firedAt: number,
  outcome: 'publish' | 'skip' | 'error',
  publishedAt?: number | null,
) {
  // For a 'publish' outcome, default published_at to firedAt (delivered) unless
  // explicitly passed null (generated but never delivered). skip/error rows are
  // always undelivered.
  const delivered =
    outcome === 'publish' ? (publishedAt === undefined ? firedAt : publishedAt) : null;
  getDb().prepare(
    'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome, published_at) VALUES (?, ?, ?, ?, ?)',
  ).run(handlerName, firedAt, 10, outcome, delivered);
}

describe('inQuietHours', () => {
  it('returns true at 23:00 local', () => {
    const now = epochAtKyiv(2026, 4, 24, 23);
    expect(inQuietHours(now, 22, TZ)).toBe(true);
  });

  it('returns false at 04:00 local — morning release is handled by morningBriefPublishedToday', () => {
    const now = epochAtKyiv(2026, 4, 24, 4);
    expect(inQuietHours(now, 22, TZ)).toBe(false);
  });

  it('returns false at 14:00 local', () => {
    const now = epochAtKyiv(2026, 4, 24, 14);
    expect(inQuietHours(now, 22, TZ)).toBe(false);
  });

  it('boundary: returns true exactly at quietStart', () => {
    const now = epochAtKyiv(2026, 4, 24, 22);
    expect(inQuietHours(now, 22, TZ)).toBe(true);
  });

  it('with morningEnd: returns true between midnight and morningEnd', () => {
    // Used by emailUrgent — it has no morning-brief gate, so it has to treat
    // 00:00..morningEnd as quiet on its own.
    const at3 = epochAtKyiv(2026, 4, 24, 3);
    expect(inQuietHours(at3, 22, TZ, 9)).toBe(true);
    const at8 = epochAtKyiv(2026, 4, 24, 8);
    expect(inQuietHours(at8, 22, TZ, 9)).toBe(true);
  });

  it('with morningEnd: returns false at morningEnd exactly (release)', () => {
    const at9 = epochAtKyiv(2026, 4, 24, 9);
    expect(inQuietHours(at9, 22, TZ, 9)).toBe(false);
  });

  it('with morningEnd: still returns true in the evening window', () => {
    const at23 = epochAtKyiv(2026, 4, 24, 23);
    expect(inQuietHours(at23, 22, TZ, 9)).toBe(true);
  });
});

describe('morningBriefPublishedToday', () => {
  it('returns true when morningBrief published earlier today', () => {
    const pubAt = epochAtKyiv(2026, 4, 24, 7);
    insertRun('morningBrief', pubAt, 'publish');
    const now = epochAtKyiv(2026, 4, 24, 11);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(true);
  });

  it('returns false when brief was generated today but NOT delivered (published_at NULL)', () => {
    // Network flap: brief generated (outcome=publish) but Discord was down, so
    // published_at stayed NULL. Must NOT count as out today — redelivery will
    // re-send it. A recent delivered brief exists (yesterday) so fallback is off.
    insertRun('morningBrief', epochAtKyiv(2026, 4, 23, 7), 'publish');
    insertRun('morningBrief', epochAtKyiv(2026, 4, 24, 7), 'publish', null);
    const now = epochAtKyiv(2026, 4, 24, 11);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(false);
  });

  it('returns true once an undelivered brief is redelivered today (published_at stamped)', () => {
    insertRun('morningBrief', epochAtKyiv(2026, 4, 24, 7), 'publish', epochAtKyiv(2026, 4, 24, 8));
    const now = epochAtKyiv(2026, 4, 24, 11);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(true);
  });

  it('falls back to release hour when the only brief today is undelivered and none ever delivered', () => {
    // No delivered brief has ever existed, so MAX(fired_at) over delivered rows
    // is NULL → fallback to MORNING_FALLBACK_HOUR. At 11:00 that releases.
    insertRun('morningBrief', epochAtKyiv(2026, 4, 24, 7), 'publish', null);
    const now = epochAtKyiv(2026, 4, 24, 11);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(true);
  });

  it('returns false when last publish was yesterday and before 09:00 local today', () => {
    const pubAt = epochAtKyiv(2026, 4, 23, 7);
    insertRun('morningBrief', pubAt, 'publish');
    const now = epochAtKyiv(2026, 4, 24, 6);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(false);
  });

  it('returns false when only "skip"/"error" today but a recent successful publish exists', () => {
    // Brief has been working (published 2 days ago), so the fallback does NOT
    // kick in — we wait for today's brief to succeed instead of releasing early.
    insertRun('morningBrief', epochAtKyiv(2026, 4, 22, 7), 'publish');
    insertRun('morningBrief', epochAtKyiv(2026, 4, 24, 7), 'skip');
    insertRun('morningBrief', epochAtKyiv(2026, 4, 24, 8), 'error');
    const now = epochAtKyiv(2026, 4, 24, 11);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(false);
  });

  it('fallback: returns true at/after 09:00 local when no publish in last 7 days', () => {
    const now = epochAtKyiv(2026, 4, 24, 9);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(true);
  });

  it('fallback: returns false before 09:00 local when no publish rows exist', () => {
    const now = epochAtKyiv(2026, 4, 24, 6);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(false);
  });

  it('fallback kicks in if last publish was >7 days ago', () => {
    const pubAt = epochAtKyiv(2026, 4, 10, 7);
    insertRun('morningBrief', pubAt, 'publish');
    const now = epochAtKyiv(2026, 4, 24, 10);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(true);
  });

  it('no fallback when last publish was within 7d but not today — must wait for next brief', () => {
    const pubAt = epochAtKyiv(2026, 4, 23, 7);
    insertRun('morningBrief', pubAt, 'publish');
    const now = epochAtKyiv(2026, 4, 24, 10);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(false);
  });
});

describe('formatDigest', () => {
  const mk = (id: number, importance: number, from = 'Alice <a@b.com>', subject = 'Hi', snippet = 'Hello world') => ({
    id, account_id: 'acc', message_uid: id, from_addr: from, subject, snippet,
    importance, received_at: 1000, added_at: 1000, delivered_at: null,
    urgent_pinged_at: null,
  });

  it('renders count line + emoji + score + sender + summary', () => {
    const out = formatDigest([mk(1, 5), mk(2, 4, 'Bob <b@c>', 'Call', 'let us meet tomorrow')]);
    expect(out.text).toContain('📬');
    expect(out.text).toContain('2 важных');
    expect(out.text).toContain('🔴 [5]');
    expect(out.text).toContain('🟠 [4]');
    expect(out.text).toContain('Alice');
    expect(out.text).toContain('Bob');
    expect(out.includedIds).toEqual([1, 2]);
  });

  it('truncates snippet to 140 chars', () => {
    const long = 'x'.repeat(300);
    const out = formatDigest([mk(1, 5, 'A <a@b>', 'S', long)]);
    const ln = out.text.split('\n').find((l) => l.includes('[5]'))!;
    // Line = "🟡 [5] A — S: " + snippet. Prefix is well under 60 chars, and
    // SUMMARY_CHARS=140, so a full line stays under ~210. Loosening this to
    // < 300 would let a regression doubling the snippet go undetected.
    expect(ln.length).toBeLessThan(220);
    // Also assert the actual snippet portion does not exceed SUMMARY_CHARS —
    // and is non-empty, so a regression that drops the snippet entirely fails.
    const snippetPart = ln.split(': ').slice(1).join(': ');
    expect(snippetPart.length).toBeGreaterThan(0);
    expect(snippetPart).toBe('x'.repeat(140));
    expect(snippetPart.length).toBeLessThanOrEqual(140);
  });

  it('returns under 2000 chars and appends "…ещё N" tail with exact count', () => {
    const many = Array.from({ length: 50 }, (_, i) => mk(i + 1, 5, `X${i} <x@y>`, `S${i}`, 'a'.repeat(100)));
    const out = formatDigest(many);
    expect(out.text.length).toBeLessThanOrEqual(2000);
    const dropped = 50 - out.includedIds.length;
    expect(out.text).toContain(`…ещё ${dropped} писем`);
    expect(out.includedIds.length).toBeLessThan(50);
  });

  it('only included ids are returned — rows folded into tail are NOT marked delivered', () => {
    const many = Array.from({ length: 50 }, (_, i) => mk(i + 1, 5, `X <x@y>`, `S`, 'a'.repeat(100)));
    const out = formatDigest(many);
    const includedSet = new Set(out.includedIds);
    const dropped = many.map((r) => r.id).filter((id) => !includedSet.has(id));
    expect(dropped.length).toBeGreaterThan(0);
    expect(out.includedIds.length + dropped.length).toBe(50);
  });

  it('single-row boundary: never exceeds 2000 chars even with one row left', () => {
    const huge = 'a'.repeat(1990);
    const out = formatDigest([mk(1, 5, 'A <a@b>', 'S', huge)]);
    expect(out.text.length).toBeLessThanOrEqual(2000);
  });

  it('strips <email> tail from sender', () => {
    const out = formatDigest([mk(1, 5, 'Alice <alice@bank.com>', 'S', 'txt')]);
    expect(out.text).toContain('Alice');
    expect(out.text).not.toContain('<alice@bank.com>');
  });

  it('uses totalPending for header and tail count when backlog exceeds rows slice', () => {
    // Store returned a 50-row slice, but 80 rows are actually pending. Header
    // must say 80, and "…ещё N" must reflect true backlog (80 - included).
    const rows = Array.from({ length: 50 }, (_, i) => mk(i + 1, 5));
    const out = formatDigest(rows, 80);
    expect(out.text).toContain('📬 80 важных писем');
    const included = out.includedIds.length;
    expect(out.text).toContain(`…ещё ${80 - included} писем`);
  });

  it('falls back to rows.length when totalPending is undefined or smaller', () => {
    const rows = [mk(1, 5), mk(2, 4)];
    const withUndef = formatDigest(rows);
    expect(withUndef.text).toContain('📬 2 важных');
    const withSmaller = formatDigest(rows, 1);
    expect(withSmaller.text).toContain('📬 2 важных');
  });
});
