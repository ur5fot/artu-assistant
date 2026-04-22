import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../../db.js';
import {
  getLocalCivilEpoch,
  isSameLocalDate,
  hasUserActivitySince,
  hasUserActivityInLastHour,
  gatherData,
  composePrompt,
  getLastBriefPublishAt,
  computeGapDays,
  gatherPreviousPeriod,
  renderPreviousPeriod,
  pluralizeDays,
} from '../../handlers/morningBrief.helpers.js';
import type {
  ChatRow,
  PreviousPeriodBundle,
} from '../../handlers/morningBrief.helpers.js';

const TZ = 'Europe/Kyiv';

beforeEach(() => initDb(':memory:'));

describe('getLocalCivilEpoch', () => {
  it('returns midnight of same local date as `now` (dayOffset=0, hour=0)', () => {
    const now = Date.UTC(2026, 3, 18, 14, 30, 0);
    const startLocal = getLocalCivilEpoch(now, TZ);
    expect(new Date(startLocal).toISOString()).toBe('2026-04-17T21:00:00.000Z');
  });

  it('handles pre-midnight UTC correctly (Kyiv ahead of UTC)', () => {
    const now = Date.UTC(2026, 3, 18, 23, 30, 0);
    const startLocal = getLocalCivilEpoch(now, TZ);
    expect(new Date(startLocal).toISOString()).toBe('2026-04-18T21:00:00.000Z');
  });

  it('returns midnight on spring-forward DST day (Kyiv UTC+2 pre-transition)', () => {
    // 2026-03-29 is spring-forward in Europe/Kyiv (03:00 → 04:00 local).
    // `now` at 08:00 Kyiv = 05:00 UTC (post-transition, UTC+3).
    const now = Date.UTC(2026, 2, 29, 5, 0, 0);
    const startLocal = getLocalCivilEpoch(now, TZ);
    // Local midnight 2026-03-29 Kyiv = 22:00 UTC 2026-03-28 (pre-DST UTC+2).
    expect(new Date(startLocal).toISOString()).toBe('2026-03-28T22:00:00.000Z');
  });

  it('returns midnight on fall-back DST day (Kyiv UTC+3 pre-transition)', () => {
    // 2026-10-25 is fall-back in Europe/Kyiv (04:00 → 03:00 local).
    // `now` at 10:00 Kyiv = 08:00 UTC (post-transition, UTC+2).
    const now = Date.UTC(2026, 9, 25, 8, 0, 0);
    const startLocal = getLocalCivilEpoch(now, TZ);
    // Local midnight 2026-10-25 Kyiv = 21:00 UTC 2026-10-24 (pre-DST UTC+3).
    expect(new Date(startLocal).toISOString()).toBe('2026-10-24T21:00:00.000Z');
  });


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
    const naive = getLocalCivilEpoch(now, TZ) + 6 * 3600_000;
    expect(new Date(naive).toISOString()).toBe('2026-03-29T04:00:00.000Z');
  });

  it('returns civil 06:00 on fall-back DST day', () => {
    // 2026-10-25: Kyiv 04:00→03:00 local. Civil 06:00 Kyiv = 04:00 UTC (post-
    // transition, UTC+2). Naive midnight+6h would give 03:00 UTC = 05:00 local.
    const now = Date.UTC(2026, 9, 25, 8, 0, 0); // 10:00 Kyiv post-transition
    const six = getLocalCivilEpoch(now, TZ, 0, 6);
    expect(new Date(six).toISOString()).toBe('2026-10-25T04:00:00.000Z');
    const naive = getLocalCivilEpoch(now, TZ) + 6 * 3600_000;
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

describe('hasUserActivitySince', () => {
  const since = Date.UTC(2026, 3, 18, 3, 0, 0); // 06:00 Kyiv 18th

  it('returns false when chat_messages has no rows since the boundary', () => {
    expect(hasUserActivitySince(getDb(), since)).toBe(false);
  });

  it('returns true when at least one user message exists at or after the boundary', () => {
    const ts = since + 3600_000; // 07:00 Kyiv
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', 'hi', ?)",
      )
      .run(`m-${ts}`, ts);
    expect(hasUserActivitySince(getDb(), since)).toBe(true);
  });

  it('ignores messages before the boundary (e.g. 03:00 local)', () => {
    const ts = since - 3 * 3600_000; // 03:00 Kyiv — before 06:00
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', 'hi', ?)",
      )
      .run(`m-${ts}`, ts);
    expect(hasUserActivitySince(getDb(), since)).toBe(false);
  });

  it('ignores assistant messages (only user role counts)', () => {
    const ts = since + 3600_000;
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'assistant', 'hi', ?)",
      )
      .run(`m-${ts}`, ts);
    expect(hasUserActivitySince(getDb(), since)).toBe(false);
  });
});

describe('gatherData', () => {
  const now = Date.UTC(2026, 3, 18, 6, 0, 0); // 09:00 Kyiv 18th

  it('returns reminders active=1 with next_fire_at_ms in today+tomorrow window', () => {
    const todayStart = Date.UTC(2026, 3, 17, 21, 0, 0); // 00:00 Kyiv 18th
    const dayAfterTomorrowStart = Date.UTC(2026, 3, 19, 21, 0, 0); // 00:00 Kyiv 20th

    const db = getDb();
    const insert = db.prepare(
      "INSERT INTO reminders (text, schedule_json, next_fire_at_ms, active, created_at) VALUES (?, '{}', ?, ?, ?)",
    );
    // Exact inclusive lower bound.
    insert.run('at lower bound', todayStart, 1, now);
    // Exact exclusive upper bound — must be excluded.
    insert.run('at upper bound', dayAfterTomorrowStart, 1, now);
    insert.run('in-window today', todayStart + 5 * 3600_000, 1, now);
    insert.run('in-window tomorrow', dayAfterTomorrowStart - 2 * 3600_000, 1, now);
    insert.run('past', todayStart - 3600_000, 1, now);
    insert.run('too far', dayAfterTomorrowStart + 3600_000, 1, now);
    insert.run('disabled in-window', todayStart + 4 * 3600_000, 0, now);

    const data = gatherData(db, now, TZ);
    expect(data.reminders.map((r) => r.text).sort()).toEqual([
      'at lower bound',
      'in-window today',
      'in-window tomorrow',
    ]);
  });

  it('returns empty arrays on fresh DB', () => {
    const data = gatherData(getDb(), now, TZ);
    expect(data).toMatchObject({ reminders: [], notes: [], recentContext: [], city: null });
  });

  it('returns city from user.city regardless of 14d freshness', () => {
    const db = getDb();
    // 90 days old — far outside note freshness window.
    db.prepare(
      'INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, superseded_by, forgotten) VALUES (?, ?, ?, ?, NULL, 0)',
    ).run('user.city', 'Киев', now - 90 * 86400_000, now - 90 * 86400_000);
    const data = gatherData(db, now, TZ);
    expect(data.city).toBe('Киев');
  });

  it('falls back to user.location when user.city absent', () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, superseded_by, forgotten) VALUES (?, ?, ?, ?, NULL, 0)',
    ).run('user.location', 'Одеса', now, now);
    expect(gatherData(db, now, TZ).city).toBe('Одеса');
  });

  it('prefers user.city over user.location when both exist', () => {
    const db = getDb();
    const insert = db.prepare(
      'INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, superseded_by, forgotten) VALUES (?, ?, ?, ?, NULL, 0)',
    );
    insert.run('user.location', 'Одеса', now, now);
    insert.run('user.city', 'Киев', now - 1000, now - 1000);
    expect(gatherData(db, now, TZ).city).toBe('Киев');
  });

  it('ignores superseded / forgotten city rows', () => {
    const db = getDb();
    const insert = db.prepare(
      'INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, superseded_by, forgotten) VALUES (?, ?, ?, ?, ?, ?)',
    );
    // Insert newer first (active), then old pointing to it — partial unique
    // index forbids two active rows with same key.
    const newer = insert.run('user.city', 'Киев', now, now, null, 0);
    insert.run('user.city', 'Львов', now - 1000, now - 1000, newer.lastInsertRowid, 0);
    insert.run('user.location', 'Харьков', now, now, null, 1); // forgotten
    expect(gatherData(db, now, TZ).city).toBe('Киев');
  });

  it('returns null city when none stored', () => {
    expect(gatherData(getDb(), now, TZ).city).toBeNull();
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

  it('caps notes at 50 rows and truncates long values to 300 chars', () => {
    const db = getDb();
    const insert = db.prepare(
      'INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, superseded_by) VALUES (?, ?, ?, ?, NULL)',
    );
    for (let i = 0; i < 80; i += 1) {
      insert.run(`user.k${i}`, `v${i}`, now - i * 60_000, now - i * 60_000);
    }
    insert.run('user.long', 'y'.repeat(1000), now, now);

    const data = gatherData(db, now, TZ);
    expect(data.notes.length).toBeLessThanOrEqual(50);
    // Newest first — the long one at `now` wins ordering ties, so should be included.
    const longNote = data.notes.find((n) => n.key === 'user.long');
    expect(longNote?.value.length).toBe(300);
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

  it('returns recent chat messages last 48h, max 30 newest first, content truncated to 500', () => {
    const db = getDb();
    const insert = db.prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', ?, ?)",
    );
    // 40 rows within the 48h window so the LIMIT clause is exercised.
    for (let i = 0; i < 40; i += 1) {
      insert.run(`m-${i}`, `msg ${i}`, now - i * 60_000);
    }
    insert.run('long-msg', 'x'.repeat(1000), now - 30_000);

    const data = gatherData(db, now, TZ);
    expect(data.recentContext.length).toBe(30);
    // Newest first.
    for (let i = 0; i < data.recentContext.length - 1; i += 1) {
      expect(data.recentContext[i].ts).toBeGreaterThan(data.recentContext[i + 1].ts);
    }
    for (const m of data.recentContext) {
      expect(m.ts).toBeGreaterThanOrEqual(now - 48 * 3600_000);
    }
    const longM = data.recentContext.find((m) => m.content.startsWith('xxxx'));
    expect(longM?.content.length).toBe(500);
  });
});

describe('composePrompt', () => {
  const emptyBundle = {
    chat: [],
    memoryCreated: [],
    memoryUpdated: [],
    memoryForgotten: [],
    audit: [],
    cognition: [],
    remindersOverdue: [],
    remindersCreated: [],
  };
  const recapDefaults = {
    gapDays: 0,
    previousPeriod: emptyBundle,
    previousPeriodFrom: 0,
    previousPeriodTo: 0,
  };

  it('formats all sections when data present', () => {
    const prompt = composePrompt(
      {
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
        city: 'Киев',
        ...recapDefaults,
      },
      TZ,
    );
    expect(prompt).toContain('## Reminders на сегодня/завтра');
    expect(prompt).toContain('позвонить Иванову');
    expect(prompt).toContain('## Открытые заметки');
    expect(prompt).toContain('user.note.x');
    expect(prompt).toContain('## Recent context');
    expect(prompt).toContain('сегодня дождь?');
    expect(prompt).toContain('Не пересказывай');
  });

  it('shows "нет" for empty sections', () => {
    const prompt = composePrompt(
      { reminders: [], notes: [], recentContext: [], city: null, ...recapDefaults },
      TZ,
    );
    expect(prompt).toMatch(/## Reminders на сегодня\/завтра\s+нет/);
    expect(prompt).toMatch(/## Открытые заметки\s+нет/);
    expect(prompt).toMatch(/## Recent context \(48h\)\s+нет/);
  });

  it('formats timestamps in the passed tz (no Z, no UTC)', () => {
    // 11:00 UTC on 2026-04-18 is 14:00 in Kyiv (UTC+3 summer).
    const prompt = composePrompt(
      {
        reminders: [
          { text: 'позвонить', nextFireAt: Date.UTC(2026, 3, 18, 11, 0, 0) },
        ],
        notes: [],
        recentContext: [
          { role: 'user', content: 'x', ts: Date.UTC(2026, 3, 18, 4, 0, 0) },
        ],
        city: null,
        ...recapDefaults,
      },
      TZ,
    );
    expect(prompt).toContain('2026-04-18 14:00: позвонить');
    expect(prompt).toContain('[2026-04-18 07:00] user: x');
    expect(prompt).not.toContain('Z');
    expect(prompt).not.toContain('T11:00');
  });

  it('includes user city in prompt header', () => {
    const prompt = composePrompt(
      { reminders: [], notes: [], recentContext: [], city: 'Киев', ...recapDefaults },
      TZ,
    );
    expect(prompt).toContain('Киев');
  });

  it('tells LLM city is not set when city is null', () => {
    const prompt = composePrompt(
      { reminders: [], notes: [], recentContext: [], city: null, ...recapDefaults },
      TZ,
    );
    expect(prompt).toContain('город не задан');
  });
});

describe('getLastBriefPublishAt', () => {
  it('returns null when cognition_handler_runs is empty', () => {
    expect(getLastBriefPublishAt(getDb())).toBeNull();
  });

  it('returns null when runs exist but none with publish outcome', () => {
    getDb()
      .prepare(
        'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
      )
      .run('morningBrief', 1000, 10, 'error');
    getDb()
      .prepare(
        'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
      )
      .run('morningBrief', 2000, 10, 'skip');
    expect(getLastBriefPublishAt(getDb())).toBeNull();
  });

  it('returns the most recent publish fired_at, ignoring other handlers', () => {
    const rows: Array<[string, number, string]> = [
      ['morningBrief', 100, 'publish'],
      ['pulse', 500, 'publish'],
      ['morningBrief', 300, 'publish'],
      ['morningBrief', 200, 'error'],
    ];
    for (const [name, ts, outcome] of rows) {
      getDb()
        .prepare(
          'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
        )
        .run(name, ts, 10, outcome);
    }
    expect(getLastBriefPublishAt(getDb())).toBe(300);
  });
});

describe('computeGapDays', () => {
  it('returns 0 when lastPublishAt is null (first run)', () => {
    const now = Date.UTC(2026, 3, 22, 9, 0, 0);
    expect(computeGapDays(null, now, TZ)).toBe(0);
  });

  it('returns 0 when lastPublishAt is on same local date as now', () => {
    const lastPublish = Date.UTC(2026, 3, 22, 3, 0, 0); // 06:00 Kyiv 22nd
    const now = Date.UTC(2026, 3, 22, 15, 0, 0); // 18:00 Kyiv same day
    expect(computeGapDays(lastPublish, now, TZ)).toBe(0);
  });

  it('returns 1 when lastPublishAt is yesterday local', () => {
    const lastPublish = Date.UTC(2026, 3, 21, 3, 0, 0); // 06:00 Kyiv 21st
    const now = Date.UTC(2026, 3, 22, 9, 0, 0); // 12:00 Kyiv 22nd
    expect(computeGapDays(lastPublish, now, TZ)).toBe(1);
  });

  it('returns 3 when last publish 3 local days ago', () => {
    const lastPublish = Date.UTC(2026, 3, 19, 3, 0, 0);
    const now = Date.UTC(2026, 3, 22, 9, 0, 0);
    expect(computeGapDays(lastPublish, now, TZ)).toBe(3);
  });

  it('is DST-aware across spring-forward', () => {
    // Kyiv spring-forward 2026-03-29: 03:00→04:00. Measure 2-day gap crossing it.
    const lastPublish = Date.UTC(2026, 2, 28, 6, 0, 0); // 08:00 Kyiv 28th (pre-DST)
    const now = Date.UTC(2026, 2, 30, 6, 0, 0); // 09:00 Kyiv 30th (post-DST UTC+3)
    expect(computeGapDays(lastPublish, now, TZ)).toBe(2);
  });
});

describe('hasUserActivityInLastHour', () => {
  it('returns false when no chat messages at all', () => {
    expect(hasUserActivityInLastHour(getDb(), Date.now())).toBe(false);
  });

  it('returns false when last user message is > 1 hour old', () => {
    const now = Date.UTC(2026, 3, 22, 12, 0, 0);
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
      )
      .run(now - 2 * 3600_000);
    expect(hasUserActivityInLastHour(getDb(), now)).toBe(false);
  });

  it('returns true when user message within last hour', () => {
    const now = Date.UTC(2026, 3, 22, 12, 0, 0);
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
      )
      .run(now - 30 * 60_000);
    expect(hasUserActivityInLastHour(getDb(), now)).toBe(true);
  });

  it('ignores assistant messages', () => {
    const now = Date.UTC(2026, 3, 22, 12, 0, 0);
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'assistant', 'hi', ?)",
      )
      .run(now - 10 * 60_000);
    expect(hasUserActivityInLastHour(getDb(), now)).toBe(false);
  });
});

describe('gatherPreviousPeriod', () => {
  it('returns empty bundle when period is empty', () => {
    const bundle = gatherPreviousPeriod(getDb(), 1000, 2000);
    expect(bundle).toEqual({
      chat: [],
      memoryCreated: [],
      memoryUpdated: [],
      memoryForgotten: [],
      audit: [],
      cognition: [],
      remindersOverdue: [],
      remindersCreated: [],
    });
  });

  it('collects chat messages in [from, to)', () => {
    const from = 1000;
    const to = 2000;
    const db = getDb();
    db.prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'before', ?)",
    ).run(500);
    db.prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('b', 'user', 'inside', ?)",
    ).run(1500);
    db.prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('c', 'assistant', 'inside-2', ?)",
    ).run(1800);
    db.prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('d', 'user', 'after', ?)",
    ).run(2500);
    const bundle = gatherPreviousPeriod(db, from, to);
    expect(bundle.chat.map((r) => r.content)).toEqual(['inside', 'inside-2']);
  });

  it('classifies memory_facts as created / updated / forgotten correctly', () => {
    const db = getDb();
    const from = 1000;
    const to = 2000;
    // Created inside period
    db.prepare(
      "INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, importance, forgotten) VALUES ('k.new', 'v', 1500, 1500, 5, 0)",
    ).run();
    // Created before, updated inside, not forgotten → updated
    db.prepare(
      "INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, importance, forgotten) VALUES ('k.upd', 'v', 500, 1700, 5, 0)",
    ).run();
    // Forgotten inside (last_mentioned_at inside, forgotten=1)
    db.prepare(
      "INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, importance, forgotten) VALUES ('k.forg', 'v', 200, 1900, 5, 1)",
    ).run();
    const bundle = gatherPreviousPeriod(db, from, to);
    expect(bundle.memoryCreated.map((r) => r.key)).toEqual(['k.new']);
    expect(bundle.memoryUpdated.map((r) => r.key)).toEqual(['k.upd']);
    expect(bundle.memoryForgotten.map((r) => r.key)).toEqual(['k.forg']);
  });

  it('does not double-list facts created and forgotten in the same period', () => {
    const db = getDb();
    const from = 1000;
    const to = 2000;
    // Created AND forgotten inside [from, to) — should only appear in
    // memoryCreated, not also in memoryForgotten.
    db.prepare(
      "INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, importance, forgotten) VALUES ('k.both', 'v', 1500, 1900, 5, 1)",
    ).run();
    const bundle = gatherPreviousPeriod(db, from, to);
    expect(bundle.memoryCreated.map((r) => r.key)).toEqual(['k.both']);
    expect(bundle.memoryForgotten).toEqual([]);
  });

  it('excludes superseded rows from memoryCreated when the fact is revised in-period', () => {
    const db = getDb();
    const from = 1000;
    const to = 2000;
    // Mirror insertOrSupersedeFact flow: mark old row superseded with a
    // self-ref placeholder BEFORE inserting new, so the active-key unique
    // index sees only one live row at a time. Then repoint old → newId.
    const oldIns = db
      .prepare(
        "INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, importance, forgotten) VALUES ('k.x', 'old', 1200, 1200, 5, 0)",
      )
      .run();
    const oldId = Number(oldIns.lastInsertRowid);
    db.prepare('UPDATE memory_facts SET superseded_by = id WHERE id = ?').run(oldId);
    const newIns = db
      .prepare(
        "INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, importance, forgotten) VALUES ('k.x', 'new', 1500, 1500, 5, 0)",
      )
      .run();
    const newId = Number(newIns.lastInsertRowid);
    db.prepare('UPDATE memory_facts SET superseded_by = ? WHERE id = ?').run(newId, oldId);
    const bundle = gatherPreviousPeriod(db, from, to);
    expect(bundle.memoryCreated.map((r) => r.value)).toEqual(['new']);
  });

  it('collects audit_log only for heavy tools', () => {
    const db = getDb();
    const isoInside = '2026-04-22 10:00:00';
    db.prepare(
      'INSERT INTO audit_log (tool_name, input, result, success, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('code_task', '{}', 'ok', 1, 100, isoInside);
    db.prepare(
      'INSERT INTO audit_log (tool_name, input, result, success, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('web_search', '{}', 'ok', 1, 100, isoInside);
    const bundle = gatherPreviousPeriod(
      db,
      Date.parse('2026-04-21T00:00:00Z'),
      Date.parse('2026-04-23T00:00:00Z'),
    );
    const names = bundle.audit.map((r) => r.toolName);
    expect(names).toContain('code_task');
    expect(names).not.toContain('web_search');
  });

  it('excludes morningBrief from cognition runs', () => {
    const db = getDb();
    const from = 1000;
    const to = 2000;
    db.prepare(
      'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome, content) VALUES (?, ?, ?, ?, ?)',
    ).run('morningBrief', 1500, 10, 'publish', 'old brief');
    db.prepare(
      'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome, content) VALUES (?, ?, ?, ?, ?)',
    ).run('pulse', 1600, 10, 'publish', 'pulse');
    const bundle = gatherPreviousPeriod(db, from, to);
    expect(bundle.cognition.map((r) => r.handlerName)).toEqual(['pulse']);
  });

  it('collects overdue active reminders within 30d lookback, excluding inactive', () => {
    const db = getDb();
    const now = Date.UTC(2026, 3, 22, 12, 0, 0);
    const to = now;
    const from = now - 86400_000;
    // Active, overdue within window
    db.prepare(
      'INSERT INTO reminders (text, schedule_json, next_fire_at_ms, active, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('buy milk', '{}', now - 2 * 3600_000, 1, now - 3 * 86400_000);
    // Inactive — must be excluded
    db.prepare(
      'INSERT INTO reminders (text, schedule_json, next_fire_at_ms, active, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('old reminder', '{}', now - 2 * 3600_000, 0, now - 3 * 86400_000);
    // Active but outside 30d lookback
    db.prepare(
      'INSERT INTO reminders (text, schedule_json, next_fire_at_ms, active, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('ancient', '{}', now - 60 * 86400_000, 1, now - 60 * 86400_000);
    const bundle = gatherPreviousPeriod(db, from, to);
    expect(bundle.remindersOverdue.map((r) => r.text)).toEqual(['buy milk']);
  });

  it('applies row-count caps per source', () => {
    const db = getDb();
    const from = 1000;
    const to = 2000;
    for (let i = 0; i < 120; i++) {
      db.prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', 'msg', ?)",
      ).run(`m${i}`, 1000 + i);
    }
    const bundle = gatherPreviousPeriod(db, from, to);
    expect(bundle.chat.length).toBe(80);
  });
});

describe('renderPreviousPeriod', () => {
  it('includes "tail-only" marker when rendered body exceeds MAX_BUNDLE_CHARS', () => {
    const bigChat: ChatRow[] = [];
    for (let i = 0; i < 80; i++) {
      bigChat.push({
        role: 'user',
        ts: 1_700_000_000_000 + i * 60_000,
        content: 'x'.repeat(450),
      });
    }
    const rendered = renderPreviousPeriod(
      {
        chat: bigChat,
        memoryCreated: [],
        memoryUpdated: [],
        memoryForgotten: [],
        audit: [],
        cognition: [],
        remindersOverdue: [],
        remindersCreated: [],
      },
      'Europe/Kyiv',
    );
    expect(rendered).toContain('...и ');
    expect(rendered).toContain('событий раньше опущено');
    expect(rendered.length).toBeLessThanOrEqual(12500);
  });

  it('renders compact markdown with all non-empty sections', () => {
    const rendered = renderPreviousPeriod(
      {
        chat: [{ role: 'user', ts: 1_700_000_000_000, content: 'hello' }],
        memoryCreated: [{ key: 'k', value: 'v', createdAt: 1_700_000_000_000 }],
        memoryUpdated: [],
        memoryForgotten: [],
        audit: [],
        cognition: [],
        remindersOverdue: [],
        remindersCreated: [],
      },
      'Europe/Kyiv',
    );
    expect(rendered).toContain('### Chat');
    expect(rendered).toContain('### Memory изменения');
    expect(rendered).not.toContain('### Tool runs');
  });

  it('returns "активности не было" when every section is empty', () => {
    const rendered = renderPreviousPeriod(
      {
        chat: [],
        memoryCreated: [],
        memoryUpdated: [],
        memoryForgotten: [],
        audit: [],
        cognition: [],
        remindersOverdue: [],
        remindersCreated: [],
      },
      'Europe/Kyiv',
    );
    expect(rendered.trim()).toBe('активности не было');
  });
});

describe('gatherData extended', () => {
  it('includes previousPeriod bundle and gapDays=0 when last publish is today', () => {
    const db = getDb();
    const now = Date.UTC(2026, 3, 22, 9, 0, 0); // 12:00 Kyiv
    db.prepare(
      'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome, content) VALUES (?, ?, ?, ?, ?)',
    ).run('morningBrief', Date.UTC(2026, 3, 22, 3, 0, 0), 10, 'publish', 'brief');
    // previousPeriod spans [lastPublish, todayStart) — on a same-day republish
    // the range collapses to empty (to <= from). Handler must still return a
    // well-formed bundle (all empty arrays), not throw.
    const data = gatherData(db, now, TZ);
    expect(data.gapDays).toBe(0);
    expect(data.previousPeriod).toBeDefined();
    expect(data.previousPeriod.chat).toEqual([]);
  });

  it('sets gapDays to 2 when last publish was 2 local days ago', () => {
    const db = getDb();
    const now = Date.UTC(2026, 3, 22, 9, 0, 0);
    db.prepare(
      'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome, content) VALUES (?, ?, ?, ?, ?)',
    ).run('morningBrief', Date.UTC(2026, 3, 20, 3, 0, 0), 10, 'publish', 'brief');
    const data = gatherData(db, now, TZ);
    expect(data.gapDays).toBe(2);
  });

  it('falls back to last 48h window when no prior publish exists', () => {
    const db = getDb();
    const now = Date.UTC(2026, 3, 22, 9, 0, 0);
    db.prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('x', 'user', 'hi', ?)",
    ).run(now - 6 * 3600_000);
    const data = gatherData(db, now, TZ);
    expect(data.gapDays).toBe(0);
    expect(data.previousPeriod.chat.length).toBe(1);
  });
});

describe('pluralizeDays', () => {
  it('uses "день" for 1, 21, 31, 101', () => {
    expect(pluralizeDays(1)).toBe('1 день');
    expect(pluralizeDays(21)).toBe('21 день');
    expect(pluralizeDays(31)).toBe('31 день');
    expect(pluralizeDays(101)).toBe('101 день');
  });

  it('uses "дня" for 2-4, 22-24, 32-34', () => {
    expect(pluralizeDays(2)).toBe('2 дня');
    expect(pluralizeDays(3)).toBe('3 дня');
    expect(pluralizeDays(4)).toBe('4 дня');
    expect(pluralizeDays(22)).toBe('22 дня');
    expect(pluralizeDays(34)).toBe('34 дня');
  });

  it('uses "дней" for 0, 5-20, 25-30, 100', () => {
    expect(pluralizeDays(0)).toBe('0 дней');
    expect(pluralizeDays(5)).toBe('5 дней');
    expect(pluralizeDays(11)).toBe('11 дней');
    expect(pluralizeDays(12)).toBe('12 дней');
    expect(pluralizeDays(14)).toBe('14 дней');
    expect(pluralizeDays(20)).toBe('20 дней');
    expect(pluralizeDays(100)).toBe('100 дней');
    expect(pluralizeDays(112)).toBe('112 дней');
  });
});

describe('renderPreviousPeriod tail-trim shape', () => {
  it('starts with the marker and the kept tail begins at a line boundary', () => {
    const bigChat: ChatRow[] = [];
    for (let i = 0; i < 80; i++) {
      bigChat.push({
        role: 'user',
        ts: 1_700_000_000_000 + i * 60_000,
        content: 'x'.repeat(450),
      });
    }
    const rendered = renderPreviousPeriod(
      {
        chat: bigChat,
        memoryCreated: [],
        memoryUpdated: [],
        memoryForgotten: [],
        audit: [],
        cognition: [],
        remindersOverdue: [],
        remindersCreated: [],
      },
      'Europe/Kyiv',
    );
    // Marker is the first line, then full kept lines (each starts with "- [").
    const marker = rendered.split('\n', 1)[0];
    expect(marker.startsWith('...и ')).toBe(true);
    const firstKept = rendered.split('\n')[1];
    expect(firstKept.startsWith('- [')).toBe(true);
    // Total stays under the budget (no overshoot from the prepended marker).
    expect(rendered.length).toBeLessThanOrEqual(12000);
  });
});

describe('gatherData gap-return window', () => {
  it('previousPeriodTo equals now when gapDays >= 2 (today included)', () => {
    const db = getDb();
    const now = Date.UTC(2026, 3, 22, 12, 0, 0); // 15:00 Kyiv
    db.prepare(
      'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome, content) VALUES (?, ?, ?, ?, ?)',
    ).run('morningBrief', Date.UTC(2026, 3, 19, 3, 0, 0), 10, 'publish', 'brief');
    // Today's first-return message — must land in the bundle.
    db.prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('return', 'user', 'я вернулся', ?)",
    ).run(now - 10 * 60_000);
    const data = gatherData(db, now, TZ);
    expect(data.gapDays).toBeGreaterThanOrEqual(2);
    expect(data.previousPeriodTo).toBe(now);
    expect(data.previousPeriod.chat.map((r) => r.content)).toContain('я вернулся');
  });

  it('previousPeriodTo equals todayStart for normal morning (gapDays < 2)', () => {
    const db = getDb();
    const now = Date.UTC(2026, 3, 22, 9, 0, 0); // 12:00 Kyiv
    const todayStart = getLocalCivilEpoch(now, TZ);
    db.prepare(
      'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome, content) VALUES (?, ?, ?, ?, ?)',
    ).run('morningBrief', Date.UTC(2026, 3, 21, 3, 0, 0), 10, 'publish', 'yesterday');
    const data = gatherData(db, now, TZ);
    expect(data.gapDays).toBe(1);
    expect(data.previousPeriodTo).toBe(todayStart);
  });
});

describe('composePrompt with gap and previousPeriod', () => {
  const emptyBundle: PreviousPeriodBundle = {
    chat: [],
    memoryCreated: [],
    memoryUpdated: [],
    memoryForgotten: [],
    audit: [],
    cognition: [],
    remindersOverdue: [],
    remindersCreated: [],
  };

  it('includes gap preamble when gapDays >= 2', () => {
    const p = composePrompt(
      {
        reminders: [],
        notes: [],
        recentContext: [],
        city: 'Kyiv',
        gapDays: 3,
        previousPeriod: emptyBundle,
        previousPeriodFrom: 1_700_000_000_000,
        previousPeriodTo: 1_700_259_200_000,
      },
      TZ,
    );
    expect(p).toContain('Gap: 3');
    expect(p).toContain('"Пока меня не было 3 дня');
  });

  it('omits gap preamble when gapDays = 1 (one missed day handled by morning window)', () => {
    const p = composePrompt(
      {
        reminders: [],
        notes: [],
        recentContext: [],
        city: 'Kyiv',
        gapDays: 1,
        previousPeriod: emptyBundle,
        previousPeriodFrom: 1_700_000_000_000,
        previousPeriodTo: 1_700_086_400_000,
      },
      TZ,
    );
    expect(p).not.toContain('Gap:');
    expect(p).not.toContain('Пока меня не было');
    expect(p).toContain('Что висит со вчера');
  });

  it('uses Russian plural agreement for gap days (день / дня / дней)', () => {
    const make = (gapDays: number): string =>
      composePrompt(
        {
          reminders: [],
          notes: [],
          recentContext: [],
          city: 'Kyiv',
          gapDays,
          previousPeriod: emptyBundle,
          previousPeriodFrom: 1_700_000_000_000,
          previousPeriodTo: 1_700_086_400_000,
        },
        TZ,
      );
    expect(make(2)).toContain('не было 2 дня');
    expect(make(5)).toContain('не было 5 дней');
    expect(make(11)).toContain('не было 11 дней');
    expect(make(21)).toContain('не было 21 день');
    expect(make(22)).toContain('не было 22 дня');
  });

  it('omits gap preamble when gapDays = 0 and asks about висящее со вчера', () => {
    const p = composePrompt(
      {
        reminders: [],
        notes: [],
        recentContext: [],
        city: 'Kyiv',
        gapDays: 0,
        previousPeriod: emptyBundle,
        previousPeriodFrom: 1_700_000_000_000,
        previousPeriodTo: 1_700_086_400_000,
      },
      TZ,
    );
    expect(p).not.toContain('Gap:');
    expect(p).toContain('Что висит со вчера');
  });

  it('includes "Прошлый период" section with rendered bundle content', () => {
    const p = composePrompt(
      {
        reminders: [],
        notes: [],
        recentContext: [],
        city: 'Kyiv',
        gapDays: 1,
        previousPeriod: {
          ...emptyBundle,
          chat: [{ role: 'user', ts: 1_700_000_000_000, content: 'вопрос висит' }],
        },
        previousPeriodFrom: 1_700_000_000_000,
        previousPeriodTo: 1_700_086_400_000,
      },
      TZ,
    );
    expect(p).toContain('## Прошлый период');
    expect(p).toContain('вопрос висит');
  });

  it('instructs the LLM to analyze (висит / повторяется / упустил), not retell', () => {
    const p = composePrompt(
      {
        reminders: [],
        notes: [],
        recentContext: [],
        city: 'Kyiv',
        gapDays: 0,
        previousPeriod: emptyBundle,
        previousPeriodFrom: 1,
        previousPeriodTo: 2,
      },
      TZ,
    );
    expect(p).toContain('что висит');
    expect(p).toContain('что повторяется');
    expect(p).toContain('что упустил');
    expect(p).toContain('Не пересказывай');
  });
});
