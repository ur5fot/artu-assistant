import type Database from 'better-sqlite3';

export function getTodayStartLocal(now: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const hh = Number(get('hour'));
  const mm = Number(get('minute'));
  const ss = Number(get('second'));
  return now - hh * 3600_000 - mm * 60_000 - ss * 1000 - (now % 1000);
}

export function isSameLocalDate(a: number, b: number, tz: string): boolean {
  return localDateKey(a, tz) === localDateKey(b, tz);
}

function localDateKey(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts));
}

export function hasUserActivityToday(
  db: Database.Database,
  now: number,
  tz: string,
): boolean {
  const todayStart = getTodayStartLocal(now, tz);
  const row = db
    .prepare(
      "SELECT 1 FROM chat_messages WHERE role = 'user' AND timestamp >= ? LIMIT 1",
    )
    .get(todayStart);
  return row !== undefined;
}

export interface ReminderRow {
  text: string;
  nextFireAt: number;
}

export interface NoteRow {
  key: string;
  value: string;
  lastMentionedAt: number;
}

export interface ChatRow {
  role: string;
  content: string;
  ts: number;
}

export interface BriefData {
  reminders: ReminderRow[];
  notes: NoteRow[];
  recentContext: ChatRow[];
}

const NOTE_FRESHNESS_MS = 14 * 86400_000;
const RECENT_CONTEXT_HOURS = 48;
const RECENT_CONTEXT_MAX_ROWS = 30;
const CONTENT_TRUNCATE_CHARS = 500;

export function gatherData(
  db: Database.Database,
  now: number,
  tz: string,
): BriefData {
  const todayStart = getTodayStartLocal(now, tz);
  const tomorrowEnd = todayStart + 2 * 86400_000;

  const reminders = db
    .prepare(
      'SELECT text, next_fire_at_ms AS nextFireAt FROM reminders WHERE active = 1 AND next_fire_at_ms >= ? AND next_fire_at_ms <= ? ORDER BY next_fire_at_ms',
    )
    .all(todayStart, tomorrowEnd) as ReminderRow[];

  const notes = db
    .prepare(
      'SELECT key, value, last_mentioned_at AS lastMentionedAt FROM memory_facts WHERE superseded_by IS NULL AND last_mentioned_at >= ? ORDER BY last_mentioned_at DESC',
    )
    .all(now - NOTE_FRESHNESS_MS) as NoteRow[];

  const rawChat = db
    .prepare(
      'SELECT role, content, timestamp AS ts FROM chat_messages WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?',
    )
    .all(now - RECENT_CONTEXT_HOURS * 3600_000, RECENT_CONTEXT_MAX_ROWS) as Array<{
    role: string;
    content: string;
    ts: number;
  }>;

  const recentContext: ChatRow[] = rawChat.map((r) => ({
    role: r.role,
    ts: r.ts,
    content:
      r.content.length > CONTENT_TRUNCATE_CHARS
        ? r.content.slice(0, CONTENT_TRUNCATE_CHARS)
        : r.content,
  }));

  return { reminders, notes, recentContext };
}
