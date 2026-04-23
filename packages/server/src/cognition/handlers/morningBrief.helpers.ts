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

export function hasUserActivityInLastHour(
  db: Database.Database,
  now: number,
): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM chat_messages WHERE role = 'user' AND timestamp >= ? LIMIT 1",
    )
    .get(now - 3600_000);
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

export function computeGapDays(
  lastPublishAt: number | null,
  now: number,
  tz: string,
): number {
  if (lastPublishAt === null) return 0;
  const lastStart = getLocalCivilEpoch(lastPublishAt, tz);
  const todayStart = getLocalCivilEpoch(now, tz);
  if (todayStart <= lastStart) return 0;
  // Walk civil day boundaries from lastStart forward — DST-safe because
  // +26h always lands on the next local day (handles 23h/25h DST days),
  // and getLocalCivilEpoch normalizes back to local midnight.
  let days = 0;
  let cursor = lastStart;
  while (cursor < todayStart && days < 365) {
    cursor = getLocalCivilEpoch(cursor + 26 * 3600_000, tz);
    days++;
  }
  return days;
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
  gapDays: number;
  previousPeriod: PreviousPeriodBundle;
  previousPeriodFrom: number;
  previousPeriodTo: number;
}

export interface PreviousPeriodBundle {
  chat: ChatRow[];
  memoryCreated: Array<{ key: string; value: string; createdAt: number }>;
  memoryUpdated: Array<{ key: string; lastMentionedAt: number }>;
  memoryForgotten: Array<{ key: string; lastMentionedAt: number }>;
  audit: Array<{ toolName: string; result: string; createdAt: string; success: number }>;
  cognition: Array<{
    handlerName: string;
    firedAt: number;
    outcome: string;
    content: string | null;
  }>;
  remindersOverdue: Array<{ text: string; nextFireAt: number }>;
  remindersCreated: Array<{ text: string; createdAt: number }>;
}

const BUNDLE_CHAT_MAX = 80;
const BUNDLE_CHAT_CONTENT_MAX = 500;
const BUNDLE_MEMORY_MAX = 30;
const BUNDLE_MEMORY_VALUE_MAX = 300;
const BUNDLE_AUDIT_MAX = 20;
const BUNDLE_AUDIT_RESULT_MAX = 300;
const BUNDLE_COGNITION_MAX = 20;
const BUNDLE_COGNITION_CONTENT_MAX = 400;
const BUNDLE_REMINDERS_MAX = 20;
const BUNDLE_REMINDERS_OVERDUE_LOOKBACK_MS = 30 * 86400_000;
const AUDIT_HEAVY_TOOLS = ['code_task', 'code_deploy', 'eval_add', 'eval_run'];

function truncStr(s: string | null | undefined, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

// audit_log.created_at is stored as SQLite `datetime('now')` TEXT (UTC,
// "YYYY-MM-DD HH:MM:SS"). To filter by ms-epoch bounds, convert both bounds
// to the same string format — SQLite's lexicographic comparison matches
// chronological order for this format.
function epochToSqliteDateTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

export function gatherPreviousPeriod(
  db: Database.Database,
  from: number,
  to: number,
  // `overdueCutoff` controls only the reminders-overdue "as-of" bound:
  // overdue means "currently overdue", not "became overdue in-period". On a
  // normal morning `to = todayStart` (local midnight), so without a separate
  // cutoff a reminder due between midnight and brief time would be dropped.
  // Defaults to `to` so existing callers/tests keep prior behavior.
  overdueCutoff: number = to,
): PreviousPeriodBundle {
  // DESC + reverse keeps the NEWEST BUNDLE_CHAT_MAX rows when the period has
  // more messages than the cap, while preserving chronological display order.
  // ASC + LIMIT would keep the oldest, dropping the latest context the recap
  // needs most.
  const chatRaw = db
    .prepare(
      'SELECT role, content, timestamp AS ts FROM chat_messages WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?',
    )
    .all(from, to, BUNDLE_CHAT_MAX) as Array<{ role: string; content: string; ts: number }>;
  const chat: ChatRow[] = chatRaw.reverse().map((r) => ({
    role: r.role,
    ts: r.ts,
    content: truncStr(r.content, BUNDLE_CHAT_CONTENT_MAX),
  }));

  // `superseded_by IS NULL OR superseded_by = id` keeps the active row and
  // self-referenced forgotten rows but drops rows superseded by a newer one,
  // so when a user revises a fact in-period the recap shows only the final
  // value instead of every historical version of the same key.
  const memoryCreated = (
    db
      .prepare(
        'SELECT key, value, created_at AS createdAt FROM memory_facts WHERE created_at >= ? AND created_at < ? AND (superseded_by IS NULL OR superseded_by = id) ORDER BY created_at DESC LIMIT ?',
      )
      .all(from, to, BUNDLE_MEMORY_MAX) as Array<{
      key: string;
      value: string;
      createdAt: number;
    }>
  ).map((r) => ({ ...r, value: truncStr(r.value, BUNDLE_MEMORY_VALUE_MAX) }));

  // Mirror memoryCreated's supersede filter: without it, a fact that was
  // mentioned in-period and then revised later in the same period would show
  // up as both "created" (new row) and "updated" (superseded old row with
  // bumped last_mentioned_at) for the same key.
  const memoryUpdated = db
    .prepare(
      'SELECT key, last_mentioned_at AS lastMentionedAt FROM memory_facts WHERE last_mentioned_at >= ? AND last_mentioned_at < ? AND created_at < ? AND forgotten = 0 AND superseded_by IS NULL ORDER BY last_mentioned_at DESC LIMIT ?',
    )
    .all(from, to, from, BUNDLE_MEMORY_MAX) as Array<{
    key: string;
    lastMentionedAt: number;
  }>;

  // `created_at < from` keeps facts created+forgotten in the same period
  // out of memoryForgotten — they already appear in memoryCreated.
  const memoryForgotten = db
    .prepare(
      'SELECT key, last_mentioned_at AS lastMentionedAt FROM memory_facts WHERE forgotten = 1 AND last_mentioned_at >= ? AND last_mentioned_at < ? AND created_at < ? ORDER BY last_mentioned_at DESC LIMIT ?',
    )
    .all(from, to, from, BUNDLE_MEMORY_MAX) as Array<{
    key: string;
    lastMentionedAt: number;
  }>;

  const fromIso = epochToSqliteDateTime(from);
  const toIso = epochToSqliteDateTime(to);
  const placeholders = AUDIT_HEAVY_TOOLS.map(() => '?').join(',');
  const auditRaw = db
    .prepare(
      `SELECT tool_name AS toolName, result, created_at AS createdAt, success FROM audit_log WHERE tool_name IN (${placeholders}) AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...AUDIT_HEAVY_TOOLS, fromIso, toIso, BUNDLE_AUDIT_MAX) as Array<{
    toolName: string;
    result: string;
    createdAt: string;
    success: number;
  }>;
  const audit = auditRaw.map((r) => ({
    ...r,
    result: truncStr(r.result, BUNDLE_AUDIT_RESULT_MAX),
  }));

  const cognitionRaw = db
    .prepare(
      "SELECT handler_name AS handlerName, fired_at AS firedAt, outcome, content FROM cognition_handler_runs WHERE handler_name != 'morningBrief' AND fired_at >= ? AND fired_at < ? ORDER BY fired_at DESC LIMIT ?",
    )
    .all(from, to, BUNDLE_COGNITION_MAX) as Array<{
    handlerName: string;
    firedAt: number;
    outcome: string;
    content: string | null;
  }>;
  const cognition = cognitionRaw.map((r) => ({
    ...r,
    content: r.content ? truncStr(r.content, BUNDLE_COGNITION_CONTENT_MAX) : null,
  }));

  const remindersOverdue = db
    .prepare(
      'SELECT text, next_fire_at_ms AS nextFireAt FROM reminders WHERE active = 1 AND next_fire_at_ms < ? AND next_fire_at_ms >= ? ORDER BY next_fire_at_ms DESC LIMIT ?',
    )
    .all(
      overdueCutoff,
      overdueCutoff - BUNDLE_REMINDERS_OVERDUE_LOOKBACK_MS,
      BUNDLE_REMINDERS_MAX,
    ) as Array<{
    text: string;
    nextFireAt: number;
  }>;

  const remindersCreated = db
    .prepare(
      'SELECT text, created_at AS createdAt FROM reminders WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(from, to, BUNDLE_REMINDERS_MAX) as Array<{ text: string; createdAt: number }>;

  return {
    chat,
    memoryCreated,
    memoryUpdated,
    memoryForgotten,
    audit,
    cognition,
    remindersOverdue,
    remindersCreated,
  };
}

const MAX_BUNDLE_CHARS = 12000;
const MAX_BUNDLE_PREFIX_RESERVE = 80;

// Russian plural agreement for "день": 1 день, 2-4 дня, 5+ дней.
// Special case: 11-14 always take "дней" regardless of last digit.
export function pluralizeDays(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return `${n} дней`;
  if (mod10 === 1) return `${n} день`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} дня`;
  return `${n} дней`;
}

function renderSection(title: string, lines: string[]): string | null {
  if (lines.length === 0) return null;
  return `### ${title}\n${lines.join('\n')}`;
}

export function renderPreviousPeriod(
  bundle: PreviousPeriodBundle,
  tz: string,
): string {
  const sections: string[] = [];

  const chatLines = bundle.chat.map(
    (c) => `- [${formatLocal(c.ts, tz)}] ${c.role}: ${c.content}`,
  );
  const chatSec = renderSection('Chat', chatLines);
  if (chatSec) sections.push(chatSec);

  const memLines: string[] = [];
  for (const r of bundle.memoryCreated) memLines.push(`- created: ${r.key} = ${r.value}`);
  for (const r of bundle.memoryUpdated) memLines.push(`- updated: ${r.key}`);
  for (const r of bundle.memoryForgotten) memLines.push(`- forgotten: ${r.key}`);
  const memSec = renderSection('Memory изменения', memLines);
  if (memSec) sections.push(memSec);

  const toolLines = bundle.audit.map(
    (a) =>
      `- [${a.createdAt}] ${a.toolName}${a.success === 0 ? ' (fail)' : ''}: ${a.result}`,
  );
  const toolSec = renderSection('Tool runs', toolLines);
  if (toolSec) sections.push(toolSec);

  const cogLines = bundle.cognition.map(
    (c) =>
      `- [${formatLocal(c.firedAt, tz)}] ${c.handlerName} (${c.outcome})${c.content ? ': ' + c.content : ''}`,
  );
  const cogSec = renderSection('Cognition runs', cogLines);
  if (cogSec) sections.push(cogSec);

  const ovdLines = bundle.remindersOverdue.map(
    (r) => `- [${formatLocal(r.nextFireAt, tz)}] ${r.text}`,
  );
  const ovdSec = renderSection('Reminders overdue', ovdLines);
  if (ovdSec) sections.push(ovdSec);

  const newRemLines = bundle.remindersCreated.map(
    (r) => `- [${formatLocal(r.createdAt, tz)}] ${r.text}`,
  );
  const newRemSec = renderSection('Reminders созданные', newRemLines);
  if (newRemSec) sections.push(newRemSec);

  if (sections.length === 0) return 'активности не было';

  const joined = sections.join('\n\n');
  if (joined.length <= MAX_BUNDLE_CHARS) return joined;
  // Tail-first trim: reserve room for the prefix marker so total stays under
  // MAX_BUNDLE_CHARS, then snap to the next newline so the first kept line
  // is whole (not a truncated mid-line fragment).
  const tailBudget = MAX_BUNDLE_CHARS - MAX_BUNDLE_PREFIX_RESERVE;
  const rawTail = joined.slice(joined.length - tailBudget);
  const firstNewline = rawTail.indexOf('\n');
  const trimmedTail = firstNewline === -1 ? rawTail : rawTail.slice(firstNewline + 1);
  const droppedChars = joined.length - trimmedTail.length;
  const approxDroppedLines = (joined.slice(0, droppedChars).match(/\n/g) ?? []).length;
  return `...и ${approxDroppedLines} событий раньше опущено\n${trimmedTail}`;
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

  const lastBriefPublishAt = getLastBriefPublishAt(db);
  const gapDays = computeGapDays(lastBriefPublishAt, now, tz);
  // With a prior publish on a normal morning (gapDays < 2): span
  //   [lastPublish, todayStart) — completed days only; today's activity stays
  //   in "Recent context (48h)".
  // Gap-return (gapDays >= 2) or first-run: span [from, now) — the bundle
  //   must include today, since gap-return is triggered by today's first
  //   message and that message belongs in the recap.
  const previousPeriodFrom = lastBriefPublishAt ?? now - 48 * 3600_000;
  const previousPeriodTo =
    lastBriefPublishAt !== null && gapDays < 2 ? todayStart : now;
  // Same-day republish: lastPublishAt > todayStart, so clamp to avoid an
  // inverted range (SQLite would return nothing but the helper would still
  // run 7 queries with nonsense bounds).
  const safeFrom = Math.min(previousPeriodFrom, previousPeriodTo);
  // Pass `now` as overdueCutoff: on a normal morning `previousPeriodTo =
  // todayStart`, but a reminder due between midnight and brief time is
  // currently overdue and must appear in the recap.
  const previousPeriod = gatherPreviousPeriod(db, safeFrom, previousPeriodTo, now);

  return {
    reminders,
    notes,
    recentContext,
    city,
    gapDays,
    previousPeriod,
    previousPeriodFrom: safeFrom,
    previousPeriodTo,
  };
}

export function formatLocal(ts: number, tz: string): string {
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

// Trigger Branch B and the gap preamble use the same threshold — keep them in
// sync so a brief that fires via the morning window after one missed day
// doesn't apologize for being away.
export const GAP_MODE_THRESHOLD = 2;

export function composePrompt(data: BriefData, tz: string): string {
  const cityLine = data.city
    ? `Город пользователя: ${data.city}.`
    : 'Город пользователя: не задан — погоду искать не нужно, напиши "город не задан".';

  const gapMode = data.gapDays >= GAP_MODE_THRESHOLD;
  const daysPhrase = pluralizeDays(data.gapDays);
  const gapPreamble = gapMode
    ? [
        `⚠️ Gap: ${data.gapDays} — начни ответ с "Пока меня не было ${daysPhrase}, вот что было".`,
        '',
      ].join('\n')
    : '';

  const periodHeader = `## Прошлый период (${formatLocal(data.previousPeriodFrom, tz)} — ${formatLocal(data.previousPeriodTo, tz)})`;
  const periodBody = renderPreviousPeriod(data.previousPeriod, tz);

  const todaySection = [
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
      'Recent context (48h)',
      data.recentContext.map(
        (c) => `- [${formatLocal(c.ts, tz)}] ${c.role}: ${c.content}`,
      ),
    ),
  ].join('\n');

  const todayGuide = gapMode
    ? `1. "Пока меня не было ${daysPhrase}..." — 2-4 строки выжимка периода\n2. Что висит — 1-5 пунктов, если нет — "висящего нет"\n3. Сегодня — 3-5 bullets: конкретно, не дневник`
    : '1. Что висит со вчера — 1-4 пункта, если нет — "вчера закрыто чисто"\n2. Сегодня — 3-5 bullets';

  return [
    `Собери утренний brief для dim (русский язык). Время — ${tz}. ${cityLine}`,
    '',
    gapPreamble,
    periodHeader,
    periodBody,
    '',
    '## Сегодня / завтра',
    todaySection,
    '',
    'Проанализируй прошлый период с разных углов. Найди:',
    '- что висит (вопросы без ответа, задачи без закрытия, overdue reminders)',
    '- что повторяется (одинаковые темы в чате, застрявшие решения)',
    '- что упустил (важное упомянуто мельком и пропало)',
    '',
    'Формат:',
    todayGuide,
    '',
    'Не пересказывай raw данные дословно — делай выводы. Предлагай конкретные действия где возможно.',
  ].join('\n');
}
