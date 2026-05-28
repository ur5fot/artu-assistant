import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db.js';
import { createEmailStore } from '../store.js';

beforeEach(() => initDb(':memory:'));

describe('createEmailStore', () => {
  it('getLastSeenUid returns 0 for unknown account', () => {
    const store = createEmailStore({ db: getDb() });
    expect(store.getLastSeenUid('missing')).toBe(0);
  });

  it('updateLastSeenUid upserts row', () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('acc1', 42, 1000);
    expect(store.getLastSeenUid('acc1')).toBe(42);
    store.updateLastSeenUid('acc1', 99, 2000);
    expect(store.getLastSeenUid('acc1')).toBe(99);
  });

  it('hasAccountState distinguishes "no row" from "row with uid=0"', () => {
    const store = createEmailStore({ db: getDb() });
    expect(store.hasAccountState('acc1')).toBe(false);
    store.updateLastSeenUid('acc1', 0, 1000); // probe returned 0 (empty inbox)
    expect(store.hasAccountState('acc1')).toBe(true);
    expect(store.getLastSeenUid('acc1')).toBe(0);
  });

  it('insertPending + countPendingUndelivered respects delivered_at', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'acc1', message_uid: 1, from_addr: 'a@b', subject: 's',
      snippet: 'x', importance: 4, received_at: 1000, added_at: 1000,
    });
    store.insertPending({
      account_id: 'acc1', message_uid: 2, from_addr: 'a@b', subject: 's2',
      snippet: 'y', importance: 5, received_at: 2000, added_at: 2000,
    });
    expect(store.countPendingUndelivered()).toBe(2);
    const rows = store.fetchPendingUndelivered(50);
    store.markDelivered(rows.map((r) => r.id), 3000);
    expect(store.countPendingUndelivered()).toBe(0);
  });

  it('insertPending is idempotent on duplicate (account_id, message_uid)', () => {
    const store = createEmailStore({ db: getDb() });
    const payload = {
      account_id: 'acc1', message_uid: 7, from_addr: 'a@b', subject: 's',
      snippet: 'x', importance: 4, received_at: 1000, added_at: 1000,
    };
    store.insertPending(payload);
    store.insertPending(payload); // should not throw, should not duplicate
    expect(store.countPendingUndelivered()).toBe(1);
  });

  it('fetchPendingUndelivered sorts by importance desc, received_at desc', () => {
    const store = createEmailStore({ db: getDb() });
    const mk = (uid: number, importance: number, received_at: number) => ({
      account_id: 'a', message_uid: uid, from_addr: 'x', subject: 's',
      snippet: 'x', importance, received_at, added_at: received_at,
    });
    store.insertPending(mk(1, 4, 1000));
    store.insertPending(mk(2, 5, 500));
    store.insertPending(mk(3, 5, 1500));
    const rows = store.fetchPendingUndelivered(50);
    expect(rows.map((r) => r.message_uid)).toEqual([3, 2, 1]);
  });

  it('fetchInWindow returns rows within since_hours', () => {
    const store = createEmailStore({ db: getDb() });
    const now = Date.now();
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 's',
      snippet: 'x', importance: 4, received_at: now - 10 * 3600_000, added_at: now,
    });
    store.insertPending({
      account_id: 'a', message_uid: 2, from_addr: 'x', subject: 's',
      snippet: 'x', importance: 4, received_at: now - 100 * 3600_000, added_at: now,
    });
    const rows = store.fetchInWindow(72, 10, now);
    expect(rows.map((r) => r.message_uid)).toEqual([1]);
  });

  it('setAccountError writes last_error without clobbering last_seen_uid', () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 42, 1000);
    store.setAccountError('a', 'auth failed', 2000);
    expect(store.getLastSeenUid('a')).toBe(42);
    const err = store.getAccountError('a');
    expect(err).toEqual({ message: 'auth failed', at: 2000 });
  });

  it('findByPendingId returns the row or null', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'a', message_uid: 5, from_addr: 'x', subject: 's',
      snippet: 'x', importance: 4, received_at: 1000, added_at: 1000,
    });
    const rows = store.fetchPendingUndelivered(50);
    const id = rows[0].id;
    expect(store.findByPendingId(id)?.message_uid).toBe(5);
    expect(store.findByPendingId(9999)).toBeNull();
  });

  it('findUnpingedUrgent returns null when no rows match', () => {
    const store = createEmailStore({ db: getDb() });
    expect(store.findUnpingedUrgent()).toBeNull();
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 's',
      snippet: 'x', importance: 4, received_at: 1000, added_at: 1000,
    });
    expect(store.findUnpingedUrgent()).toBeNull();
  });

  it('findUnpingedUrgent returns the oldest matching row when multiple exist', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 'newer',
      snippet: 'x', importance: 5, received_at: 3000, added_at: 3000,
    });
    store.insertPending({
      account_id: 'a', message_uid: 2, from_addr: 'x', subject: 'oldest',
      snippet: 'x', importance: 5, received_at: 1000, added_at: 1000,
    });
    store.insertPending({
      account_id: 'a', message_uid: 3, from_addr: 'x', subject: 'mid',
      snippet: 'x', importance: 5, received_at: 2000, added_at: 2000,
    });
    const row = store.findUnpingedUrgent();
    expect(row?.subject).toBe('oldest');
    expect(row?.message_uid).toBe(2);
  });

  it('findUnpingedUrgent skips rows with importance < 5', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 'four',
      snippet: 'x', importance: 4, received_at: 1000, added_at: 1000,
    });
    store.insertPending({
      account_id: 'a', message_uid: 2, from_addr: 'x', subject: 'five',
      snippet: 'x', importance: 5, received_at: 2000, added_at: 2000,
    });
    expect(store.findUnpingedUrgent()?.message_uid).toBe(2);
  });

  it('findUnpingedUrgent skips rows already pinged', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 'pinged',
      snippet: 'x', importance: 5, received_at: 1000, added_at: 1000,
    });
    store.insertPending({
      account_id: 'a', message_uid: 2, from_addr: 'x', subject: 'fresh',
      snippet: 'x', importance: 5, received_at: 2000, added_at: 2000,
    });
    const first = store.findUnpingedUrgent();
    expect(first?.message_uid).toBe(1);
    store.markUrgentPinged(first!.id, 5000);
    const next = store.findUnpingedUrgent();
    expect(next?.message_uid).toBe(2);
    store.markUrgentPinged(next!.id, 6000);
    expect(store.findUnpingedUrgent()).toBeNull();
  });

  it('markUrgentPinged sets the timestamp', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 's',
      snippet: 'x', importance: 5, received_at: 1000, added_at: 1000,
    });
    const row = store.findUnpingedUrgent();
    expect(row?.urgent_pinged_at).toBeNull();
    store.markUrgentPinged(row!.id, 12345);
    const after = store.findByPendingId(row!.id);
    expect(after?.urgent_pinged_at).toBe(12345);
  });

  it('markUrgentPinged on missing id is a silent no-op and does not touch other rows', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 's',
      snippet: 'x', importance: 5, received_at: 1000, added_at: 1000,
    });
    const seeded = store.findUnpingedUrgent();
    expect(seeded?.urgent_pinged_at).toBeNull();
    expect(() => store.markUrgentPinged(9999, 1000)).not.toThrow();
    // Guards against a regression that broadens the WHERE clause and stamps
    // unrelated rows when the id is missing.
    const after = store.findByPendingId(seeded!.id);
    expect(after?.urgent_pinged_at).toBeNull();
  });

  it('countPendingUndelivered excludes rows already surfaced via urgent ping', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 's',
      snippet: 'x', importance: 5, received_at: 1000, added_at: 1000,
    });
    store.insertPending({
      account_id: 'a', message_uid: 2, from_addr: 'x', subject: 's',
      snippet: 'x', importance: 4, received_at: 2000, added_at: 2000,
    });
    expect(store.countPendingUndelivered()).toBe(2);
    const urgent = store.findUnpingedUrgent();
    store.markUrgentPinged(urgent!.id, 3000);
    // Urgent-pinged row was surfaced to the user already, so it must not
    // keep inflating the digest count.
    expect(store.countPendingUndelivered()).toBe(1);
  });

  it('fetchPendingUndelivered excludes rows already surfaced via urgent ping', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 'urgent',
      snippet: 'x', importance: 5, received_at: 1000, added_at: 1000,
    });
    store.insertPending({
      account_id: 'a', message_uid: 2, from_addr: 'x', subject: 'normal',
      snippet: 'x', importance: 4, received_at: 2000, added_at: 2000,
    });
    const urgent = store.findUnpingedUrgent();
    store.markUrgentPinged(urgent!.id, 3000);
    const rows = store.fetchPendingUndelivered(50);
    expect(rows.map((r) => r.message_uid)).toEqual([2]);
  });

  it('findUnpingedUrgent excludes rows already delivered via digest', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 's',
      snippet: 'x', importance: 5, received_at: 1000, added_at: 1000,
    });
    const row = store.fetchPendingUndelivered(50)[0];
    store.markDelivered([row.id], 2000);
    // Email was already surfaced to the user via the digest path; urgent
    // handler must not re-surface it as a separate ping.
    expect(store.findUnpingedUrgent()).toBeNull();
  });

  it('findMostRecentUrgent returns null when nothing has been pinged', () => {
    const store = createEmailStore({ db: getDb() });
    expect(store.findMostRecentUrgent()).toBeNull();
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 's',
      snippet: 'x', importance: 5, received_at: 1000, added_at: 1000,
    });
    expect(store.findMostRecentUrgent()).toBeNull();
  });

  it('findMostRecentUrgent returns the row with the largest positive urgent_pinged_at', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 'older',
      snippet: 'x', importance: 5, received_at: 1000, added_at: 1000,
    });
    store.insertPending({
      account_id: 'a', message_uid: 2, from_addr: 'x', subject: 'newer',
      snippet: 'x', importance: 5, received_at: 2000, added_at: 2000,
    });
    const rows = store.fetchPendingUndelivered(50);
    const older = rows.find((r) => r.subject === 'older')!;
    const newer = rows.find((r) => r.subject === 'newer')!;
    store.markUrgentPinged(older.id, 100_000);
    store.markUrgentPinged(newer.id, 200_000);
    expect(store.findMostRecentUrgent()?.id).toBe(newer.id);
  });

  it('findMostRecentUrgent excludes suppressed-by-rule sentinel (-1)', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 'real',
      snippet: 'x', importance: 5, received_at: 1000, added_at: 1000,
    });
    store.insertPending({
      account_id: 'a', message_uid: 2, from_addr: 'x', subject: 'suppressed',
      snippet: 'x', importance: 5, received_at: 2000, added_at: 2000,
    });
    const rows = store.fetchPendingUndelivered(50);
    const real = rows.find((r) => r.subject === 'real')!;
    const suppressed = rows.find((r) => r.subject === 'suppressed')!;
    store.markUrgentPinged(real.id, 50_000);
    store.markUrgentPinged(suppressed.id, -1);
    // Without the `> 0` filter the suppressed row would be returned because
    // its `urgent_pinged_at` (-1) is not NULL — that would lie to `/why` by
    // surfacing it as the "last urgent ping".
    expect(store.findMostRecentUrgent()?.id).toBe(real.id);
  });

  it('countPendingFromSender counts only the matching sender within the window', () => {
    const store = createEmailStore({ db: getDb() });
    const sender = 'alerts@bank.com';
    const other = 'spam@x.com';
    const now = 1_700_000_000_000;
    const sinceMs = now - 7 * 86_400_000;
    // 3 from target sender inside window
    for (let uid = 1; uid <= 3; uid++) {
      store.insertPending({
        account_id: 'a', message_uid: uid, from_addr: sender, subject: 's',
        snippet: 'x', importance: 4, received_at: now - uid * 1000, added_at: now,
      });
    }
    // 1 from target sender BEFORE the window — must be excluded
    store.insertPending({
      account_id: 'a', message_uid: 4, from_addr: sender, subject: 'old',
      snippet: 'x', importance: 4, received_at: sinceMs - 1, added_at: now,
    });
    // 2 from other sender inside window — must not contaminate the count
    for (let uid = 5; uid <= 6; uid++) {
      store.insertPending({
        account_id: 'a', message_uid: uid, from_addr: other, subject: 's',
        snippet: 'x', importance: 4, received_at: now - uid * 1000, added_at: now,
      });
    }
    expect(store.countPendingFromSender(sender, sinceMs)).toBe(3);
    expect(store.countPendingFromSender(other, sinceMs)).toBe(2);
    expect(store.countPendingFromSender('nobody@nope', sinceMs)).toBe(0);
  });
});
