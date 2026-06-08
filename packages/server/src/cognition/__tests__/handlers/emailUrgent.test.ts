import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../../../db.js';
import { buttonsOf } from '../../types.js';
import { createEmailStore } from '../../../emails/store.js';
import { createEmailSuppressionStore } from '../../../emails/suppression-store.js';
import { createEmailFeedbackStore } from '../../../emails/feedback-store.js';
import { createEmailUrgentHandler, SUPPRESSED_PING_SENTINEL } from '../../handlers/emailUrgent.js';

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
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 4, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 12 - 3); // 12:00 Kyiv
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);
  });

  it('returns true when an unpinged importance=5 row exists outside quiet hours', async () => {
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 12 - 3); // 12:00 Kyiv
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(true);
  });

  it('returns false during quiet hours even when an urgent row exists', async () => {
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
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
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 3 - 3); // 03:00 Kyiv
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);
  });

  it('returns true at 09:00 local — morning release, catch-up begins', async () => {
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 9 - 3); // 09:00 Kyiv
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(true);
  });
});

describe('createEmailUrgentHandler.run', () => {
  it('returns skip when no urgent rows', async () => {
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
    const res = await h.run(mkCtx(Date.now()));
    expect(res).toEqual({ skip: true, reason: 'no unpinged urgent row' });
  });

  it('formats content with from/subject/snippet correctly', async () => {
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
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
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
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
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
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
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
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
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
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
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
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
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    const first = await h.run(mkCtx(Date.now()));
    if ('publish' in first && first.publish && first.onPublished) {
      await first.onPublished();
    }
    const again = await h.run(mkCtx(Date.now() + 1000));
    expect(again).toEqual({ skip: true, reason: 'no unpinged urgent row' });
  });

  it('result includes embed + components with a Draft reply button keyed by row id', async () => {
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
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
      expect(res.embed).toBeDefined();
      expect(res.embed!.title).toBe('🚨 Urgent email');
      expect(res.components).toBeDefined();
      const buttons = buttonsOf(res.components![0]);
      expect(buttons).toHaveLength(3);
      // customId encodes the email_pending row id (autoincrement so look it up)
      const rowId = store.findUnpingedUrgent()!.id;
      expect(buttons[0]!.customId).toBe(`email_draft:start:${rowId}`);
      expect(buttons[0]!.label).toBe('Draft reply');
      expect(buttons[0]!.style).toBe('primary');
      expect(buttons[1]!.customId).toBe(`email_suppress:sender_start:${rowId}`);
      expect(buttons[1]!.style).toBe('secondary');
      expect(buttons[2]!.customId).toBe(`email_suppress:subject_start:${rowId}`);
      expect(buttons[2]!.style).toBe('secondary');
    }
  });
});

describe('createEmailUrgentHandler.trigger — suppression gate', () => {
  const noon = Date.UTC(2026, 3, 24, 12 - 3); // 12:00 Kyiv, outside quiet hours

  it('returns false and marks row -1 when a sender suppression rule matches', async () => {
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000, from: 'spam@bank.com' });
    suppressionStore.insertRule({ rule_type: 'sender', pattern: 'spam@bank.com', ttl_days: 7 });

    const fire = await h.trigger({ now: noon, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);

    const row = getDb()
      .prepare('SELECT urgent_pinged_at FROM email_pending WHERE message_uid = 1')
      .get() as { urgent_pinged_at: number | null };
    expect(row.urgent_pinged_at).toBe(SUPPRESSED_PING_SENTINEL);
    // findUnpingedUrgent should now skip this row (urgent_pinged_at = -1 is
    // not NULL, so excluded by the candidate query).
    expect(store.findUnpingedUrgent()).toBeNull();
  });

  it('returns false and marks row -1 when a subject suppression rule matches', async () => {
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
    mkPending({
      uid: 1,
      importance: 5,
      received_at: 1000,
      from: 'noreply@shop.com',
      subject: 'Your order shipped — track now',
    });
    // Case-insensitive substring match: "ORDER SHIPPED" should match
    // "Your order shipped — …".
    suppressionStore.insertRule({ rule_type: 'subject', pattern: 'ORDER SHIPPED', ttl_days: 30 });

    const fire = await h.trigger({ now: noon, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);

    const row = getDb()
      .prepare('SELECT urgent_pinged_at FROM email_pending WHERE message_uid = 1')
      .get() as { urgent_pinged_at: number | null };
    expect(row.urgent_pinged_at).toBe(SUPPRESSED_PING_SENTINEL);
  });

  it('returns true and does NOT mark the row when no rule matches', async () => {
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000, from: 'boss@acme.com' });
    // Rule for a different sender — must not suppress.
    suppressionStore.insertRule({ rule_type: 'sender', pattern: 'spam@bank.com', ttl_days: 7 });

    const fire = await h.trigger({ now: noon, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(true);

    const row = getDb()
      .prepare('SELECT urgent_pinged_at FROM email_pending WHERE message_uid = 1')
      .get() as { urgent_pinged_at: number | null };
    expect(row.urgent_pinged_at).toBeNull();
  });

  it('returns true when the matching rule has expired', async () => {
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000, from: 'spam@bank.com' });
    // Insert a 1-day rule "yesterday" by hand-crafted expires_at so it is
    // already expired by `noon`. insertRule uses Date.now() for created_at;
    // we patch the row directly to keep the test hermetic.
    suppressionStore.insertRule({ rule_type: 'sender', pattern: 'spam@bank.com', ttl_days: 1 });
    getDb()
      .prepare('UPDATE email_suppression_rules SET expires_at = ? WHERE pattern = ?')
      .run(noon - 1000, 'spam@bank.com');

    const fire = await h.trigger({ now: noon, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(true);

    const row = getDb()
      .prepare('SELECT urgent_pinged_at FROM email_pending WHERE message_uid = 1')
      .get() as { urgent_pinged_at: number | null };
    expect(row.urgent_pinged_at).toBeNull();
  });

  it('drains a backlog of suppressed candidates in a single tick', async () => {
    // Regression: previously the trigger only ever inspected the single
    // oldest urgent candidate. A backlog of N suppressed rows ahead of a
    // genuine urgent row would delay the real ping by N heartbeat ticks
    // (~60s each). The loop must keep marking suppressed candidates with
    // the sentinel until it reaches an unsuppressed row.
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
    // Three suppressed rows ordered oldest-first; one unsuppressed row last.
    mkPending({ uid: 1, importance: 5, received_at: 1000, from: 'spam@bank.com' });
    mkPending({ uid: 2, importance: 5, received_at: 2000, from: 'spam@bank.com' });
    mkPending({ uid: 3, importance: 5, received_at: 3000, from: 'spam@bank.com' });
    mkPending({ uid: 4, importance: 5, received_at: 4000, from: 'boss@acme.com' });
    suppressionStore.insertRule({ rule_type: 'sender', pattern: 'spam@bank.com', ttl_days: 7 });

    const fire = await h.trigger({ now: noon, lastFiredAt: null, lastResult: null }, { db: getDb() });
    // Trigger should report fireable because row 4 is reachable in this tick.
    expect(fire).toBe(true);
    // All three suppressed rows are now stamped with the sentinel, freeing
    // the candidate queue.
    const sentinels = getDb()
      .prepare("SELECT message_uid, urgent_pinged_at FROM email_pending WHERE message_uid IN (1, 2, 3) ORDER BY message_uid")
      .all() as Array<{ message_uid: number; urgent_pinged_at: number | null }>;
    expect(sentinels.map((r) => r.urgent_pinged_at)).toEqual([
      SUPPRESSED_PING_SENTINEL,
      SUPPRESSED_PING_SENTINEL,
      SUPPRESSED_PING_SENTINEL,
    ]);
    // Row 4 is the next candidate findUnpingedUrgent surfaces.
    expect(store.findUnpingedUrgent()?.message_uid).toBe(4);
  });

  it('drains and returns false when every remaining candidate is suppressed', async () => {
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000, from: 'spam@bank.com' });
    mkPending({ uid: 2, importance: 5, received_at: 2000, from: 'spam@bank.com' });
    suppressionStore.insertRule({ rule_type: 'sender', pattern: 'spam@bank.com', ttl_days: 7 });

    const fire = await h.trigger({ now: noon, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);
    // Both rows marked, no candidates remain for the urgent path.
    expect(store.findUnpingedUrgent()).toBeNull();
  });

  it('run() suppresses + marks sentinel when a rule appears between trigger and run', async () => {
    // Race window: trigger sees an unsuppressed row, the queue delays run by
    // some seconds, and a rule matching that row gets created in between
    // (e.g., user clicks 🙈 Sender on a prior ping from the same sender).
    // run() must re-check suppression, NOT publish, and stamp the sentinel so
    // the row stays out of subsequent urgent attempts.
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000, from: 'spam@bank.com' });

    const fire = await h.trigger({ now: noon, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(true);

    // Rule appears between trigger and run.
    suppressionStore.insertRule({ rule_type: 'sender', pattern: 'spam@bank.com', ttl_days: 7 });

    const res = await h.run(mkCtx(noon));
    expect(res).toEqual({ skip: true, reason: 'no unpinged urgent row' });

    const row = getDb()
      .prepare('SELECT urgent_pinged_at FROM email_pending WHERE message_uid = 1')
      .get() as { urgent_pinged_at: number | null };
    expect(row.urgent_pinged_at).toBe(SUPPRESSED_PING_SENTINEL);
  });

  it('still respects quiet hours regardless of suppression rules', async () => {
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000, from: 'spam@bank.com' });
    suppressionStore.insertRule({ rule_type: 'sender', pattern: 'spam@bank.com', ttl_days: 7 });

    // 23:00 Kyiv — quiet hours short-circuits before suppression check.
    const night = Date.UTC(2026, 3, 24, 23 - 3);
    const fire = await h.trigger({ now: night, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);

    // Critically, the row was NOT marked -1: quiet hours is a "try again
    // later" condition, not a permanent suppression decision.
    const row = getDb()
      .prepare('SELECT urgent_pinged_at FROM email_pending WHERE message_uid = 1')
      .get() as { urgent_pinged_at: number | null };
    expect(row.urgent_pinged_at).toBeNull();
  });
});

describe('createEmailUrgentHandler.run — implicit feedback row', () => {
  function feedbackRowFor(pendingId: number) {
    return getDb()
      .prepare('SELECT pending_id, pinged_at FROM email_feedback WHERE pending_id = ?')
      .get(pendingId) as { pending_id: number; pinged_at: number } | undefined;
  }

  it('records a feedback row with pinged_at on publish when feedbackStore present', async () => {
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const feedbackStore = createEmailFeedbackStore({ db: getDb() });
    const h = createEmailUrgentHandler({
      store,
      suppressionStore,
      feedbackStore,
      tz: TZ,
      quietStart: 22,
    });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    const rowId = store.findUnpingedUrgent()!.id;

    const res = await h.run(mkCtx(Date.now()));
    expect('publish' in res && res.publish).toBe(true);
    // No feedback row until onPublished actually fires.
    expect(feedbackRowFor(rowId)).toBeUndefined();
    if ('publish' in res && res.publish && res.onPublished) {
      await res.onPublished();
    }
    const fb = feedbackRowFor(rowId);
    expect(fb).toBeDefined();
    expect(fb!.pending_id).toBe(rowId);
    // pinged_at equals the marker stamped on email_pending (same epoch).
    const ping = getDb()
      .prepare('SELECT urgent_pinged_at FROM email_pending WHERE id = ?')
      .get(rowId) as { urgent_pinged_at: number };
    expect(fb!.pinged_at).toBe(ping.urgent_pinged_at);
  });

  it('does NOT create a feedback row for a suppressed (-1) row', async () => {
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const feedbackStore = createEmailFeedbackStore({ db: getDb() });
    const h = createEmailUrgentHandler({
      store,
      suppressionStore,
      feedbackStore,
      tz: TZ,
      quietStart: 22,
    });
    mkPending({ uid: 1, importance: 5, received_at: 1000, from: 'spam@bank.com' });
    const rowId = store.findUnpingedUrgent()!.id;
    suppressionStore.insertRule({ rule_type: 'sender', pattern: 'spam@bank.com', ttl_days: 7 });

    const noon = Date.UTC(2026, 3, 24, 12 - 3);
    const fire = await h.trigger({ now: noon, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);

    // Row is sentinel-marked (demoted to digest) and no feedback row exists.
    const ping = getDb()
      .prepare('SELECT urgent_pinged_at FROM email_pending WHERE id = ?')
      .get(rowId) as { urgent_pinged_at: number | null };
    expect(ping.urgent_pinged_at).toBe(SUPPRESSED_PING_SENTINEL);
    expect(feedbackRowFor(rowId)).toBeUndefined();
    const count = getDb()
      .prepare('SELECT COUNT(*) AS n FROM email_feedback')
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('no-ops (no feedback row, publishes normally) when feedbackStore absent', async () => {
    const store = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const h = createEmailUrgentHandler({ store, suppressionStore, tz: TZ, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    const rowId = store.findUnpingedUrgent()!.id;

    const res = await h.run(mkCtx(Date.now()));
    expect('publish' in res && res.publish).toBe(true);
    if ('publish' in res && res.publish && res.onPublished) {
      await res.onPublished();
    }
    // Marker still stamped, but no feedback row (and no crash).
    const ping = getDb()
      .prepare('SELECT urgent_pinged_at FROM email_pending WHERE id = ?')
      .get(rowId) as { urgent_pinged_at: number | null };
    expect(ping.urgent_pinged_at).toBeGreaterThan(0);
    expect(feedbackRowFor(rowId)).toBeUndefined();
  });
});
