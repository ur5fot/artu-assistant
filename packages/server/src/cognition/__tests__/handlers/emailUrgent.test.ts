import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../../../db.js';
import { createEmailStore } from '../../../emails/store.js';
import { createEmailUrgentHandler } from '../../handlers/emailUrgent.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => closeDb());

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

  it('returns false at 03:00 local — overnight quiet runs until morning release', async () => {
    // Without an explicit morning gate the handler would fire at 02:00/03:00
    // and ping the user mid-sleep. Plan promised "suppressed during quiet
    // hours" and "night catch-up", so the overnight window has to hold
    // through MORNING_FALLBACK_HOUR.
    const store = createEmailStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 3 - 3); // 03:00 Kyiv
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);
  });

  it('returns true at 09:00 local — morning release, catch-up begins', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 9 - 3); // 09:00 Kyiv
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(true);
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
      expect(snippetLine.length).toBe(200);
      expect(snippetLine.endsWith('…')).toBe(true);
    }
  });

  it('passes a snippet of exactly 200 chars through verbatim (no ellipsis)', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, tz: TZ, quietStart: 22 });
    const exactlyMax = 'a'.repeat(200);
    mkPending({
      uid: 1, importance: 5, received_at: 1000,
      from: 'x@y.com', subject: 's', snippet: exactlyMax,
    });
    const res = await h.run(mkCtx(Date.now()));
    expect('publish' in res && res.publish).toBe(true);
    if ('publish' in res && res.publish) {
      const snippetLine = res.content.split('\n')[2];
      expect(snippetLine).toBe(exactlyMax);
      expect(snippetLine.endsWith('…')).toBe(false);
    }
  });

  it('truncates a 201-char snippet to exactly 200 chars (199 + ellipsis)', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, tz: TZ, quietStart: 22 });
    const overMax = 'a'.repeat(201);
    mkPending({
      uid: 1, importance: 5, received_at: 1000,
      from: 'x@y.com', subject: 's', snippet: overMax,
    });
    const res = await h.run(mkCtx(Date.now()));
    expect('publish' in res && res.publish).toBe(true);
    if ('publish' in res && res.publish) {
      const snippetLine = res.content.split('\n')[2];
      expect(snippetLine.length).toBe(200);
      expect(snippetLine).toBe('a'.repeat(199) + '…');
    }
  });

  it('normalizes whitespace in from/subject/snippet (collapses newlines/tabs)', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, tz: TZ, quietStart: 22 });
    mkPending({
      uid: 1, importance: 5, received_at: 1000,
      from: 'Boss\nBoss\t<boss@acme.com>',
      subject: 'line1\nline2\t  end',
      snippet: '  one\n\ntwo\rthree  ',
    });
    const res = await h.run(mkCtx(Date.now()));
    expect('publish' in res && res.publish).toBe(true);
    if ('publish' in res && res.publish) {
      // Three-line layout must remain intact even when source fields contain
      // raw control whitespace. from_addr can carry \r\n / \t from
      // decodeHeader() on malformed From: headers.
      const lines = res.content.split('\n');
      expect(lines.length).toBe(3);
      expect(lines[0]).toBe('🚨 Boss Boss <boss@acme.com>');
      expect(lines[1]).toBe('line1 line2 end');
      expect(lines[2]).toBe('one two three');
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
