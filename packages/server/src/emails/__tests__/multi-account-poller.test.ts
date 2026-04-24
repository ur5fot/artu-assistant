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

describe('runPollTick', () => {
  it('inserts only score >= 4 and updates last_seen_uid', async () => {
    const store = createEmailStore({ db: getDb() });
    const fetcher = vi.fn(async () => [msg(1), msg(2), msg(3)]);
    const scorer = vi.fn(async (ms: NewMessage[]) =>
      ms.map((m) => ({ uid: m.uid, importance: m.uid === 2 ? 5 : 2 })),
    );

    await runPollTick({
      accounts: [accA],
      store,
      fetcher,
      scorer,
      now: 5000,
    });

    expect(store.countPendingUndelivered()).toBe(1);
    const rows = store.fetchPendingUndelivered(10);
    expect(rows[0].message_uid).toBe(2);
    expect(store.getLastSeenUid('a')).toBe(3);
  });

  it('runs accounts in parallel and isolates errors per account', async () => {
    const store = createEmailStore({ db: getDb() });
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
      now: 7000,
    });

    expect(store.getLastSeenUid('a')).toBe(10);
    expect(store.countPendingUndelivered()).toBe(0);
    expect(store.getAccountError('a')?.message).toContain('llm-down');
  });

  it('skips accounts with no new messages silently', async () => {
    const store = createEmailStore({ db: getDb() });
    const fetcher = vi.fn(async () => []);
    const scorer = vi.fn(async () => []);

    await runPollTick({
      accounts: [accA],
      store,
      fetcher,
      scorer,
      now: 8000,
    });

    expect(scorer).not.toHaveBeenCalled();
    expect(store.getAccountError('a')).toBeNull();
  });
});
