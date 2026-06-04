import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../../../db.js';
import { createEmailStore } from '../../../emails/store.js';
import { createTopicStore, type TopicStore } from '../../../topics/store.js';
import { createEmailActionMatchHandler } from '../../handlers/emailActionMatch.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => closeDb());

function mkCtx(firedAt: number) {
  return { db: getDb(), firedAt, signal: new AbortController().signal };
}

// A fake Anthropic client that returns a canned JSON reply and counts calls so
// tests can assert the LLM is NOT invoked when the cheap gate filters out work.
function fakeAnthropic(reply: string) {
  const calls = { n: 0 };
  const client = {
    messages: {
      create: async () => {
        calls.n++;
        return { content: [{ type: 'text', text: reply }] };
      },
    },
  } as any;
  return { client, calls };
}

// Create a finalized topic that still owes an external action (an open action).
function mkAction(
  store: TopicStore,
  opts: { label: string; action: string; url: string | null; finalizedAt: number },
): number {
  const t = store.createOpen(opts.finalizedAt - 1000, 'discord');
  store.finalize(t.id, opts.label, 'sum', 5, opts.finalizedAt, opts.action, opts.url);
  return t.id;
}

function mkEmail(opts: {
  uid: number;
  from: string;
  subject: string;
  snippet?: string;
  received_at: number;
  importance?: number;
}) {
  getDb()
    .prepare(
      `INSERT INTO email_pending (account_id, message_uid, from_addr, subject, snippet, importance, received_at, added_at)
       VALUES ('a', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.uid,
      opts.from,
      opts.subject,
      opts.snippet ?? 'snip',
      opts.importance ?? 2,
      opts.received_at,
      opts.received_at,
    );
}

const NOW = 1_000_000_000_000;

describe('createEmailActionMatchHandler.trigger', () => {
  it('returns false (no LLM) when there are no open actions', async () => {
    const emailStore = createEmailStore({ db: getDb() });
    const topicStore = createTopicStore({ db: getDb() });
    const { client, calls } = fakeAnthropic('[]');
    const h = createEmailActionMatchHandler({ emailStore, topicStore, anthropic: client, ollama: null });
    const fire = await h.trigger({ now: NOW, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);
    expect(calls.n).toBe(0);
  });

  it('returns true when at least one open action exists', async () => {
    const emailStore = createEmailStore({ db: getDb() });
    const topicStore = createTopicStore({ db: getDb() });
    mkAction(topicStore, { label: 'счёт', action: 'оплатить счёт', url: null, finalizedAt: NOW });
    const { client } = fakeAnthropic('[]');
    const h = createEmailActionMatchHandler({ emailStore, topicStore, anthropic: client, ollama: null });
    const fire = await h.trigger({ now: NOW, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(true);
  });

  it('returns false right after a successful publish (cooldown)', async () => {
    const emailStore = createEmailStore({ db: getDb() });
    const topicStore = createTopicStore({ db: getDb() });
    mkAction(topicStore, { label: 'счёт', action: 'оплатить счёт', url: null, finalizedAt: NOW });
    const { client } = fakeAnthropic('[]');
    const h = createEmailActionMatchHandler({
      emailStore,
      topicStore,
      anthropic: client,
      ollama: null,
      cooldownMs: 3600_000,
    });
    const state = {
      now: NOW + 1000,
      lastFiredAt: NOW,
      lastResult: { publish: true as const, content: 'x' },
    };
    expect(await h.trigger(state, { db: getDb() })).toBe(false);
  });
});

describe('createEmailActionMatchHandler.run', () => {
  it('closes a matched action and returns a notice with a reopen button', async () => {
    const emailStore = createEmailStore({ db: getDb() });
    const topicStore = createTopicStore({ db: getDb() });
    const topicId = mkAction(topicStore, {
      label: 'банк',
      action: 'подтвердить оплату в банке',
      url: 'https://bank.test/pay',
      finalizedAt: NOW,
    });
    mkEmail({
      uid: 1,
      from: 'noreply@bank.test',
      subject: 'Платёж получен',
      snippet: 'Ваш платёж успешно проведён.',
      received_at: NOW - 3600_000,
    });
    const { client, calls } = fakeAnthropic('[{"i":0,"match":true}]');
    const h = createEmailActionMatchHandler({ emailStore, topicStore, anthropic: client, ollama: null });

    const result = await h.run(mkCtx(NOW));
    expect('publish' in result && result.publish).toBe(true);
    if (!('publish' in result)) throw new Error('expected publish');
    expect(calls.n).toBe(1);
    expect(result.content).toContain('подтвердить оплату в банке');
    const ids = result.components?.flatMap((r) => r.buttons.map((b) => b.customId)) ?? [];
    expect(ids).toContain(`followup:reopen:${topicId}`);

    // Not dismissed until the publish lands.
    expect(topicStore.getOpenActions()).toHaveLength(1);
    await result.onPublished?.();
    expect(topicStore.getOpenActions()).toHaveLength(0);
  });

  it('skips without calling the LLM when no email matches by domain or keyword', async () => {
    const emailStore = createEmailStore({ db: getDb() });
    const topicStore = createTopicStore({ db: getDb() });
    mkAction(topicStore, {
      label: 'spotify',
      action: 'оформить подписку spotify',
      url: 'https://spotify.test/account',
      finalizedAt: NOW,
    });
    mkEmail({
      uid: 1,
      from: 'news@othersite.test',
      subject: 'Скидки недели',
      snippet: 'Лучшие предложения для вас.',
      received_at: NOW - 3600_000,
    });
    const { client, calls } = fakeAnthropic('[{"i":0,"match":true}]');
    const h = createEmailActionMatchHandler({ emailStore, topicStore, anthropic: client, ollama: null });

    const result = await h.run(mkCtx(NOW));
    expect('skip' in result && result.skip).toBe(true);
    expect(calls.n).toBe(0);
    expect(topicStore.getOpenActions()).toHaveLength(1);
  });

  it('does not close when the LLM says the email is not a confirmation', async () => {
    const emailStore = createEmailStore({ db: getDb() });
    const topicStore = createTopicStore({ db: getDb() });
    mkAction(topicStore, {
      label: 'банк',
      action: 'подтвердить оплату в банке',
      url: 'https://bank.test/pay',
      finalizedAt: NOW,
    });
    mkEmail({
      uid: 1,
      from: 'noreply@bank.test',
      subject: 'Напоминание об оплате',
      snippet: 'Не забудьте оплатить.',
      received_at: NOW - 3600_000,
    });
    const { client, calls } = fakeAnthropic('[{"i":0,"match":false}]');
    const h = createEmailActionMatchHandler({ emailStore, topicStore, anthropic: client, ollama: null });

    const result = await h.run(mkCtx(NOW));
    expect('skip' in result && result.skip).toBe(true);
    expect(calls.n).toBe(1);
    expect(topicStore.getOpenActions()).toHaveLength(1);
  });

  it('skips when there are no open actions (already dismissed → untouched)', async () => {
    const emailStore = createEmailStore({ db: getDb() });
    const topicStore = createTopicStore({ db: getDb() });
    const topicId = mkAction(topicStore, {
      label: 'банк',
      action: 'подтвердить оплату в банке',
      url: 'https://bank.test/pay',
      finalizedAt: NOW,
    });
    topicStore.dismissAction(topicId, NOW - 10_000);
    mkEmail({
      uid: 1,
      from: 'noreply@bank.test',
      subject: 'Платёж получен',
      received_at: NOW - 3600_000,
    });
    const { client, calls } = fakeAnthropic('[{"i":0,"match":true}]');
    const h = createEmailActionMatchHandler({ emailStore, topicStore, anthropic: client, ollama: null });

    const result = await h.run(mkCtx(NOW));
    expect('skip' in result && result.skip).toBe(true);
    expect(calls.n).toBe(0);
  });

  it('closes a keyword-matched action even when domains differ', async () => {
    const emailStore = createEmailStore({ db: getDb() });
    const topicStore = createTopicStore({ db: getDb() });
    const topicId = mkAction(topicStore, {
      label: 'паспорт',
      action: 'обновить загранпаспорт',
      url: null,
      finalizedAt: NOW,
    });
    mkEmail({
      uid: 1,
      from: 'service@gov.test',
      subject: 'Загранпаспорт готов к выдаче',
      snippet: 'Ваш документ оформлен.',
      received_at: NOW - 3600_000,
    });
    const { client, calls } = fakeAnthropic('[{"i":0,"match":true}]');
    const h = createEmailActionMatchHandler({ emailStore, topicStore, anthropic: client, ollama: null });

    const result = await h.run(mkCtx(NOW));
    expect('publish' in result && result.publish).toBe(true);
    expect(calls.n).toBe(1);
    await (result as any).onPublished?.();
    expect(topicStore.getOpenActions()).toHaveLength(0);
    expect(topicId).toBeGreaterThan(0);
  });
});
