import type Database from 'better-sqlite3';
import type { EmailPendingRow } from '../../emails/types.js';

const DISCORD_MAX = 2000;
const SUMMARY_CHARS = 140;
const TAIL_BUDGET = 50;
// If no morning-brief publish row exists within this window, fall back to a
// fixed morning release hour. Prevents the digest from being permanently
// gated on a handler that may never register (Discord bot off) or that may
// consistently error out.
const MORNING_BRIEF_LOOKBACK_DAYS = 7;
const MORNING_FALLBACK_HOUR = 9;

function localParts(epochMs: number, tz: string): { year: number; month: number; day: number; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
  };
}

function sameLocalDay(a: number, b: number, tz: string): boolean {
  const pa = localParts(a, tz);
  const pb = localParts(b, tz);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

export function inQuietHours(now: number, quietStart: number, tz: string): boolean {
  // Only the evening quiet-window is enforced here. The morning "hold" is
  // handled by morningBriefPublishedToday — once the brief goes out, the
  // digest is free to fire.
  const { hour } = localParts(now, tz);
  return hour >= quietStart;
}

export function morningBriefPublishedToday(db: Database.Database, now: number, tz: string): boolean {
  const row = db
    .prepare(
      "SELECT MAX(fired_at) AS ts FROM cognition_handler_runs WHERE handler_name='morningBrief' AND outcome='publish'",
    )
    .get() as { ts: number | null } | undefined;
  if (row?.ts && sameLocalDay(row.ts, now, tz)) return true;

  // Fallback: if morningBrief has not published anything recently, don't let
  // the email digest hang forever. Treat MORNING_FALLBACK_HOUR local as the
  // "release" time, so digests can still go out once the morning window opens.
  const lookbackMs = MORNING_BRIEF_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  if (!row?.ts || now - row.ts > lookbackMs) {
    return localParts(now, tz).hour >= MORNING_FALLBACK_HOUR;
  }
  return false;
}

function cleanSender(from: string): string {
  const m = from.match(/^(.+?)\s*<[^>]+>\s*$/);
  if (m && m[1].trim()) return m[1].trim();
  return from;
}

function emojiFor(importance: number): string {
  if (importance >= 5) return '🔴';
  if (importance >= 4) return '🟠';
  return '🟡';
}

function line(row: EmailPendingRow): string {
  const sender = cleanSender(row.from_addr);
  const subject = (row.subject || '(без темы)').replace(/\s+/g, ' ').trim();
  const summary = (row.snippet || '').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_CHARS);
  return `${emojiFor(row.importance)} [${row.importance}] ${sender} — ${subject}: ${summary}`;
}

export interface FormattedDigest {
  text: string;
  includedIds: number[];
}

export function formatDigest(rows: EmailPendingRow[]): FormattedDigest {
  const header = `📬 ${rows.length} важных писем`;
  const lines: string[] = [header, ''];
  let used = header.length + 2;
  const included: number[] = [];

  for (const r of rows) {
    const ln = line(r);
    const remaining = rows.length - included.length - 1;
    // Always reserve room for a "…ещё N писем" tail when more rows follow.
    // When this is the last row we still enforce the hard Discord limit.
    const reserve = remaining > 0 ? TAIL_BUDGET : 0;
    if (used + ln.length + 1 + reserve > DISCORD_MAX) break;
    lines.push(ln);
    used += ln.length + 1;
    included.push(r.id);
  }

  if (included.length < rows.length) {
    lines.push('');
    lines.push(`…ещё ${rows.length - included.length} писем`);
  }

  return { text: lines.join('\n'), includedIds: included };
}
