import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db.js';
import { createEmailStore } from '../store.js';
import { createEmailFeedbackStore } from '../feedback-store.js';

beforeEach(() => initDb(':memory:'));

/** Insert an email_pending row and return its auto-assigned id. */
function insertPending(opts: {
  account_id?: string;
  message_uid: number;
  from_addr: string;
  received_at?: number;
}): number {
  const db = getDb();
  const store = createEmailStore({ db });
  store.insertPending({
    account_id: opts.account_id ?? 'acc1',
    message_uid: opts.message_uid,
    from_addr: opts.from_addr,
    subject: 's',
    snippet: 'x',
    importance: 5,
    received_at: opts.received_at ?? 1000,
    added_at: opts.received_at ?? 1000,
  });
  const row = db
    .prepare(
      'SELECT id FROM email_pending WHERE account_id = ? AND message_uid = ?',
    )
    .get(opts.account_id ?? 'acc1', opts.message_uid) as { id: number };
  return row.id;
}

const HOUR = 3600_000;

describe('createEmailFeedbackStore', () => {
  it('recordPinged inserts a row and is idempotent on pending_id', () => {
    const db = getDb();
    const store = createEmailFeedbackStore({ db });
    const id = insertPending({ message_uid: 1, from_addr: 'a@b' });

    store.recordPinged(id, 1000);
    store.recordPinged(id, 2000); // duplicate ping — must not throw/duplicate

    const rows = db
      .prepare('SELECT * FROM email_feedback WHERE pending_id = ?')
      .all(id) as Array<{ pinged_at: number; resolved_at: number | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pinged_at).toBe(1000); // first ping wins
    expect(rows[0]!.resolved_at).toBeNull();
  });

  it('findUnresolved returns unresolved rows within the age window, oldest first', () => {
    const db = getDb();
    const store = createEmailFeedbackStore({ db });
    const now = 100 * HOUR;

    const recent = insertPending({ message_uid: 1, from_addr: 'a@b' });
    const older = insertPending({ message_uid: 2, from_addr: 'c@d' });
    store.recordPinged(recent, now - 2 * HOUR);
    store.recordPinged(older, now - 5 * HOUR);

    const res = store.findUnresolved(now, 24 * HOUR, 50);
    expect(res.map((r) => r.pending_id)).toEqual([older, recent]); // oldest first
    expect(res[0]!.account_id).toBe('acc1');
    expect(res[0]!.message_uid).toBe(2);
    expect(res[0]!.from_addr).toBe('c@d');
  });

  it('findUnresolved excludes rows outside the age window (boundary)', () => {
    const db = getDb();
    const store = createEmailFeedbackStore({ db });
    const now = 100 * HOUR;
    const maxAge = 24 * HOUR;

    const onBoundary = insertPending({ message_uid: 1, from_addr: 'a@b' });
    const tooOld = insertPending({ message_uid: 2, from_addr: 'c@d' });
    store.recordPinged(onBoundary, now - maxAge); // exactly at edge → included
    store.recordPinged(tooOld, now - maxAge - 1); // just past edge → excluded

    const res = store.findUnresolved(now, maxAge, 50);
    expect(res.map((r) => r.pending_id)).toEqual([onBoundary]);
  });

  it('findUnresolved excludes resolved rows and respects the limit', () => {
    const db = getDb();
    const store = createEmailFeedbackStore({ db });
    const now = 100 * HOUR;

    const a = insertPending({ message_uid: 1, from_addr: 'a@b' });
    const b = insertPending({ message_uid: 2, from_addr: 'c@d' });
    const c = insertPending({ message_uid: 3, from_addr: 'e@f' });
    store.recordPinged(a, now - 3 * HOUR);
    store.recordPinged(b, now - 2 * HOUR);
    store.recordPinged(c, now - 1 * HOUR);
    store.finalize(a, 'replied', now); // resolved → excluded

    expect(store.findUnresolved(now, 24 * HOUR, 50).map((r) => r.pending_id)).toEqual([b, c]);
    expect(store.findUnresolved(now, 24 * HOUR, 1).map((r) => r.pending_id)).toEqual([b]);
  });

  it('updateFlags sets timestamps and COALESCE keeps the earliest non-null', () => {
    const db = getDb();
    const store = createEmailFeedbackStore({ db });
    const id = insertPending({ message_uid: 1, from_addr: 'a@b' });
    store.recordPinged(id, 1000);

    store.updateFlags(id, { seenAt: 2000 });
    store.updateFlags(id, { seenAt: 9999, answeredAt: 3000 }); // seen already set

    const row = db
      .prepare('SELECT seen_at, answered_at FROM email_feedback WHERE pending_id = ?')
      .get(id) as { seen_at: number | null; answered_at: number | null };
    expect(row.seen_at).toBe(2000); // not clobbered
    expect(row.answered_at).toBe(3000);
  });

  it('finalize sets outcome and resolved_at', () => {
    const db = getDb();
    const store = createEmailFeedbackStore({ db });
    const id = insertPending({ message_uid: 1, from_addr: 'a@b' });
    store.recordPinged(id, 1000);

    store.finalize(id, 'ignored', 5000);

    const row = db
      .prepare('SELECT outcome, resolved_at FROM email_feedback WHERE pending_id = ?')
      .get(id) as { outcome: string; resolved_at: number };
    expect(row.outcome).toBe('ignored');
    expect(row.resolved_at).toBe(5000);
  });

  it('recentOutcomesBySender aggregates resolved outcomes within the lookback', () => {
    const db = getDb();
    const store = createEmailFeedbackStore({ db });
    const now = 100 * HOUR;
    const lookback = 24 * HOUR;

    // Same sender, display-name variants → must collapse to one sender.
    const mk = (uid: number, from: string, ago: number, outcome: 'replied' | 'read' | 'ignored') => {
      const id = insertPending({ message_uid: uid, from_addr: from });
      store.recordPinged(id, now - ago);
      store.finalize(id, outcome, now - ago + HOUR);
      return id;
    };
    mk(1, '"Bob" <bob@x.com>', 2 * HOUR, 'ignored');
    mk(2, '"Bob Smith" <bob@x.com>', 3 * HOUR, 'read');
    mk(3, 'bob@x.com', 4 * HOUR, 'ignored');
    mk(4, 'bob@x.com', 30 * HOUR, 'replied'); // outside lookback → excluded
    mk(5, 'other@y.com', 1 * HOUR, 'ignored'); // different sender → excluded

    const counts = store.recentOutcomesBySender('bob@x.com', lookback, now);
    expect(counts).toEqual({ replied: 0, read: 1, ignored: 2 });
  });

  it('recentOutcomesBySender returns zeros for an unknown sender', () => {
    const db = getDb();
    const store = createEmailFeedbackStore({ db });
    expect(store.recentOutcomesBySender('nobody@x.com', 24 * HOUR, 100 * HOUR)).toEqual({
      replied: 0,
      read: 0,
      ignored: 0,
    });
  });
});
