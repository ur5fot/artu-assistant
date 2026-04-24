import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../../db.js';
import { createEmailStore } from '../../../emails/store.js';
import { createEmailDigestHandler } from '../../handlers/emailDigest.js';

beforeEach(() => initDb(':memory:'));

function mkCtx(firedAt: number) {
  return { db: getDb(), firedAt, signal: new AbortController().signal };
}

function mkPending(opts: { uid: number; importance: number; received_at: number; snippet?: string }) {
  getDb().prepare(`
    INSERT INTO email_pending (account_id, message_uid, from_addr, subject, snippet, importance, received_at, added_at)
    VALUES ('a', ?, 'x@y', 's', ?, ?, ?, ?)
  `).run(opts.uid, opts.snippet ?? 'snip', opts.importance, opts.received_at, opts.received_at);
}

function markBriefPublished(at: number) {
  getDb().prepare(
    'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
  ).run('morningBrief', at, 10, 'publish');
}

const TZ = 'Europe/Kyiv';

describe('createEmailDigestHandler.trigger', () => {
  it('returns false when pending < threshold', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 3, cooldownMs: 100, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    mkPending({ uid: 2, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 12 - 3);
    markBriefPublished(Date.UTC(2026, 3, 24, 8 - 3));
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);
  });

  it('returns false during quiet hours (22:00 local)', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 2, cooldownMs: 100, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    mkPending({ uid: 2, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 23 - 3);
    markBriefPublished(Date.UTC(2026, 3, 24, 8 - 3));
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);
  });

  it('returns false when morning-brief has not published today (and brief is recent)', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 2, cooldownMs: 100, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    mkPending({ uid: 2, importance: 5, received_at: 1000 });
    markBriefPublished(Date.UTC(2026, 3, 23, 8 - 3)); // yesterday
    const now = Date.UTC(2026, 3, 24, 7 - 3); // before 09:00 local today
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);
  });

  it('returns false inside cooldown only when last run was a successful publish', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 2, cooldownMs: 60 * 60_000, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    mkPending({ uid: 2, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 12 - 3);
    markBriefPublished(Date.UTC(2026, 3, 24, 8 - 3));
    const fire = await h.trigger(
      { now, lastFiredAt: now - 60_000, lastResult: { publish: true, content: 'x' } },
      { db: getDb() },
    );
    expect(fire).toBe(false);
  });

  it('cooldown does NOT apply after a recent error (retry on next tick)', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 2, cooldownMs: 60 * 60_000, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    mkPending({ uid: 2, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 12 - 3);
    markBriefPublished(Date.UTC(2026, 3, 24, 8 - 3));
    const fire = await h.trigger(
      { now, lastFiredAt: now - 60_000, lastResult: { error: true, message: 'ollama down' } },
      { db: getDb() },
    );
    expect(fire).toBe(true);
  });

  it('cooldown does NOT apply after a recent skip (e.g. no pending before)', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 2, cooldownMs: 60 * 60_000, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    mkPending({ uid: 2, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 12 - 3);
    markBriefPublished(Date.UTC(2026, 3, 24, 8 - 3));
    const fire = await h.trigger(
      { now, lastFiredAt: now - 60_000, lastResult: { skip: true, reason: 'no pending' } },
      { db: getDb() },
    );
    expect(fire).toBe(true);
  });

  it('returns true when threshold met, not quiet, brief-published, cooldown elapsed', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 2, cooldownMs: 100, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    mkPending({ uid: 2, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 12 - 3);
    markBriefPublished(Date.UTC(2026, 3, 24, 8 - 3));
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(true);
  });
});

describe('createEmailDigestHandler.run', () => {
  it('returns skip when no pending rows', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 1, cooldownMs: 100, quietStart: 22 });
    const res = await h.run(mkCtx(Date.now()));
    expect(res).toEqual({ skip: true, reason: 'no pending' });
  });

  it('publishes digest and marks rows delivered', async () => {
    const store = createEmailStore({ db: getDb() });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    mkPending({ uid: 2, importance: 4, received_at: 1000 });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 1, cooldownMs: 100, quietStart: 22 });
    const now = Date.UTC(2026, 3, 24, 12 - 3);
    const res = await h.run(mkCtx(now));
    expect('publish' in res && res.publish).toBe(true);
    expect(store.countPendingUndelivered()).toBe(0);
  });

  it('truncation-aware: rows folded into "…ещё N" tail are NOT marked delivered', async () => {
    const store = createEmailStore({ db: getDb() });
    // 60 rows, each snippet 100 chars → digest will overflow 2000 chars.
    for (let i = 1; i <= 60; i++) {
      mkPending({ uid: i, importance: 5, received_at: 1000 + i, snippet: 'a'.repeat(100) });
    }
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 1, cooldownMs: 100, quietStart: 22 });
    const now = Date.UTC(2026, 3, 24, 12 - 3);
    const res = await h.run(mkCtx(now));
    expect('publish' in res && res.publish).toBe(true);
    const remaining = store.countPendingUndelivered();
    expect(remaining).toBeGreaterThan(0); // the "…ещё N" tail rows are still pending
  });

  it('re-run after publish returns skip (markDelivered is idempotent)', async () => {
    const store = createEmailStore({ db: getDb() });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 1, cooldownMs: 100, quietStart: 22 });
    const now = Date.UTC(2026, 3, 24, 12 - 3);
    await h.run(mkCtx(now));
    const again = await h.run(mkCtx(now + 1000));
    expect(again).toEqual({ skip: true, reason: 'no pending' });
  });
});
