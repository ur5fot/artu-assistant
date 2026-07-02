import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db.js';
import { createEmailStore } from '../store.js';

beforeEach(() => initDb(':memory:'));

describe('createEmailStore', () => {
  it('getAccountState returns null for an account with no row', () => {
    const store = createEmailStore({ db: getDb() });
    expect(store.getAccountState('missing')).toBeNull();
  });

  it('getAccountState reports poll time, error and streak (and clears on success)', () => {
    const store = createEmailStore({ db: getDb() });
    store.setAccountError('a', 'boom', 500);
    expect(store.getAccountState('a')).toMatchObject({
      last_poll_at: 500,
      last_error: 'boom',
      consecutive_errors: 1,
    });
    // A successful poll clears the error but keeps last_poll_at — so a healthy
    // (even quiet) account is still reportable with its last check time.
    store.updateLastSeenUid('a', 10, 1200);
    expect(store.getAccountState('a')).toMatchObject({
      last_poll_at: 1200,
      last_error: null,
      consecutive_errors: 0,
    });
  });

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

  it('getUidValidity returns null for an unknown account', () => {
    const store = createEmailStore({ db: getDb() });
    expect(store.getUidValidity('missing')).toBeNull();
  });

  it('getUidValidity returns null when the row exists but validity is unset', () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 42, 1000); // creates row, leaves uid_validity NULL
    expect(store.getUidValidity('a')).toBeNull();
  });

  it('setLastSeenAndValidity persists both last_seen_uid and uid_validity', () => {
    const store = createEmailStore({ db: getDb() });
    store.setLastSeenAndValidity('a', 99, 12345, 1000);
    expect(store.getLastSeenUid('a')).toBe(99);
    expect(store.getUidValidity('a')).toBe(12345);
  });

  it('setLastSeenAndValidity upserts both fields and clears last_error', () => {
    const store = createEmailStore({ db: getDb() });
    store.setAccountError('a', 'boom', 500); // seeds a row with last_error set
    store.setLastSeenAndValidity('a', 7, 111, 1000);
    expect(store.getLastSeenUid('a')).toBe(7);
    expect(store.getUidValidity('a')).toBe(111);
    expect(store.getAccountError('a')).toBeNull();
    // Second call overwrites both fields.
    store.setLastSeenAndValidity('a', 8, 222, 2000);
    expect(store.getLastSeenUid('a')).toBe(8);
    expect(store.getUidValidity('a')).toBe(222);
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

  it('email_pending has a gist column (migration added it)', () => {
    const cols = getDb()
      .prepare('PRAGMA table_info(email_pending)')
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'gist')).toBe(true);
  });

  it('insertPending defaults gist to null when omitted (old-style callers)', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 's',
      snippet: 'x', importance: 4, received_at: 1000, added_at: 1000,
    });
    const row = store.fetchPendingUndelivered(50)[0];
    expect(row.gist).toBeNull();
  });

  it('insertPending persists a provided gist and reads it back', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 's',
      snippet: 'x', importance: 5, received_at: 1000, added_at: 1000,
      gist: 'Короткая суть письма.',
    });
    const row = store.fetchPendingUndelivered(50)[0];
    expect(row.gist).toBe('Короткая суть письма.');
  });

  it('insertPending accepts an explicit null gist', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 's',
      snippet: 'x', importance: 5, received_at: 1000, added_at: 1000,
      gist: null,
    });
    const row = store.fetchPendingUndelivered(50)[0];
    expect(row.gist).toBeNull();
  });

  it('countHandledSince counts rows pinged (>0) or delivered at/after the cutoff', () => {
    const store = createEmailStore({ db: getDb() });
    for (const uid of [1, 2, 3, 4]) {
      store.insertPending({
        account_id: 'acc1', message_uid: uid, from_addr: 'a@b', subject: 's',
        snippet: 'x', importance: 5, received_at: 1000, added_at: 1000,
      });
    }
    const byUid = new Map(store.fetchPendingUndelivered(50).map((r) => [r.message_uid, r.id]));
    store.markUrgentPinged(byUid.get(1)!, 5000); // pinged at/after cutoff → counted
    store.markUrgentPinged(byUid.get(2)!, 1000); // pinged before cutoff → not counted
    store.markDelivered([byUid.get(3)!], 6000); // delivered at/after cutoff → counted
    store.markUrgentPinged(byUid.get(4)!, -1); // suppressed sentinel (never shown) → not counted
    expect(store.countHandledSince(4000)).toBe(2);
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

  it('setAccountError increments consecutive_errors on each failed tick', () => {
    const store = createEmailStore({ db: getDb() });
    expect(store.getAccountErrorState('a')).toBeNull();
    store.setAccountError('a', 'boom', 1000);
    expect(store.getAccountErrorState('a')).toEqual({
      consecutive_errors: 1, blind_alerted: 0, last_error: 'boom',
    });
    store.setAccountError('a', 'boom again', 2000);
    expect(store.getAccountErrorState('a')).toEqual({
      consecutive_errors: 2, blind_alerted: 0, last_error: 'boom again',
    });
  });

  it('updateLastSeenUid resets consecutive_errors and blind_alerted', () => {
    const store = createEmailStore({ db: getDb() });
    store.setAccountError('a', 'boom', 1000);
    store.setAccountError('a', 'boom', 2000);
    store.markBlindAlerted('a');
    expect(store.getAccountErrorState('a')).toEqual({
      consecutive_errors: 2, blind_alerted: 1, last_error: 'boom',
    });
    store.updateLastSeenUid('a', 42, 3000);
    expect(store.getAccountErrorState('a')).toEqual({
      consecutive_errors: 0, blind_alerted: 0, last_error: null,
    });
  });

  it('setLastSeenAndValidity resets consecutive_errors and blind_alerted', () => {
    const store = createEmailStore({ db: getDb() });
    store.setAccountError('a', 'boom', 1000);
    store.setAccountError('a', 'boom', 2000);
    store.markBlindAlerted('a');
    store.setLastSeenAndValidity('a', 7, 111, 3000);
    expect(store.getAccountErrorState('a')).toEqual({
      consecutive_errors: 0, blind_alerted: 0, last_error: null,
    });
  });

  it('clearAccountError resets the error state without moving the watermark', () => {
    const store = createEmailStore({ db: getDb() });
    store.setLastSeenAndValidity('a', 42, 111, 1000); // ongoing account, healthy
    store.setAccountError('a', 'boom', 2000);
    store.setAccountError('a', 'boom', 3000);
    store.markBlindAlerted('a');
    expect(store.getAccountErrorState('a')).toEqual({
      consecutive_errors: 2, blind_alerted: 1, last_error: 'boom',
    });

    store.clearAccountError('a', 4000); // successful poll, no new mail

    expect(store.getAccountErrorState('a')).toEqual({
      consecutive_errors: 0, blind_alerted: 0, last_error: null,
    });
    // Watermark + validity untouched — this success didn't advance them.
    expect(store.getLastSeenUid('a')).toBe(42);
    expect(store.getUidValidity('a')).toBe(111);
  });

  it('clearAccountError is a harmless no-op on a healthy or missing row', () => {
    const store = createEmailStore({ db: getDb() });
    expect(() => store.clearAccountError('missing', 1000)).not.toThrow();
    expect(store.getAccountErrorState('missing')).toBeNull();
    store.updateLastSeenUid('a', 5, 1000);
    store.clearAccountError('a', 2000);
    expect(store.getAccountErrorState('a')).toEqual({
      consecutive_errors: 0, blind_alerted: 0, last_error: null,
    });
  });

  it('markBlindAlerted latches the blind_alerted flag', () => {
    const store = createEmailStore({ db: getDb() });
    store.setAccountError('a', 'boom', 1000);
    expect(store.getAccountErrorState('a')?.blind_alerted).toBe(0);
    store.markBlindAlerted('a');
    expect(store.getAccountErrorState('a')?.blind_alerted).toBe(1);
    // Subsequent errors keep the latch set and keep counting.
    store.setAccountError('a', 'boom', 2000);
    expect(store.getAccountErrorState('a')).toEqual({
      consecutive_errors: 2, blind_alerted: 1, last_error: 'boom',
    });
  });

  it('getAccountErrorState returns null for an unknown account', () => {
    const store = createEmailStore({ db: getDb() });
    expect(store.getAccountErrorState('missing')).toBeNull();
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

  it('countPendingUndelivered and fetchPendingUndelivered include suppressed (-1) rows', () => {
    // Suppression sentinel `-1` means "the urgent path declined to surface
    // this row to the user". The digest is then the only remaining surface;
    // excluding -1 rows here would silently drop them entirely. Real ping
    // timestamps (positive) still exclude the row.
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 'pinged',
      snippet: 'x', importance: 5, received_at: 1000, added_at: 1000,
    });
    store.insertPending({
      account_id: 'a', message_uid: 2, from_addr: 'x', subject: 'suppressed',
      snippet: 'x', importance: 5, received_at: 2000, added_at: 2000,
    });
    store.insertPending({
      account_id: 'a', message_uid: 3, from_addr: 'x', subject: 'fresh',
      snippet: 'x', importance: 4, received_at: 3000, added_at: 3000,
    });
    const rows = store.fetchPendingUndelivered(50);
    const pinged = rows.find((r) => r.subject === 'pinged')!;
    const suppressed = rows.find((r) => r.subject === 'suppressed')!;
    store.markUrgentPinged(pinged.id, 50_000);
    store.markUrgentPinged(suppressed.id, -1);

    // Suppressed + fresh = 2; pinged was actually shown via urgent so excluded.
    expect(store.countPendingUndelivered()).toBe(2);
    const undelivered = store.fetchPendingUndelivered(50);
    expect(undelivered.map((r) => r.subject).sort()).toEqual(['fresh', 'suppressed']);
  });

  it('fetchAwaitingForAccount returns only this account\'s awaiting rows, with uid', () => {
    const store = createEmailStore({ db: getDb() });
    // acc1: two awaiting rows
    store.insertPending({
      account_id: 'acc1', message_uid: 10, from_addr: 'x', subject: 'a1-older',
      snippet: 'x', importance: 4, received_at: 1000, added_at: 1000,
    });
    store.insertPending({
      account_id: 'acc1', message_uid: 11, from_addr: 'x', subject: 'a1-newer',
      snippet: 'x', importance: 4, received_at: 2000, added_at: 2000,
    });
    // acc2: one awaiting row — must not leak into acc1's fetch
    store.insertPending({
      account_id: 'acc2', message_uid: 20, from_addr: 'x', subject: 'a2',
      snippet: 'x', importance: 4, received_at: 1500, added_at: 1500,
    });
    const rows = store.fetchAwaitingForAccount('acc1', 50);
    // ordered by received_at ASC, only acc1, carries message_uid
    expect(rows.map((r) => r.message_uid)).toEqual([10, 11]);
    expect(rows.every((r) => r.account_id === 'acc1')).toBe(true);
  });

  it('fetchAwaitingForAccount excludes delivered and real-urgent-pinged rows but keeps suppressed (-1)', () => {
    const store = createEmailStore({ db: getDb() });
    for (const [uid, subject] of [[1, 'delivered'], [2, 'pinged'], [3, 'suppressed'], [4, 'awaiting']] as const) {
      store.insertPending({
        account_id: 'acc1', message_uid: uid, from_addr: 'x', subject,
        snippet: 'x', importance: 5, received_at: uid * 1000, added_at: uid * 1000,
      });
    }
    const byUid = new Map(store.fetchPendingUndelivered(50).map((r) => [r.message_uid, r.id]));
    store.markDelivered([byUid.get(1)!], 9000); // delivered → excluded
    store.markUrgentPinged(byUid.get(2)!, 9000); // real ping (>0) → excluded
    store.markUrgentPinged(byUid.get(3)!, -1); // suppressed sentinel → still awaiting
    const rows = store.fetchAwaitingForAccount('acc1', 50);
    expect(rows.map((r) => r.message_uid).sort()).toEqual([3, 4]);
  });

  it('fetchAwaitingForAccount honours the limit', () => {
    const store = createEmailStore({ db: getDb() });
    for (let uid = 1; uid <= 5; uid++) {
      store.insertPending({
        account_id: 'acc1', message_uid: uid, from_addr: 'x', subject: 's',
        snippet: 'x', importance: 4, received_at: uid * 1000, added_at: uid * 1000,
      });
    }
    expect(store.fetchAwaitingForAccount('acc1', 2)).toHaveLength(2);
  });

  it('fetchAwaitingForAccount pages with offset (oldest-first, stable order)', () => {
    const store = createEmailStore({ db: getDb() });
    for (let uid = 1; uid <= 5; uid++) {
      store.insertPending({
        account_id: 'acc1', message_uid: uid, from_addr: 'x', subject: 's',
        snippet: 'x', importance: 4, received_at: uid * 1000, added_at: uid * 1000,
      });
    }
    // Page 1 (offset 0) = oldest two; page 2 (offset 2) = next two; etc.
    expect(store.fetchAwaitingForAccount('acc1', 2, 0).map((r) => r.message_uid)).toEqual([1, 2]);
    expect(store.fetchAwaitingForAccount('acc1', 2, 2).map((r) => r.message_uid)).toEqual([3, 4]);
    expect(store.fetchAwaitingForAccount('acc1', 2, 4).map((r) => r.message_uid)).toEqual([5]);
    // Offset past the end → empty page (the sync wraps to 0 on this).
    expect(store.fetchAwaitingForAccount('acc1', 2, 6)).toHaveLength(0);
  });

  it('countPendingFromSender matches across display-name variants of the same address', () => {
    // Same underlying address, three different headers a mail client might
    // emit. countPendingFromSender must count all three regardless of which
    // variant is queried — otherwise the /why history would split by
    // display name and undercount the sender.
    const store = createEmailStore({ db: getDb() });
    const now = 1_700_000_000_000;
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'boss@example.com',
      subject: 's', snippet: 'x', importance: 4, received_at: now - 1000, added_at: now,
    });
    store.insertPending({
      account_id: 'a', message_uid: 2, from_addr: '"Big Boss" <boss@example.com>',
      subject: 's', snippet: 'x', importance: 4, received_at: now - 2000, added_at: now,
    });
    store.insertPending({
      account_id: 'a', message_uid: 3, from_addr: 'Boss <boss@example.com>',
      subject: 's', snippet: 'x', importance: 4, received_at: now - 3000, added_at: now,
    });
    // Unrelated sender — must not contaminate.
    store.insertPending({
      account_id: 'a', message_uid: 4, from_addr: 'other@example.com',
      subject: 's', snippet: 'x', importance: 4, received_at: now - 4000, added_at: now,
    });
    const sinceMs = now - 7 * 86_400_000;
    expect(store.countPendingFromSender('boss@example.com', sinceMs)).toBe(3);
    expect(store.countPendingFromSender('"Big Boss" <boss@example.com>', sinceMs)).toBe(3);
    expect(store.countPendingFromSender('Boss <boss@example.com>', sinceMs)).toBe(3);
    expect(store.countPendingFromSender('other@example.com', sinceMs)).toBe(1);
  });

  it('countPendingFromSender treats `_` in address literally, not as SQL wildcard', () => {
    // SQLite LIKE treats `_` as "any single char". If countPendingFromSender
    // ever falls back to LIKE on the bare address, `john_doe@x.com` would
    // erroneously match `johnXdoe@x.com` etc. and overcount the history.
    const store = createEmailStore({ db: getDb() });
    const now = 1_700_000_000_000;
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'john_doe@x.com',
      subject: 's', snippet: 'x', importance: 4, received_at: now - 1000, added_at: now,
    });
    store.insertPending({
      account_id: 'a', message_uid: 2, from_addr: 'johnXdoe@x.com',
      subject: 's', snippet: 'x', importance: 4, received_at: now - 2000, added_at: now,
    });
    store.insertPending({
      account_id: 'a', message_uid: 3, from_addr: 'johnYdoe@x.com',
      subject: 's', snippet: 'x', importance: 4, received_at: now - 3000, added_at: now,
    });
    const sinceMs = now - 7 * 86_400_000;
    expect(store.countPendingFromSender('john_doe@x.com', sinceMs)).toBe(1);
  });

  it('countPendingFromSender ignores spoofed bare address inside another sender\'s display name', () => {
    // An attacker can stuff `<victim@bank.com>` into the display name of a
    // different sender (`"Bank <victim@bank.com>" <evil@attacker.com>`).
    // parseFromAddress picks the LAST angle group, so the canonical sender of
    // that row is `evil@attacker.com`, not the victim — the count for the
    // victim must not include it.
    const store = createEmailStore({ db: getDb() });
    const now = 1_700_000_000_000;
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'victim@bank.com',
      subject: 's', snippet: 'x', importance: 4, received_at: now - 1000, added_at: now,
    });
    store.insertPending({
      account_id: 'a', message_uid: 2,
      from_addr: '"Bank <victim@bank.com>" <evil@attacker.com>',
      subject: 's', snippet: 'x', importance: 4, received_at: now - 2000, added_at: now,
    });
    const sinceMs = now - 7 * 86_400_000;
    expect(store.countPendingFromSender('victim@bank.com', sinceMs)).toBe(1);
    expect(store.countPendingFromSender('evil@attacker.com', sinceMs)).toBe(1);
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
