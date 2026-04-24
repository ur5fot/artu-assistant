import type Database from 'better-sqlite3';
import type { EmailPendingRow } from '../../emails/types.js';

const DISCORD_MAX = 2000;
const SUMMARY_CHARS = 140;

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
  const { hour } = localParts(now, tz);
  return hour >= quietStart || hour < 10;
}

export function morningBriefPublishedToday(db: Database.Database, now: number, tz: string): boolean {
  const row = db
    .prepare(
      "SELECT MAX(fired_at) AS ts FROM cognition_handler_runs WHERE handler_name='morningBrief' AND outcome='publish'",
    )
    .get() as { ts: number | null } | undefined;
  if (!row?.ts) return false;
  return sameLocalDay(row.ts, now, tz);
}

function cleanSender(from: string): string {
  const m = from.match(/^(.+?)\s*<[^>]+>$/);
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

export function formatDigest(rows: EmailPendingRow[]): string {
  const header = `📬 ${rows.length} важных писем`;
  const lines: string[] = [header, ''];
  let used = header.length + 2;
  let included = 0;

  for (const r of rows) {
    const ln = line(r);
    // Keep a budget for possible "…ещё N писем" tail (~50 chars).
    if (used + ln.length + 1 + 50 > DISCORD_MAX && rows.length - included > 1) break;
    lines.push(ln);
    used += ln.length + 1;
    included += 1;
  }

  if (included < rows.length) {
    lines.push('');
    lines.push(`…ещё ${rows.length - included} писем`);
  }

  return lines.join('\n');
}
