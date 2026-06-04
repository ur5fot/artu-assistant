import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initDb, getDb } from '../../../db.js';
import { createMorningBriefHandler } from '../../handlers/morningBrief.js';
import type { PiiProxy } from '../../../pii/proxy.js';

beforeEach(() => initDb(':memory:'));

function fakeProxy(): PiiProxy {
  return {
    async anonymize(text) {
      return { text, entities: [] };
    },
    async deanonymize(text) {
      return text;
    },
  };
}

function fakeAnthropic(text: string) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text }],
        role: 'assistant',
      })),
    },
  };
}

describe('createMorningBriefHandler', () => {
  it('has name "morningBrief"', () => {
    const h = createMorningBriefHandler({
      piiProxy: fakeProxy(),
      anthropic: fakeAnthropic('ok') as any,
    });
    expect(h.name).toBe('morningBrief');
  });

  describe('trigger', () => {
    it('returns false before 06:00 local', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      // 2026-04-18 02:00 Kyiv = 2026-04-17 23:00 UTC
      const now = Date.UTC(2026, 3, 17, 23, 0, 0);
      const res = await h.trigger(
        { now, lastFiredAt: null, lastResult: null },
        { db: getDb() },
      );
      expect(res).toBe(false);
    });

    it('returns false when lastResult is publish on same local date', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 18, 6, 0, 0); // 09:00 Kyiv
      const lastFiredAt = Date.UTC(2026, 3, 18, 4, 0, 0); // 07:00 same day Kyiv
      getDb()
        .prepare(
          "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
        )
        .run(now - 3600_000);
      const res = await h.trigger(
        {
          now,
          lastFiredAt,
          lastResult: { publish: true, content: 'yesterday brief' },
        },
        { db: getDb() },
      );
      expect(res).toBe(false);
    });

    it('retries same day when lastResult is error', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 18, 6, 0, 0); // 09:00 Kyiv
      const lastFiredAt = Date.UTC(2026, 3, 18, 4, 0, 0); // 07:00 same day
      getDb()
        .prepare(
          "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
        )
        .run(now - 3600_000);
      const res = await h.trigger(
        {
          now,
          lastFiredAt,
          lastResult: { error: true, message: 'anthropic 500' },
        },
        { db: getDb() },
      );
      expect(res).toBe(true);
    });

    it('retries same day when lastResult is skip', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 18, 6, 0, 0);
      const lastFiredAt = Date.UTC(2026, 3, 18, 4, 0, 0);
      getDb()
        .prepare(
          "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
        )
        .run(now - 3600_000);
      const res = await h.trigger(
        {
          now,
          lastFiredAt,
          lastResult: { skip: true, reason: 'empty AI response' },
        },
        { db: getDb() },
      );
      expect(res).toBe(true);
    });

    it('returns true when lastResult is publish on previous local day', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 18, 6, 0, 0); // 09:00 Kyiv 18th
      const lastFiredAt = Date.UTC(2026, 3, 17, 4, 0, 0); // 07:00 Kyiv 17th
      getDb()
        .prepare(
          "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
        )
        .run(now - 3600_000);
      const res = await h.trigger(
        {
          now,
          lastFiredAt,
          lastResult: { publish: true, content: 'yesterday brief' },
        },
        { db: getDb() },
      );
      expect(res).toBe(true);
    });

    it('returns false when no user activity today', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 18, 6, 0, 0);
      const res = await h.trigger(
        { now, lastFiredAt: null, lastResult: null },
        { db: getDb() },
      );
      expect(res).toBe(false);
    });

    it('returns false when activity exists today but all messages are before 06:00 local', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 18, 6, 0, 0); // 09:00 Kyiv 18th
      // Insert a message at 03:00 Kyiv 18th — after midnight but before 06:00
      const earlyMorningTs = Date.UTC(2026, 3, 18, 0, 0, 0);
      getDb()
        .prepare(
          "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('early', 'user', 'ку', ?)",
        )
        .run(earlyMorningTs);
      const res = await h.trigger(
        { now, lastFiredAt: null, lastResult: null },
        { db: getDb() },
      );
      expect(res).toBe(false);
    });

    it('returns true after 06:00 local, new local day, and activity present', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 18, 6, 0, 0); // 09:00 Kyiv 18th
      getDb()
        .prepare(
          "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
        )
        .run(Date.UTC(2026, 3, 18, 4, 0, 0)); // 07:00 Kyiv
      const res = await h.trigger(
        { now, lastFiredAt: null, lastResult: null },
        { db: getDb() },
      );
      expect(res).toBe(true);
    });

    it('gap-return: fires at 15:00 when gapDays >= 2 and user active in last hour', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 22, 12, 0, 0); // 15:00 Kyiv 22nd
      getDb()
        .prepare(
          'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
        )
        .run('morningBrief', Date.UTC(2026, 3, 19, 3, 0, 0), 10, 'publish');
      getDb()
        .prepare(
          "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
        )
        .run(now - 20 * 60_000);
      const res = await h.trigger(
        { now, lastFiredAt: null, lastResult: null },
        { db: getDb() },
      );
      expect(res).toBe(true);
    });

    it('gap-return: does not fire when user was not active in last hour', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 22, 12, 0, 0); // 15:00 Kyiv 22nd
      getDb()
        .prepare(
          'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
        )
        .run('morningBrief', Date.UTC(2026, 3, 19, 3, 0, 0), 10, 'publish');
      // Activity at 04:00 Kyiv 22nd — before 06:00 local, so Branch A
      // (morning window) cannot fire either. Isolates gap-return Branch B.
      getDb()
        .prepare(
          "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
        )
        .run(Date.UTC(2026, 3, 22, 1, 0, 0));
      const res = await h.trigger(
        { now, lastFiredAt: null, lastResult: null },
        { db: getDb() },
      );
      expect(res).toBe(false);
    });

    it('gap-return: publishedToday still blocks even after gap-return fires once', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 22, 18, 0, 0); // 21:00 Kyiv
      const earlierToday = Date.UTC(2026, 3, 22, 12, 0, 0);
      getDb()
        .prepare(
          'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
        )
        .run('morningBrief', earlierToday, 10, 'publish');
      getDb()
        .prepare(
          "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
        )
        .run(now - 10 * 60_000);
      const res = await h.trigger(
        { now, lastFiredAt: earlierToday, lastResult: { publish: true, content: 'already' } },
        { db: getDb() },
      );
      expect(res).toBe(false);
    });

    it('gap-return: does not fire when gapDays is 1 (only)', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 22, 12, 0, 0); // 15:00 Kyiv 22nd
      getDb()
        .prepare(
          'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
        )
        .run('morningBrief', Date.UTC(2026, 3, 21, 3, 0, 0), 10, 'publish'); // 1 day ago
      getDb()
        .prepare(
          "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
        )
        .run(now - 10 * 60_000);
      const res = await h.trigger(
        { now, lastFiredAt: null, lastResult: null },
        { db: getDb() },
      );
      // gap-return alone (gapDays=1) does NOT fire, but 06:00 branch catches
      // because now (15:00) > 06:00 and activity (10 min ago) falls after 06:00.
      expect(res).toBe(true);
    });

    function insertWindow(
      appName: string,
      startedAt: number,
      lastSeenAt = startedAt,
    ): void {
      getDb()
        .prepare(
          'INSERT INTO window_history (app_name, window_title, started_at, last_seen_at) VALUES (?, ?, ?, ?)',
        )
        .run(appName, 'untitled', startedAt, lastSeenAt);
    }

    it('Branch A: fires on window activity after 06:00 without any chat message', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 18, 6, 0, 0); // 09:00 Kyiv 18th
      insertWindow('Code', Date.UTC(2026, 3, 18, 4, 0, 0)); // session start 07:00 Kyiv
      const res = await h.trigger(
        { now, lastFiredAt: null, lastResult: null },
        { db: getDb() },
      );
      expect(res).toBe(true);
    });

    it('Branch A: does not fire when the only session after 06:00 is an idle app (loginwindow)', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 18, 6, 0, 0);
      insertWindow('loginwindow', Date.UTC(2026, 3, 18, 4, 0, 0));
      const res = await h.trigger(
        { now, lastFiredAt: null, lastResult: null },
        { db: getDb() },
      );
      expect(res).toBe(false);
    });

    it('Branch A: does not fire before 06:00 even with window activity', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      // 2026-04-18 02:00 Kyiv = 2026-04-17 23:00 UTC
      const now = Date.UTC(2026, 3, 17, 23, 0, 0);
      insertWindow('Code', now - 10 * 60_000);
      const res = await h.trigger(
        { now, lastFiredAt: null, lastResult: null },
        { db: getDb() },
      );
      expect(res).toBe(false);
    });

    it('Branch A: publishedToday guard blocks a repeat after a window-driven fire', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 18, 9, 0, 0); // 12:00 Kyiv 18th
      const lastFiredAt = Date.UTC(2026, 3, 18, 4, 0, 0); // 07:00 same day Kyiv
      insertWindow('Code', Date.UTC(2026, 3, 18, 5, 0, 0)); // session start 08:00 Kyiv
      const res = await h.trigger(
        {
          now,
          lastFiredAt,
          lastResult: { publish: true, content: 'window-driven brief' },
        },
        { db: getDb() },
      );
      expect(res).toBe(false);
    });

    it('Branch B: gap-return fires on window activity in the last hour with gapDays >= 2', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 22, 1, 0, 0); // 04:00 Kyiv 22nd — before 06:00 so Branch A cannot mask Branch B
      getDb()
        .prepare(
          'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
        )
        .run('morningBrief', Date.UTC(2026, 3, 19, 3, 0, 0), 10, 'publish'); // 3 days ago
      // No chat message at all — only a window session that started 20 min ago.
      insertWindow('Code', now - 20 * 60_000);
      const res = await h.trigger(
        { now, lastFiredAt: null, lastResult: null },
        { db: getDb() },
      );
      expect(res).toBe(true);
    });

    it('Branch B: does not fire when the only window session started over an hour ago', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 22, 1, 0, 0); // 04:00 Kyiv 22nd — before 06:00 so Branch A cannot fire
      getDb()
        .prepare(
          'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
        )
        .run('morningBrief', Date.UTC(2026, 3, 19, 3, 0, 0), 10, 'publish'); // 3 days ago
      // Window session started 70 min ago — outside the last-hour gate, so the
      // gap-return window path must NOT fire (pins the `now - 3600_000` bound).
      insertWindow('Code', now - 70 * 60_000);
      const res = await h.trigger(
        { now, lastFiredAt: null, lastResult: null },
        { db: getDb() },
      );
      expect(res).toBe(false);
    });

    it('Branch B: fires on a window session started exactly an hour ago', async () => {
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: fakeAnthropic('ok') as any,
      });
      const now = Date.UTC(2026, 3, 22, 1, 0, 0); // 04:00 Kyiv 22nd — before 06:00 so Branch A cannot fire
      getDb()
        .prepare(
          'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
        )
        .run('morningBrief', Date.UTC(2026, 3, 19, 3, 0, 0), 10, 'publish'); // 3 days ago
      // Session started at exactly the lower bound (`now - 3600_000`). The
      // helper uses `started_at >= since`, so this must fire. Together with the
      // 70-min "does not fire" case this pins the gate to exactly one hour — a
      // bound regression to e.g. 30 min would slip past both 20/70-min tests.
      insertWindow('Code', now - 3600_000);
      const res = await h.trigger(
        { now, lastFiredAt: null, lastResult: null },
        { db: getDb() },
      );
      expect(res).toBe(true);
    });
  });

  describe('run', () => {
    it('returns publish:true with AI response', async () => {
      const anthropic = fakeAnthropic('Доброе утро! ...');
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: anthropic as any,
      });
      const result = await h.run({
        db: getDb(),
        signal: new AbortController().signal,
        firedAt: Date.now(),
      });
      expect(result).toEqual({ publish: true, content: 'Доброе утро! ...' });
      expect(anthropic.messages.create).toHaveBeenCalledOnce();
    });

    it('attaches "✓ Готово" components when topicStore has open actions', async () => {
      const anthropic = fakeAnthropic('brief text');
      const topicStore = {
        getOpenActions: vi.fn(() => [
          { topicId: 14, label: 'GitHub', action: 'confirm GitHub permissions', url: 'https://gh' },
          { topicId: 22, label: 'Invoice', action: 'pay invoice', url: null },
        ]),
      };
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: anthropic as any,
        topicStore: topicStore as any,
      });
      const result = await h.run({
        db: getDb(),
        signal: new AbortController().signal,
        firedAt: Date.now(),
      });
      expect(topicStore.getOpenActions).toHaveBeenCalled();
      expect(result).toMatchObject({ publish: true, content: 'brief text' });
      const components = (result as any).components;
      expect(components).toHaveLength(1);
      expect(components[0].buttons.map((b: any) => b.customId)).toEqual([
        'followup:done:14',
        'followup:done:22',
      ]);
    });

    it('omits components when topicStore has no open actions', async () => {
      const anthropic = fakeAnthropic('brief text');
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: anthropic as any,
        topicStore: { getOpenActions: () => [] } as any,
      });
      const result = await h.run({
        db: getDb(),
        signal: new AbortController().signal,
        firedAt: Date.now(),
      });
      expect(result).toEqual({ publish: true, content: 'brief text' });
      expect('components' in (result as any)).toBe(false);
    });

    it('returns skip when AI returns empty text', async () => {
      const anthropic = fakeAnthropic('');
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: anthropic as any,
      });
      const result = await h.run({
        db: getDb(),
        signal: new AbortController().signal,
        firedAt: Date.now(),
      });
      expect(result).toEqual({ skip: true, reason: 'empty AI response' });
    });

    it('returns error when anthropic throws', async () => {
      const anthropic = {
        messages: {
          create: vi.fn(async () => {
            throw new Error('boom');
          }),
        },
      };
      const h = createMorningBriefHandler({
        piiProxy: fakeProxy(),
        anthropic: anthropic as any,
      });
      const result = await h.run({
        db: getDb(),
        signal: new AbortController().signal,
        firedAt: Date.now(),
      });
      expect(result).toEqual({ error: true, message: 'boom' });
    });

    it('uses ollama when LOCAL_LLM_MODE=enabled and ollama wired', async () => {
      const original = process.env.LOCAL_LLM_MODE;
      process.env.LOCAL_LLM_MODE = 'enabled';
      try {
        const anthropic = fakeAnthropic('from-claude');
        const ollama = { chat: vi.fn(async () => ({ text: 'от локалки' })) };
        const h = createMorningBriefHandler({
          piiProxy: fakeProxy(),
          anthropic: anthropic as any,
          ollama: ollama as any,
        });
        const result = await h.run({
          db: getDb(),
          signal: new AbortController().signal,
          firedAt: Date.now(),
        });
        expect(result).toEqual({ publish: true, content: 'от локалки' });
        expect(ollama.chat).toHaveBeenCalledOnce();
        expect(anthropic.messages.create).not.toHaveBeenCalled();
      } finally {
        if (original === undefined) delete process.env.LOCAL_LLM_MODE;
        else process.env.LOCAL_LLM_MODE = original;
      }
    });
  });
});
