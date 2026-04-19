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
