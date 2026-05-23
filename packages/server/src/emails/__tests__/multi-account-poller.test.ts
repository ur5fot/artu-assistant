import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db.js';
import { createEmailStore } from '../store.js';
import { runPollTick } from '../multi-account-poller.js';
import type { ImapAccount, NewMessage } from '../types.js';

beforeEach(() => initDb(':memory:'));

const accA: ImapAccount = { id: 'a', host: 'h', port: 993, user: 'u', password: 'p', tls: true };
const accB: ImapAccount = { id: 'b', host: 'h2', port: 993, user: 'u', password: 'p', tls: true };

function msg(uid: number, from = 'x', subject = 's'): NewMessage {
  return { uid, from, subject, snippet: 'x', receivedAt: 1000 + uid };
}

// Default probe stub: not used by tests that pre-seed last_seen_uid > 0
// (the first-tick branch never triggers). Tests that exercise the first-tick
// path supply their own probe.
const noProbe = vi.fn(async () => 0);

describe('runPollTick', () => {
  it('inserts only score >= 4 and updates last_seen_uid', async () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 1, 100); // bypass first-tick branch
    const fetcher = vi.fn(async () => [msg(2), msg(3)]);
    const scorer = vi.fn(async (ms: NewMessage[]) =>
      ms.map((m) => ({ uid: m.uid, importance: m.uid === 2 ? 5 : 2 })),
    );

    await runPollTick({
      accounts: [accA],
      store,
      fetcher,
      scorer,
      maxUidProbe: noProbe,
      now: 5000,
    });

    expect(store.countPendingUndelivered()).toBe(1);
    const rows = store.fetchPendingUndelivered(10);
    expect(rows[0].message_uid).toBe(2);
    expect(store.getLastSeenUid('a')).toBe(3);
  });

  it('runs accounts in parallel and isolates errors per account', async () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 1, 100);
    store.updateLastSeenUid('b', 1, 100);
    const fetcher = vi.fn(async (acc: ImapAccount) => {
      if (acc.id === 'a') throw new Error('imap-down');
      return [msg(7)];
    });
    const scorer = vi.fn(async (ms: NewMessage[]) =>
      ms.map((m) => ({ uid: m.uid, importance: 5 })),
    );

    await runPollTick({
      accounts: [accA, accB],
      store,
      fetcher,
      scorer,
      maxUidProbe: noProbe,
      now: 6000,
    });

    expect(store.getAccountError('a')?.message).toContain('imap-down');
    expect(store.getLastSeenUid('b')).toBe(7);
    expect(store.countPendingUndelivered()).toBe(1);
  });

  it('does NOT update last_seen_uid when scorer throws', async () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 10, 1000);
    const fetcher = vi.fn(async () => [msg(11)]);
    const scorer = vi.fn(async () => { throw new Error('llm-down'); });

    await runPollTick({
      accounts: [accA],
      store,
      fetcher,
      scorer,
      maxUidProbe: noProbe,
      now: 7000,
    });

    expect(store.getLastSeenUid('a')).toBe(10);
    expect(store.countPendingUndelivered()).toBe(0);
    expect(store.getAccountError('a')?.message).toContain('llm-down');
  });

  it('skips accounts with no new messages silently', async () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 1, 100);
    const fetcher = vi.fn(async () => []);
    const scorer = vi.fn(async () => []);

    await runPollTick({
      accounts: [accA],
      store,
      fetcher,
      scorer,
      maxUidProbe: noProbe,
      now: 8000,
    });

    expect(scorer).not.toHaveBeenCalled();
    expect(store.getAccountError('a')).toBeNull();
  });

  it('first tick with sinceUid=0 and non-empty inbox: probes, sets last_seen_uid, skips fetch', async () => {
    const store = createEmailStore({ db: getDb() });
    const fetcher = vi.fn(async () => [msg(1)]);
    const scorer = vi.fn(async () => []);
    const probe = vi.fn(async () => 22532);

    await runPollTick({
      accounts: [accA],
      store,
      fetcher,
      scorer,
      maxUidProbe: probe,
      now: 9000,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(scorer).not.toHaveBeenCalled();
    expect(store.getLastSeenUid('a')).toBe(22532);
    expect(store.countPendingUndelivered()).toBe(0);
  });

  it('first tick with empty inbox (probe returns 0): persists 0, no inserts, no error', async () => {
    const store = createEmailStore({ db: getDb() });
    const fetcher = vi.fn(async () => []);
    const scorer = vi.fn(async () => []);
    const probe = vi.fn(async () => 0);

    await runPollTick({
      accounts: [accA],
      store,
      fetcher,
      scorer,
      maxUidProbe: probe,
      now: 10000,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.getLastSeenUid('a')).toBe(0);
    expect(store.getAccountError('a')).toBeNull();
  });

  it('non-first tick (sinceUid > 0): probe NOT called, fetcher called as before', async () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 2266, 5000);
    const fetcher = vi.fn(async () => [msg(2267)]);
    const scorer = vi.fn(async (ms: NewMessage[]) =>
      ms.map((m) => ({ uid: m.uid, importance: 5 })),
    );
    const probe = vi.fn(async () => 99999);

    await runPollTick({
      accounts: [accA],
      store,
      fetcher,
      scorer,
      maxUidProbe: probe,
      now: 11000,
    });

    expect(probe).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.getLastSeenUid('a')).toBe(2267);
  });

  it('first-tick probe throws: setAccountError called, no last_seen_uid update, no fetch', async () => {
    const store = createEmailStore({ db: getDb() });
    const fetcher = vi.fn(async () => []);
    const scorer = vi.fn(async () => []);
    const probe = vi.fn(async () => { throw new Error('probe-down'); });

    await runPollTick({
      accounts: [accA],
      store,
      fetcher,
      scorer,
      maxUidProbe: probe,
      now: 12000,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.getAccountError('a')?.message).toContain('probe-down');
    expect(store.getLastSeenUid('a')).toBe(0);
  });

  it('mixed accounts: one first-tick (probes), one ongoing (fetches) — both handled in one tick', async () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('b', 100, 1000); // B is non-first-tick
    const fetcher = vi.fn(async (acc: ImapAccount) => {
      if (acc.id === 'b') return [msg(101)];
      throw new Error('fetcher should not be called for first-tick account A');
    });
    const scorer = vi.fn(async (ms: NewMessage[]) =>
      ms.map((m) => ({ uid: m.uid, importance: 5 })),
    );
    const probe = vi.fn(async (acc: ImapAccount) => {
      if (acc.id === 'a') return 500;
      throw new Error('probe should not be called for ongoing account B');
    });

    await runPollTick({
      accounts: [accA, accB],
      store,
      fetcher,
      scorer,
      maxUidProbe: probe,
      now: 13000,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.getLastSeenUid('a')).toBe(500);
    expect(store.getLastSeenUid('b')).toBe(101);
    expect(store.countPendingUndelivered()).toBe(1);
  });
});
