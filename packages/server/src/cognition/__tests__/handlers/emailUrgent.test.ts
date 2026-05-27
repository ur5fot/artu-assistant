import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../../db.js';
import { createEmailStore } from '../../../emails/store.js';
import { createEmailUrgentHandler } from '../../handlers/emailUrgent.js';

beforeEach(() => initDb(':memory:'));

function mkCtx(firedAt: number) {
  return { db: getDb(), firedAt, signal: new AbortController().signal };
}

function mkPending(opts: {
  uid: number;
  importance: number;
  received_at: number;
  from?: string;
  subject?: string;
  snippet?: string;
}) {
  getDb().prepare(`
    INSERT INTO email_pending (account_id, message_uid, from_addr, subject, snippet, importance, received_at, added_at)
    VALUES ('a', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.uid,
    opts.from ?? 'sender@example.com',
    opts.subject ?? 'subject',
    opts.snippet ?? 'snip',
    opts.importance,
    opts.received_at,
    opts.received_at,
  );
}

const TZ = 'Europe/Kyiv';

describe('createEmailUrgentHandler.trigger', () => {
  it('returns false when no unpinged urgent rows exist', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 4, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 12 - 3); // 12:00 Kyiv
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);
  });

  it('returns true when an unpinged importance=5 row exists outside quiet hours', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 12 - 3); // 12:00 Kyiv
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(true);
  });

  it('returns false during quiet hours even when an urgent row exists', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 23 - 3); // 23:00 Kyiv
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);
  });
});

describe('createEmailUrgentHandler.run', () => {
  it('returns skip when no urgent rows', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, tz: TZ, quietStart: 22 });
    const res = await h.run(mkCtx(Date.now()));
    expect(res).toEqual({ skip: true, reason: 'no unpinged urgent row' });
  });

  it('formats content with from/subject/snippet correctly', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, tz: TZ, quietStart: 22 });
    mkPending({
      uid: 1,
      importance: 5,
      received_at: 1000,
      from: 'boss@acme.com',
      subject: 'Server down',
      snippet: 'Prod is on fire',
    });
    const res = await h.run(mkCtx(Date.now()));
    expect('publish' in res && res.publish).toBe(true);
    if ('publish' in res && res.publish) {
      expect(res.content).toBe('🚨 boss@acme.com\nServer down\nProd is on fire');
    }
  });

  it('truncates snippet > 200 chars with ellipsis', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, tz: TZ, quietStart: 22 });
    const longSnippet = 'a'.repeat(250);
    mkPending({
      uid: 1,
      importance: 5,
      received_at: 1000,
      from: 'x@y.com',
      subject: 's',
      snippet: longSnippet,
    });
    const res = await h.run(mkCtx(Date.now()));
    expect('publish' in res && res.publish).toBe(true);
    if ('publish' in res && res.publish) {
      const lines = res.content.split('\n');
      const snippetLine = lines[2];
      expect(snippetLine.length).toBeLessThanOrEqual(200);
      expect(snippetLine.endsWith('…')).toBe(true);
    }
  });

  it('onPublished calls markUrgentPinged with the row id', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    const res = await h.run(mkCtx(Date.now()));
    expect('publish' in res && res.publish).toBe(true);
    // Before onPublished, the row is still unpinged.
    expect(store.findUnpingedUrgent()).not.toBeNull();
    if ('publish' in res && res.publish && res.onPublished) {
      await res.onPublished();
    }
    expect(store.findUnpingedUrgent()).toBeNull();
  });

  it('second run after onPublished returns skip (row is pinged)', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    const first = await h.run(mkCtx(Date.now()));
    if ('publish' in first && first.publish && first.onPublished) {
      await first.onPublished();
    }
    const again = await h.run(mkCtx(Date.now() + 1000));
    expect(again).toEqual({ skip: true, reason: 'no unpinged urgent row' });
  });
});
