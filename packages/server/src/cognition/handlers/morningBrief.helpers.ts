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
