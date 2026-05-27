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

  it('markUrgentPinged on missing id is a silent no-op', () => {
    const store = createEmailStore({ db: getDb() });
    expect(() => store.markUrgentPinged(9999, 1000)).not.toThrow();
  });
});
