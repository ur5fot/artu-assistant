import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../../db.js';
import {
  getTodayStartLocal,
  getLocalCivilEpoch,
  isSameLocalDate,
  hasUserActivityToday,
  gatherData,
  composePrompt,
} from '../../handlers/morningBrief.helpers.js';

const TZ = 'Europe/Kyiv';

beforeEach(() => initDb(':memory:'));

describe('getTodayStartLocal', () => {
  it('returns midnight of same local date as `now`', () => {
    const now = Date.UTC(2026, 3, 18, 14, 30, 0);
    const startLocal = getTodayStartLocal(now, TZ);
    expect(new Date(startLocal).toISOString()).toBe('2026-04-17T21:00:00.000Z');
  });

  it('handles pre-midnight UTC correctly (Kyiv ahead of UTC)', () => {
    const now = Date.UTC(2026, 3, 18, 23, 30, 0);
    const startLocal = getTodayStartLocal(now, TZ);
    expect(new Date(startLocal).toISOString()).toBe('2026-04-18T21:00:00.000Z');
  });

  it('handles spring-forward DST day (Kyiv UTC+2 pre-transition)', () => {
    // 2026-03-29 is spring-forward in Europe/Kyiv (03:00 → 04:00 local).
    // `now` at 08:00 Kyiv = 05:00 UTC (post-transition, UTC+3).
    const now = Date.UTC(2026, 2, 29, 5, 0, 0);
    const startLocal = getTodayStartLocal(now, TZ);
    // Local midnight 2026-03-29 Kyiv = 22:00 UTC 2026-03-28 (pre-DST UTC+2).
    expect(new Date(startLocal).toISOString()).toBe('2026-03-28T22:00:00.000Z');
  });

  it('handles fall-back DST day (Kyiv UTC+3 pre-transition)', () => {
    // 2026-10-25 is fall-back in Europe/Kyiv (04:00 → 03:00 local).
    // `now` at 10:00 Kyiv = 08:00 UTC (post-transition, UTC+2).
    const now = Date.UTC(2026, 9, 25, 8, 0, 0);
    const startLocal = getTodayStartLocal(now, TZ);
    // Local midnight 2026-10-25 Kyiv = 21:00 UTC 2026-10-24 (pre-DST UTC+3).
    expect(new Date(startLocal).toISOString()).toBe('2026-10-24T21:00:00.000Z');
  });
});

describe('getLocalCivilEpoch', () => {
  it('returns local 06:00 on a standard day', () => {
    // now at 14:30 UTC → 17:30 Kyiv (UTC+3 summer). 06:00 Kyiv = 03:00 UTC.
    const now = Date.UTC(2026, 3, 18, 14, 30, 0);
    const six = getLocalCivilEpoch(now, TZ, 0, 6);
    expect(new Date(six).toISOString()).toBe('2026-04-18T03:00:00.000Z');
  });

  it('returns civil 06:00 on spring-forward DST day (not midnight+6h)', () => {
    // 2026-03-29: Kyiv 03:00→04:00 local. Civil 06:00 Kyiv = 03:00 UTC (post-
    // transition, UTC+3). Naive todayStart + 6h would give 04:00 UTC = 07:00
    // local. Verify we pick civil 06:00, not shifted.
    const now = Date.UTC(2026, 2, 29, 5, 0, 0); // 08:00 Kyiv post-transition
    const six = getLocalCivilEpoch(now, TZ, 0, 6);
    expect(new Date(six).toISOString()).toBe('2026-03-29T03:00:00.000Z');
    // And verify the naive computation would have been wrong.
    const naive = getTodayStartLocal(now, TZ) + 6 * 3600_000;
    expect(new Date(naive).toISOString()).toBe('2026-03-29T04:00:00.000Z');
  });

  it('returns civil 06:00 on fall-back DST day', () => {
    // 2026-10-25: Kyiv 04:00→03:00 local. Civil 06:00 Kyiv = 04:00 UTC (post-
    // transition, UTC+2). Naive midnight+6h would give 03:00 UTC = 05:00 local.
    const now = Date.UTC(2026, 9, 25, 8, 0, 0); // 10:00 Kyiv post-transition
    const six = getLocalCivilEpoch(now, TZ, 0, 6);
    expect(new Date(six).toISOString()).toBe('2026-10-25T04:00:00.000Z');
    const naive = getTodayStartLocal(now, TZ) + 6 * 3600_000;
    expect(new Date(naive).toISOString()).toBe('2026-10-25T03:00:00.000Z');
  });

  it('returns local midnight of day-after-tomorrow (dayOffset=2), DST-aware', () => {
    // now on 2026-03-28 (day before spring-forward). Day-after-tomorrow start =
    // midnight Kyiv 2026-03-30 = 21:00 UTC 2026-03-29 (UTC+3, post-DST).
    // Naive `todayStart + 48h` would be off by 1h.
    const now = Date.UTC(2026, 2, 28, 12, 0, 0);
    const dayAfterTomorrow = getLocalCivilEpoch(now, TZ, 2);
    expect(new Date(dayAfterTomorrow).toISOString()).toBe(
      '2026-03-29T21:00:00.000Z',
    );
  });
});

describe('isSameLocalDate', () => {
  it('returns true for two timestamps on same local date', () => {
    const a = Date.UTC(2026, 3, 18, 4, 0, 0);
    const b = Date.UTC(2026, 3, 18, 20, 0, 0);
    expect(isSameLocalDate(a, b, TZ)).toBe(true);
  });

  it('returns false across local midnight even if within 24h', () => {
    const a = Date.UTC(2026, 3, 18, 20, 0, 0);
    const b = Date.UTC(2026, 3, 18, 22, 30, 0);
    expect(isSameLocalDate(a, b, TZ)).toBe(false);
  });
});

describe('hasUserActivityToday', () => {
  it('returns false when chat_messages has no rows since today_start', () => {
    const now = Date.UTC(2026, 3, 18, 6, 0, 0);
    expect(hasUserActivityToday(getDb(), now, TZ)).toBe(false);
  });

  it('returns true when at least one user message exists after today_start', () => {
    const now = Date.UTC(2026, 3, 18, 6, 0, 0);
    const ts = Date.UTC(2026, 3, 18, 4, 0, 0);
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', 'hi', ?)",
      )
      .run(`m-${ts}`, ts);
    expect(hasUserActivityToday(getDb(), now, TZ)).toBe(true);
  });

  it('ignores messages from previous local day', () => {
    const now = Date.UTC(2026, 3, 18, 6, 0, 0);
    const ts = Date.UTC(2026, 3, 17, 20, 0, 0);
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', 'hi', ?)",
      )
      .run(`m-${ts}`, ts);
    expect(hasUserActivityToday(getDb(), now, TZ)).toBe(false);
  });

  it('ignores assistant messages (only user role counts)', () => {
    const now = Date.UTC(2026, 3, 18, 6, 0, 0);
    const ts = Date.UTC(2026, 3, 18, 4, 0, 0);
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'assistant', 'hi', ?)",
      )
      .run(`m-${ts}`, ts);
    expect(hasUserActivityToday(getDb(), now, TZ)).toBe(false);
  });
});

describe('gatherData', () => {
  const now = Date.UTC(2026, 3, 18, 6, 0, 0); // 09:00 Kyiv 18th

  it('returns reminders active=1 with next_fire_at_ms in today+tomorrow window', () => {
    const todayStart = Date.UTC(2026, 3, 17, 21, 0, 0); // 00:00 Kyiv 18th
    const tomorrowEnd = Date.UTC(2026, 3, 19, 21, 0, 0); // 00:00 Kyiv 20th

    const db = getDb();
    const insert = db.prepare(
      "INSERT INTO reminders (text, schedule_json, next_fire_at_ms, active, created_at) VALUES (?, '{}', ?, ?, ?)",
    );
    insert.run('in-window today', todayStart + 5 * 3600_000, 1, now);
    insert.run('in-window tomorrow', tomorrowEnd - 2 * 3600_000, 1, now);
    insert.run('past', todayStart - 3600_000, 1, now);
    insert.run('too far', tomorrowEnd + 3600_000, 1, now);
    insert.run('disabled in-window', todayStart + 4 * 3600_000, 0, now);

    const data = gatherData(db, now, TZ);
    expect(data.reminders.map((r) => r.text).sort()).toEqual([
      'in-window today',
      'in-window tomorrow',
    ]);
  });

  it('returns active memory_facts with last_mentioned_at within 14d', () => {
    const db = getDb();
    const insert = db.prepare(
      'INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, superseded_by) VALUES (?, ?, ?, ?, ?)',
    );
    insert.run('user.activity', 'велосипед', now - 10 * 86400_000, now - 2 * 86400_000, null);
    insert.run('user.age', '42', now - 30 * 86400_000, now - 30 * 86400_000, null); // stale
    insert.run('user.note.x', 'нужно на работу', now, now, null);
    const oldRes = insert.run('user.old', 'old', now, now, null);
    const newerRes = insert.run('user.newer', 'newer', now, now, null);
    db.prepare('UPDATE memory_facts SET superseded_by = ? WHERE id = ?').run(
      newerRes.lastInsertRowid,
      oldRes.lastInsertRowid,
    );

    const data = gatherData(db, now, TZ);
    const keys = data.notes.map((n) => n.key).sort();
    expect(keys).toContain('user.activity');
    expect(keys).toContain('user.note.x');
    expect(keys).toContain('user.newer');
    expect(keys).not.toContain('user.age');
    expect(keys).not.toContain('user.old');
  });

  it('excludes memory_facts marked forgotten=1', () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, superseded_by, forgotten) VALUES (?, ?, ?, ?, NULL, ?)',
    ).run('user.kept', 'v', now, now, 0);
    db.prepare(
      'INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, superseded_by, forgotten) VALUES (?, ?, ?, ?, NULL, ?)',
    ).run('user.forgotten', 'v', now, now, 1);

    const keys = gatherData(db, now, TZ).notes.map((n) => n.key);
    expect(keys).toContain('user.kept');
    expect(keys).not.toContain('user.forgotten');
  });

  it('returns recent chat messages last 48h, max 30, content truncated to 500', () => {
    const db = getDb();
    const insert = db.prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', ?, ?)",
    );
    for (let i = 0; i < 40; i += 1) {
      insert.run(`m-${i}`, `msg ${i}`, now - i * 3600_000);
    }
    const longTs = now - 3600_000;
    insert.run('long-msg', 'x'.repeat(1000), longTs);

    const data = gatherData(db, now, TZ);
    expect(data.recentContext.length).toBeLessThanOrEqual(30);
    for (const m of data.recentContext) {
      expect(m.ts).toBeGreaterThanOrEqual(now - 48 * 3600_000);
    }
    const longM = data.recentContext.find((m) => m.content.startsWith('xxxx'));
    expect(longM?.content.length).toBe(500);
  });
});

describe('composePrompt', () => {
  it('formats all sections when data present', () => {
    const prompt = composePrompt({
      reminders: [
        { text: 'позвонить Иванову', nextFireAt: Date.UTC(2026, 3, 18, 11, 0, 0) },
      ],
      notes: [
        {
          key: 'user.note.x',
          value: 'нужно на работу 8:00',
          lastMentionedAt: Date.UTC(2026, 3, 17),
        },
      ],
      recentContext: [
        { role: 'user', content: 'сегодня дождь?', ts: Date.UTC(2026, 3, 18, 4, 0, 0) },
      ],
    });
    expect(prompt).toContain('## Reminders на сегодня/завтра');
    expect(prompt).toContain('позвонить Иванову');
    expect(prompt).toContain('## Открытые заметки');
    expect(prompt).toContain('user.note.x');
    expect(prompt).toContain('## Recent context');
    expect(prompt).toContain('сегодня дождь?');
    expect(prompt).toContain('5-8 bullet points');
  });

  it('shows "нет" for empty sections', () => {
    const prompt = composePrompt({ reminders: [], notes: [], recentContext: [] });
    expect(prompt).toMatch(/## Reminders на сегодня\/завтра\s+нет/);
    expect(prompt).toMatch(/## Открытые заметки\s+нет/);
    expect(prompt).toMatch(/## Recent context\s+нет/);
  });

  it('formats timestamps in Europe/Kyiv local time (no Z, no UTC)', () => {
    // 11:00 UTC on 2026-04-18 is 14:00 in Kyiv (UTC+3 summer).
    const prompt = composePrompt({
      reminders: [
        { text: 'позвонить', nextFireAt: Date.UTC(2026, 3, 18, 11, 0, 0) },
      ],
      notes: [],
      recentContext: [
        { role: 'user', content: 'x', ts: Date.UTC(2026, 3, 18, 4, 0, 0) },
      ],
    });
    expect(prompt).toContain('2026-04-18 14:00: позвонить');
    expect(prompt).toContain('[2026-04-18 07:00] user: x');
    expect(prompt).not.toContain('Z');
    expect(prompt).not.toContain('T11:00');
  });
});
