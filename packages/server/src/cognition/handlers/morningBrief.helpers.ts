import type Database from 'better-sqlite3';

function tzOffsetMs(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));
  const p: Record<string, number> = {};
  for (const part of parts) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - ts;
}

// Compute epoch ms for a civil local instant (`dayOffset` days from today's
// local date, at `hour`:00) in `tz`. DST-aware: re-derives the offset at the
// target instant, not at `now` — so `hour=6` on a spring-forward day still
// resolves to 06:00 local, not 07:00.
export function getLocalCivilEpoch(
  now: number,
  tz: string,
  dayOffset = 0,
  hour = 0,
): number {
  const [y, m, d] = localDateKey(now, tz).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d + dayOffset, hour);
  return guess - tzOffsetMs(guess, tz);
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

export function hasUserActivitySince(
  db: Database.Database,
  since: number,
): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM chat_messages WHERE role = 'user' AND timestamp >= ? LIMIT 1",
    )
    .get(since);
  return row !== undefined;
}

export function getLastBriefPublishAt(db: Database.Database): number | null {
  const row = db
    .prepare(
      "SELECT MAX(fired_at) AS ts FROM cognition_handler_runs WHERE handler_name = 'morningBrief' AND outcome = 'publish'",
    )
    .get() as { ts: number | null } | undefined;
  return row?.ts ?? null;
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
  city: string | null;
}

const NOTE_FRESHNESS_MS = 14 * 86400_000;
const NOTE_MAX_ROWS = 50;
const NOTE_VALUE_TRUNCATE_CHARS = 300;
const RECENT_CONTEXT_HOURS = 48;
const RECENT_CONTEXT_MAX_ROWS = 30;
const CONTENT_TRUNCATE_CHARS = 500;

export function gatherData(
  db: Database.Database,
  now: number,
  tz: string,
): BriefData {
  const todayStart = getLocalCivilEpoch(now, tz);
  // Exclusive upper bound at local midnight of day-after-tomorrow, DST-aware
  // (can't just add 48h — DST days are 23h/25h long).
  const dayAfterTomorrowStart = getLocalCivilEpoch(now, tz, 2);

  const reminders = db
    .prepare(
      'SELECT text, next_fire_at_ms AS nextFireAt FROM reminders WHERE active = 1 AND next_fire_at_ms >= ? AND next_fire_at_ms < ? ORDER BY next_fire_at_ms',
    )
    .all(todayStart, dayAfterTomorrowStart) as ReminderRow[];

  // LIMIT + value truncation keeps the prompt bounded even when memory_facts
  // grows. Without them, a runaway fact count or a single very long value
  // could silently inflate tokens per morning brief.
  const rawNotes = db
    .prepare(
      'SELECT key, value, last_mentioned_at AS lastMentionedAt FROM memory_facts WHERE superseded_by IS NULL AND forgotten = 0 AND last_mentioned_at >= ? ORDER BY last_mentioned_at DESC LIMIT ?',
    )
    .all(now - NOTE_FRESHNESS_MS, NOTE_MAX_ROWS) as NoteRow[];
  const notes: NoteRow[] = rawNotes.map((n) => ({
    key: n.key,
    lastMentionedAt: n.lastMentionedAt,
    value:
      n.value.length > NOTE_VALUE_TRUNCATE_CHARS
        ? n.value.slice(0, NOTE_VALUE_TRUNCATE_CHARS)
        : n.value,
  }));

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

  // Lookup city by-passing the 14-day freshness window: location rarely gets
  // re-mentioned, but weather-related tools need it every morning.
  const cityRow = db
    .prepare(
      "SELECT value FROM memory_facts WHERE key IN ('user.city','user.location') AND superseded_by IS NULL AND forgotten = 0 ORDER BY key = 'user.city' DESC, last_mentioned_at DESC LIMIT 1",
    )
    .get() as { value: string } | undefined;
  const city = cityRow?.value ?? null;

  return { reminders, notes, recentContext, city };
}

function formatLocal(ts: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));
  const p: Record<string, string> = {};
  for (const part of parts) if (part.type !== 'literal') p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function section(title: string, rows: string[]): string {
  const body = rows.length > 0 ? rows.join('\n') : 'нет';
  return `## ${title}\n${body}`;
}

export function composePrompt(data: BriefData, tz: string): string {
  const cityLine = data.city
    ? `Город пользователя: ${data.city}.`
    : 'Город пользователя: не задан — погоду искать не нужно, напиши "город не задан".';
  return [
    `Собери утренний brief для dim (русский язык). Время — ${tz}. ${cityLine}`,
    '',
    section(
      'Reminders на сегодня/завтра',
      data.reminders.map((r) => `- ${formatLocal(r.nextFireAt, tz)}: ${r.text}`),
    ),
    '',
    section(
      'Открытые заметки',
      data.notes.map((n) => `- ${n.key}: ${n.value}`),
    ),
    '',
    section(
      'Recent context',
      data.recentContext.map(
        (c) => `- [${formatLocal(c.ts, tz)}] ${c.role}: ${c.content}`,
      ),
    ),
    '',
    'Формат: 5-8 bullet points. Включи: (1) что конкретно на сегодня, (2) открытые темы которые висят, (3) конкретные предложения действий. Коротко. Не повторяй данные дословно — анализируй.',
  ].join('\n');
}
