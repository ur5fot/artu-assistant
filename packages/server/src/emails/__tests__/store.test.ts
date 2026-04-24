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
});
