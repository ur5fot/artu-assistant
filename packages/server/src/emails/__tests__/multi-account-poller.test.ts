import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db.js';
import { createEmailStore } from '../store.js';
import { createEmailFeedbackStore } from '../feedback-store.js';
import { runPollTick, type FlagFetcher, type FeedbackResolution, type MessageFetcher } from '../multi-account-poller.js';
import type { ImapAccount, NewMessage } from '../types.js';

beforeEach(() => {
  initDb(':memory:');
  noProbe.mockClear();
  noValidity.mockClear();
});

const accA: ImapAccount = { id: 'a', host: 'h', port: 993, user: 'u', password: 'p', tls: true };
const accB: ImapAccount = { id: 'b', host: 'h2', port: 993, user: 'u', password: 'p', tls: true };

function msg(uid: number, from = 'x', subject = 's'): NewMessage {
  return { uid, from, subject, snippet: 'x', receivedAt: 1000 + uid };
}

// Default probe stub: not used by tests that pre-seed last_seen_uid > 0
// (the first-tick branch never triggers). Tests that exercise the first-tick
// path supply their own probe.
const noProbe = vi.fn(async () => 0);

// Default validity probe for existing tests: returns a constant so the ongoing
// path's backfill branch (stored validity NULL → adopt baseline) is transparent
// to their assertions — it persists the same last_seen_uid and falls through to
// the fetch. Tests exercising the reset/backfill logic supply their own probe.
const noValidity = vi.fn(async () => 1);

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
      validityProbe: noValidity,
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
      validityProbe: noValidity,
      now: 6000,
    });

    expect(store.getAccountError('a')?.message).toContain('imap-down');
    expect(store.getLastSeenUid('b')).toBe(7);
    expect(store.countPendingUndelivered()).toBe(1);
  });

  it('logs per-account failure to stderr alongside setAccountError', async () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 1, 100);
    store.updateLastSeenUid('b', 1, 100);
    const fetcher = vi.fn(async (acc: ImapAccount) => {
      if (acc.id === 'a') throw new Error('socket-boom');
      return [msg(7)];
    });
    const scorer = vi.fn(async (ms: NewMessage[]) =>
      ms.map((m) => ({ uid: m.uid, importance: 5 })),
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runPollTick({
      accounts: [accA, accB],
      store,
      fetcher,
      scorer,
      maxUidProbe: noProbe,
      validityProbe: noValidity,
      now: 6000,
    });

    // Failure is visible in stdout (not just swallowed into the DB), and the
    // healthy account keeps polling (Promise.all per-account isolation).
    expect(err).toHaveBeenCalledWith('[emails] poll failed for a:', 'socket-boom');
    // Exactly one error log — the healthy account `b` must not have produced
    // its own failure path, pinning the per-account isolation claim.
    expect(err).toHaveBeenCalledTimes(1);
    expect(store.getAccountError('a')?.message).toContain('socket-boom');
    expect(store.getLastSeenUid('b')).toBe(7);
    err.mockRestore();
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
      validityProbe: noValidity,
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
      validityProbe: noValidity,
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
      validityProbe: noValidity,
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
      validityProbe: noValidity,
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
      validityProbe: noValidity,
      now: 11000,
    });

    expect(probe).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.getLastSeenUid('a')).toBe(2267);
  });

  it('first-tick probe throws: no state row written, no fetch — next tick retries first-tick', async () => {
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
      validityProbe: noValidity,
      now: 12000,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    // No row → next tick re-enters first-tick branch and retries the probe.
    // If we had written a state row here, the next tick would take the
    // ongoing path and crawl UID 1:* — defeating the backlog skip.
    expect(store.hasAccountState('a')).toBe(false);
    expect(store.getAccountError('a')).toBeNull();
  });

  it('empty-inbox first tick then email arrives: first arrival is captured (no silent loss)', async () => {
    const store = createEmailStore({ db: getDb() });
    const fetcher = vi.fn(async (_acc: ImapAccount, since: number) =>
      since === 0 ? [msg(1)] : [],
    );
    const scorer = vi.fn(async (ms: NewMessage[]) =>
      ms.map((m) => ({ uid: m.uid, importance: 5 })),
    );
    // tick 1 probe returns 0 (empty inbox); tick 2 probe would return 1, but
    // the ongoing path should run instead — verify probe is NOT re-called.
    const probe = vi.fn(async () => 0);

    // Tick 1: empty inbox, probe returns 0, state row written with uid=0.
    await runPollTick({
      accounts: [accA], store, fetcher, scorer, maxUidProbe: probe, validityProbe: noValidity, now: 10000,
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.hasAccountState('a')).toBe(true);
    expect(store.getLastSeenUid('a')).toBe(0);

    // Tick 2: row exists, so ongoing path runs. Fetcher receives sinceUid=0
    // and returns the freshly-arrived UID=1 — which must NOT be dropped.
    await runPollTick({
      accounts: [accA], store, fetcher, scorer, maxUidProbe: probe, validityProbe: noValidity, now: 11000,
    });
    expect(probe).toHaveBeenCalledTimes(1); // probe NOT called again
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.countPendingUndelivered()).toBe(1);
    expect(store.getLastSeenUid('a')).toBe(1);
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
      validityProbe: noValidity,
      now: 13000,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.getLastSeenUid('a')).toBe(500);
    expect(store.getLastSeenUid('b')).toBe(101);
    expect(store.countPendingUndelivered()).toBe(1);
  });
});

describe('runPollTick — UIDVALIDITY detect & self-heal', () => {
  it('validity unchanged → normal catch-up, no reset', async () => {
    const store = createEmailStore({ db: getDb() });
    store.setLastSeenAndValidity('a', 1, 111, 1000);
    const fetcher = vi.fn(async () => [msg(2), msg(3)]);
    const scorer = vi.fn(async (ms: NewMessage[]) =>
      ms.map((m) => ({ uid: m.uid, importance: 5 })),
    );
    const validityProbe = vi.fn(async () => 111);
    const onUidValidityReset = vi.fn();

    await runPollTick({
      accounts: [accA], store, fetcher, scorer, maxUidProbe: noProbe,
      validityProbe, onUidValidityReset, now: 5000,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.getLastSeenUid('a')).toBe(3);
    expect(store.getUidValidity('a')).toBe(111);
    expect(onUidValidityReset).not.toHaveBeenCalled();
  });

  it('validity changed → reset to maxUid, skip backlog, no ingest, one alert', async () => {
    const store = createEmailStore({ db: getDb() });
    store.setLastSeenAndValidity('a', 5000, 111, 1000);
    const fetcher = vi.fn(async () => [msg(2)]);
    const scorer = vi.fn(async () => []);
    const validityProbe = vi.fn(async () => 222);
    const maxUidProbe = vi.fn(async () => 7);
    const onUidValidityReset = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runPollTick({
      accounts: [accA], store, fetcher, scorer, maxUidProbe,
      validityProbe, onUidValidityReset, now: 6000,
    });

    expect(fetcher).not.toHaveBeenCalled(); // bailed before fetch
    expect(store.getLastSeenUid('a')).toBe(7);
    expect(store.getUidValidity('a')).toBe(222);
    expect(store.countPendingUndelivered()).toBe(0);
    expect(onUidValidityReset).toHaveBeenCalledTimes(1);
    expect(onUidValidityReset).toHaveBeenCalledWith({ account: 'a', previous: 111, current: 222 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[emails] UIDVALIDITY'));
    warn.mockRestore();
  });

  it('reset purges this account\'s pending rows (dead-epoch UIDs gone, others untouched)', async () => {
    const store = createEmailStore({ db: getDb() });
    store.setLastSeenAndValidity('a', 5000, 111, 1000);
    // Dead-epoch pending rows for account a, including a low UID (8) the new
    // epoch will re-issue and a high UID (4900) the new epoch may climb to.
    const pend = (accountId: string, uid: number) =>
      store.insertPending({
        account_id: accountId, message_uid: uid, from_addr: 'x@x', subject: 's',
        snippet: 'x', importance: 5, received_at: uid, added_at: uid,
      });
    pend('a', 8);
    pend('a', 4900);
    // A different account's pending must NOT be touched by a's reset.
    store.setLastSeenAndValidity('b', 10, 111, 1000);
    pend('b', 8);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []),
      maxUidProbe: vi.fn(async () => 7), validityProbe: vi.fn(async () => 222),
      now: 2000,
    });
    warn.mockRestore();

    const rows = store.fetchPendingUndelivered(10);
    expect(rows.filter((r) => r.account_id === 'a')).toHaveLength(0);
    expect(rows.filter((r) => r.account_id === 'b')).toHaveLength(1);
  });

  it('reset purges pending even when a RESOLVED feedback row references it (FK-safe)', async () => {
    const store = createEmailStore({ db: getDb() });
    const fb = createEmailFeedbackStore({ db: getDb() });
    store.setLastSeenAndValidity('a', 5000, 111, 1000);
    store.insertPending({
      account_id: 'a', message_uid: 50, from_addr: 'x@x', subject: 's',
      snippet: 'x', importance: 5, received_at: 1, added_at: 1,
    });
    const pid = (
      getDb()
        .prepare('SELECT id FROM email_pending WHERE account_id = ? AND message_uid = ?')
        .get('a', 50) as { id: number }
    ).id;
    fb.recordPinged(pid, 1000);
    fb.finalize(pid, 'read', 1500); // resolved feedback row → FK references the pending row

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []),
      maxUidProbe: vi.fn(async () => 7), validityProbe: vi.fn(async () => 222),
      now: 2000,
      feedback: { store: fb, flagFetcher: vi.fn(async () => []), ignoreHours: 24, maxRepoll: 50 },
    });
    warn.mockRestore();

    // No FK violation escalated into the account's error path, and both the
    // pending row and its (resolved) feedback are gone with the dead epoch.
    expect(store.getAccountError('a')).toBeNull();
    expect(store.fetchPendingUndelivered(10)).toHaveLength(0);
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM email_feedback').get()).toEqual({ c: 0 });
  });

  it('reset purges pending + orphan feedback even when feedback resolution is NOT wired (FK-safe)', async () => {
    // Scenario: a prior EMAIL_FEEDBACK_ENABLED=true run left email_feedback rows,
    // then the flag was turned off → `feedback` is omitted from runPollTick. The
    // reset must still purge the dead-epoch pending rows; the FK from the orphan
    // feedback row must not block the delete and strand stale rows forever.
    const store = createEmailStore({ db: getDb() });
    const fb = createEmailFeedbackStore({ db: getDb() });
    store.setLastSeenAndValidity('a', 5000, 111, 1000);
    store.insertPending({
      account_id: 'a', message_uid: 50, from_addr: 'x@x', subject: 's',
      snippet: 'x', importance: 5, received_at: 1, added_at: 1,
    });
    const pid = (
      getDb()
        .prepare('SELECT id FROM email_pending WHERE account_id = ? AND message_uid = ?')
        .get('a', 50) as { id: number }
    ).id;
    fb.recordPinged(pid, 1000); // unresolved orphan row referencing the pending row

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []),
      maxUidProbe: vi.fn(async () => 7), validityProbe: vi.fn(async () => 222),
      now: 2000,
      // feedback intentionally omitted (resolution disabled this run)
    });
    warn.mockRestore();

    // No FK violation, watermark advanced, and the orphan feedback is gone too.
    expect(store.getAccountError('a')).toBeNull();
    expect(store.getLastSeenUid('a')).toBe(7);
    expect(store.getUidValidity('a')).toBe(222);
    expect(store.fetchPendingUndelivered(10)).toHaveLength(0);
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM email_feedback').get()).toEqual({ c: 0 });
  });

  it('tick after reset → normal path resumed (stored now matches)', async () => {
    const store = createEmailStore({ db: getDb() });
    store.setLastSeenAndValidity('a', 7, 222, 1000); // post-reset state
    const fetcher = vi.fn(async () => [msg(8)]);
    const scorer = vi.fn(async (ms: NewMessage[]) =>
      ms.map((m) => ({ uid: m.uid, importance: 5 })),
    );
    const validityProbe = vi.fn(async () => 222);
    const onUidValidityReset = vi.fn();

    await runPollTick({
      accounts: [accA], store, fetcher, scorer, maxUidProbe: noProbe,
      validityProbe, onUidValidityReset, now: 7000,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.getLastSeenUid('a')).toBe(8);
    expect(onUidValidityReset).not.toHaveBeenCalled();
  });

  it('backfill (uid_validity NULL) → record validity, no reset, fetch proceeds', async () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 1, 1000); // validity NULL
    const fetcher = vi.fn(async () => [msg(2), msg(3)]);
    const scorer = vi.fn(async (ms: NewMessage[]) =>
      ms.map((m) => ({ uid: m.uid, importance: 5 })),
    );
    const validityProbe = vi.fn(async () => 333);
    const maxUidProbe = vi.fn(async () => 99);
    const onUidValidityReset = vi.fn();

    await runPollTick({
      accounts: [accA], store, fetcher, scorer, maxUidProbe,
      validityProbe, onUidValidityReset, now: 8000,
    });

    expect(store.getUidValidity('a')).toBe(333);
    expect(fetcher).toHaveBeenCalledTimes(1); // fetch ran (not a reset)
    expect(store.getLastSeenUid('a')).toBe(3); // grew via fetch, not maxUid
    expect(maxUidProbe).not.toHaveBeenCalled();
    expect(onUidValidityReset).not.toHaveBeenCalled();
  });

  it('validityProbe throws → setAccountError, no reset, no fetch, state untouched', async () => {
    const store = createEmailStore({ db: getDb() });
    store.setLastSeenAndValidity('a', 5000, 111, 1000);
    const fetcher = vi.fn(async () => [msg(2)]);
    const scorer = vi.fn(async () => []);
    const validityProbe = vi.fn(async () => { throw new Error('validity-down'); });
    const onUidValidityReset = vi.fn();

    await runPollTick({
      accounts: [accA], store, fetcher, scorer, maxUidProbe: noProbe,
      validityProbe, onUidValidityReset, now: 9000,
    });

    expect(store.getAccountError('a')?.message).toContain('validity-down');
    expect(store.getLastSeenUid('a')).toBe(5000);
    expect(store.getUidValidity('a')).toBe(111);
    expect(fetcher).not.toHaveBeenCalled();
    expect(onUidValidityReset).not.toHaveBeenCalled();
  });

  it('validity changed but maxUidProbe throws → setAccountError, state untouched, no alert (re-detects next tick)', async () => {
    const store = createEmailStore({ db: getDb() });
    store.setLastSeenAndValidity('a', 5000, 111, 1000);
    const fetcher = vi.fn(async () => [msg(2)]);
    const scorer = vi.fn(async () => []);
    const validityProbe = vi.fn(async () => 222);
    const maxUidProbe = vi.fn(async () => { throw new Error('maxuid-down'); });
    const onUidValidityReset = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runPollTick({
      accounts: [accA], store, fetcher, scorer, maxUidProbe,
      validityProbe, onUidValidityReset, now: 6000,
    });

    expect(store.getAccountError('a')?.message).toContain('maxuid-down');
    // Watermark + validity must stay at the OLD epoch so the next tick re-detects
    // the change and retries — the "exactly one alert" guarantee is preserved by
    // NOT persisting the new validity until the heal actually completes.
    expect(store.getLastSeenUid('a')).toBe(5000);
    expect(store.getUidValidity('a')).toBe(111);
    expect(fetcher).not.toHaveBeenCalled();
    expect(onUidValidityReset).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('first tick (no row) → captures UIDVALIDITY alongside the initial watermark', async () => {
    const store = createEmailStore({ db: getDb() });
    const fetcher = vi.fn(async () => []);
    const scorer = vi.fn(async () => []);
    const maxUidProbe = vi.fn(async () => 42);
    const validityProbe = vi.fn(async () => 333);

    await runPollTick({
      accounts: [accA], store, fetcher, scorer, maxUidProbe,
      validityProbe, now: 10000,
    });

    expect(maxUidProbe).toHaveBeenCalledTimes(1);
    // Validity is recorded on the FIRST tick (not deferred to a backfill tick)
    // so a mailbox recreation before the next tick is detected as a validity
    // change instead of silently pairing a stale watermark with the new epoch.
    expect(validityProbe).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.getLastSeenUid('a')).toBe(42);
    expect(store.getUidValidity('a')).toBe(333);
  });

  it('first-tick validity probe throws → no state row, next tick retries first-tick', async () => {
    const store = createEmailStore({ db: getDb() });
    const fetcher = vi.fn(async () => []);
    const scorer = vi.fn(async () => []);
    const maxUidProbe = vi.fn(async () => 42);
    const validityProbe = vi.fn(async () => { throw new Error('validity-down'); });

    await runPollTick({
      accounts: [accA], store, fetcher, scorer, maxUidProbe,
      validityProbe, now: 10000,
    });

    // The watermark is only persisted once BOTH probes succeed, so a validity
    // probe failure must leave no state row — otherwise the next tick would take
    // the ongoing path and crawl UID 1:* (the backlog we mean to skip).
    expect(store.hasAccountState('a')).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recreation between first and second tick is detected (validity captured on tick 1)', async () => {
    const store = createEmailStore({ db: getDb() });
    const fetcher = vi.fn(async () => []);
    const scorer = vi.fn(async () => []);

    // Tick 1 (first tick): epoch 111, watermark 5000.
    await runPollTick({
      accounts: [accA], store, fetcher, scorer,
      maxUidProbe: vi.fn(async () => 5000),
      validityProbe: vi.fn(async () => 111),
      now: 1000,
    });
    expect(store.getLastSeenUid('a')).toBe(5000);
    expect(store.getUidValidity('a')).toBe(111);

    // Mailbox recreated before tick 2: epoch 222, UIDs restarted low (maxUid 7).
    const onUidValidityReset = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runPollTick({
      accounts: [accA], store, fetcher, scorer,
      maxUidProbe: vi.fn(async () => 7),
      validityProbe: vi.fn(async () => 222),
      onUidValidityReset, now: 2000,
    });
    warn.mockRestore();

    // Detected & self-healed instead of going blind on the stale 5000 watermark.
    expect(store.getLastSeenUid('a')).toBe(7);
    expect(store.getUidValidity('a')).toBe(222);
    expect(onUidValidityReset).toHaveBeenCalledTimes(1);
    expect(onUidValidityReset).toHaveBeenCalledWith({ account: 'a', previous: 111, current: 222 });
  });
});

describe('runPollTick — implicit-feedback resolution', () => {
  const IGNORE_HOURS = 24;
  const IGNORE_MS = IGNORE_HOURS * 3_600_000;

  // Insert a pending email + its (pinged, unresolved) feedback row directly,
  // returning the pending id so the test can drive the resolution path.
  function seedPinged(
    db: ReturnType<typeof getDb>,
    opts: { accountId: string; uid: number; from: string; pingedAt: number },
  ): number {
    const info = db
      .prepare(
        `INSERT INTO email_pending
         (account_id, message_uid, from_addr, subject, snippet, importance,
          received_at, added_at, urgent_pinged_at)
         VALUES (?, ?, ?, ?, 'x', 5, ?, ?, ?)`,
      )
      .run(opts.accountId, opts.uid, opts.from, 's', opts.pingedAt, opts.pingedAt, opts.pingedAt);
    const id = Number(info.lastInsertRowid);
    createEmailFeedbackStore({ db }).recordPinged(id, opts.pingedAt);
    return id;
  }

  function outcomeOf(db: ReturnType<typeof getDb>, pendingId: number) {
    return db
      .prepare(`SELECT outcome, resolved_at, seen_at, answered_at FROM email_feedback WHERE pending_id = ?`)
      .get(pendingId) as {
      outcome: string | null;
      resolved_at: number | null;
      seen_at: number | null;
      answered_at: number | null;
    };
  }

  function feedbackDeps(flagFetcher: FlagFetcher): FeedbackResolution {
    return {
      store: createEmailFeedbackStore({ db: getDb() }),
      flagFetcher,
      ignoreHours: IGNORE_HOURS,
      maxRepoll: 50,
    };
  }

  // Ongoing account with no new mail so the tick goes straight to resolution.
  function ongoing(store: ReturnType<typeof createEmailStore>) {
    store.updateLastSeenUid('a', 100, 1);
  }

  it('replied: \\Answered finalizes as replied immediately (even within window)', async () => {
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const pingedAt = 1000;
    const id = seedPinged(getDb(), { accountId: 'a', uid: 5, from: 'boss@x.com', pingedAt });
    const flagFetcher = vi.fn<FlagFetcher>(async () => [{ uid: 5, seen: true, answered: true }]);

    // now is only 1h after the ping — well inside the 24h window.
    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []), maxUidProbe: noProbe, validityProbe: noValidity,
      now: pingedAt + 3_600_000,
      feedback: feedbackDeps(flagFetcher),
    });

    expect(flagFetcher).toHaveBeenCalledTimes(1);
    const o = outcomeOf(getDb(), id);
    expect(o.outcome).toBe('replied');
    expect(o.resolved_at).not.toBeNull();
  });

  it('read: \\Seen, no answer, window elapsed → read', async () => {
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const pingedAt = 1000;
    const id = seedPinged(getDb(), { accountId: 'a', uid: 6, from: 'news@x.com', pingedAt });
    const flagFetcher = vi.fn<FlagFetcher>(async () => [{ uid: 6, seen: true, answered: false }]);

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []), maxUidProbe: noProbe, validityProbe: noValidity,
      now: pingedAt + IGNORE_MS, // exactly at the deadline
      feedback: feedbackDeps(flagFetcher),
    });

    const o = outcomeOf(getDb(), id);
    expect(o.outcome).toBe('read');
    expect(o.resolved_at).not.toBeNull();
    expect(o.seen_at).toBe(pingedAt + IGNORE_MS);
  });

  it('ignored: never seen, window elapsed → ignored', async () => {
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const pingedAt = 1000;
    const id = seedPinged(getDb(), { accountId: 'a', uid: 7, from: 'spam@x.com', pingedAt });
    const flagFetcher = vi.fn<FlagFetcher>(async () => [{ uid: 7, seen: false, answered: false }]);

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []), maxUidProbe: noProbe, validityProbe: noValidity,
      now: pingedAt + IGNORE_MS + 1,
      feedback: feedbackDeps(flagFetcher),
    });

    const o = outcomeOf(getDb(), id);
    expect(o.outcome).toBe('ignored');
    expect(o.resolved_at).not.toBeNull();
  });

  it('still-pending: seen but inside window → stays unresolved, records seen_at', async () => {
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const pingedAt = 1000;
    const id = seedPinged(getDb(), { accountId: 'a', uid: 8, from: 'x@x.com', pingedAt });
    const flagFetcher = vi.fn<FlagFetcher>(async () => [{ uid: 8, seen: true, answered: false }]);

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []), maxUidProbe: noProbe, validityProbe: noValidity,
      now: pingedAt + IGNORE_MS - 1, // one ms short of the deadline
      feedback: feedbackDeps(flagFetcher),
    });

    const o = outcomeOf(getDb(), id);
    expect(o.outcome).toBeNull();
    expect(o.resolved_at).toBeNull();
    expect(o.seen_at).toBe(pingedAt + IGNORE_MS - 1); // flag still recorded
  });

  it('empty re-poll, no prior observation → not finalized (no fabricated outcome)', async () => {
    // Empty fetch + a row we never observed seen/answered: there is no evidence
    // to act on, so the row must stay unresolved rather than be finalized as
    // `ignored` on a possibly-failed fetch. (Empty fetch *with* a prior
    // observation does finalize — covered by the two tests below.)
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const pingedAt = 1000;
    const id = seedPinged(getDb(), { accountId: 'a', uid: 9, from: 'x@x.com', pingedAt });
    const flagFetcher = vi.fn<FlagFetcher>(async () => []); // failed or all-UIDs-gone

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []), maxUidProbe: noProbe, validityProbe: noValidity,
      now: pingedAt + IGNORE_MS + 1, // window elapsed, but no data
      feedback: feedbackDeps(flagFetcher),
    });

    const o = outcomeOf(getDb(), id);
    expect(o.outcome).toBeNull();
    expect(o.resolved_at).toBeNull();
  });

  it('partial result: a UID missing from a non-empty fetch is NOT finalized as ignored', async () => {
    // Two pinged emails; the flag fetch returns only one (the other left INBOX:
    // moved/archived/deleted). Absence is unknown state, not "never opened" —
    // so the missing UID must stay unresolved rather than fabricate `ignored`.
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const pingedAt = 1000;
    const present = seedPinged(getDb(), { accountId: 'a', uid: 30, from: 'seen@x.com', pingedAt });
    const gone = seedPinged(getDb(), { accountId: 'a', uid: 31, from: 'gone@x.com', pingedAt });
    // Only uid 30 comes back (seen); uid 31 is absent from a successful fetch.
    const flagFetcher = vi.fn<FlagFetcher>(async () => [{ uid: 30, seen: true, answered: false }]);

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []), maxUidProbe: noProbe, validityProbe: noValidity,
      now: pingedAt + IGNORE_MS + 1, // window elapsed for both
      feedback: feedbackDeps(flagFetcher),
    });

    // Present-and-seen finalizes as read; absent UID stays unresolved.
    expect(outcomeOf(getDb(), present).outcome).toBe('read');
    const goneRow = outcomeOf(getDb(), gone);
    expect(goneRow.outcome).toBeNull();
    expect(goneRow.resolved_at).toBeNull();
  });

  it('empty fetch: an absent UID with a prior seen_at still finalizes as read', async () => {
    // The message left INBOX (archived/deleted/moved) after we'd already
    // observed `\Seen` on an earlier tick, so *this* tick's flag fetch comes
    // back empty. We still know it was read, so window-elapsed finalization to
    // `read` is correct — the prior observation is real evidence, not stale
    // flag data. Bailing on the empty fetch would strand this row unresolved
    // until it ages out, contradicting "seen_at set ⇒ read".
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const pingedAt = 1000;
    const id = seedPinged(getDb(), { accountId: 'a', uid: 32, from: 'x@x.com', pingedAt });
    createEmailFeedbackStore({ db: getDb() }).updateFlags(id, { seenAt: pingedAt + 10 });
    const flagFetcher = vi.fn<FlagFetcher>(async () => []); // UID gone from INBOX

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []), maxUidProbe: noProbe, validityProbe: noValidity,
      now: pingedAt + IGNORE_MS + 1,
      feedback: feedbackDeps(flagFetcher),
    });

    expect(outcomeOf(getDb(), id).outcome).toBe('read');
  });

  it('empty fetch: an absent UID with a prior answered_at still finalizes as replied', async () => {
    // Same as above but the prior observation was `\Answered`. Replied is a
    // terminal outcome regardless of window, so an empty re-poll must not
    // prevent finalization when we already recorded the answer.
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const pingedAt = 1000;
    const id = seedPinged(getDb(), { accountId: 'a', uid: 34, from: 'x@x.com', pingedAt });
    createEmailFeedbackStore({ db: getDb() }).updateFlags(id, { answeredAt: pingedAt + 10 });
    const flagFetcher = vi.fn<FlagFetcher>(async () => []); // UID gone from INBOX

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []), maxUidProbe: noProbe, validityProbe: noValidity,
      now: pingedAt + 3_600_000, // inside window — replied is immediate
      feedback: feedbackDeps(flagFetcher),
    });

    expect(outcomeOf(getDb(), id).outcome).toBe('replied');
  });

  it('hard fetch failure (null): a prior seen_at row is NOT finalized as read', async () => {
    // Regression: the user replied (server set `\Answered`) before the deadline,
    // but the deadline re-poll hits a hard IMAP error → fetcher returns null.
    // The row already had `\Seen` recorded, so finalizing `read` off that stale
    // observation would fabricate negative feedback for a sender the user
    // actually replied to. A `null` carries no evidence: leave it unresolved so
    // the next successful tick can observe `\Answered` and finalize `replied`.
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const pingedAt = 1000;
    const id = seedPinged(getDb(), { accountId: 'a', uid: 33, from: 'boss@x.com', pingedAt });
    createEmailFeedbackStore({ db: getDb() }).updateFlags(id, { seenAt: pingedAt + 10 });
    const flagFetcher = vi.fn<FlagFetcher>(async () => null); // hard fetch failure

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []), maxUidProbe: noProbe, validityProbe: noValidity,
      now: pingedAt + IGNORE_MS + 1, // window elapsed, but the fetch failed
      feedback: feedbackDeps(flagFetcher),
    });

    const o = outcomeOf(getDb(), id);
    expect(o.outcome).toBeNull();
    expect(o.resolved_at).toBeNull();
  });

  it('a throwing flag re-poll is isolated: no account error, tick completes', async () => {
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const pingedAt = 1000;
    const id = seedPinged(getDb(), { accountId: 'a', uid: 99, from: 'x@x.com', pingedAt });
    const flagFetcher = vi.fn<FlagFetcher>(async () => {
      throw new Error('imap boom');
    });

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []), maxUidProbe: noProbe, validityProbe: noValidity,
      now: pingedAt + IGNORE_MS + 1,
      feedback: feedbackDeps(flagFetcher),
    });

    // The scorer/resolution failure is swallowed inside resolveAccountFeedback,
    // so it must NOT escalate into the account's error path, and the row stays
    // unresolved for a later tick rather than finalizing on a failed fetch.
    expect(store.getAccountError('a')).toBeNull();
    expect(outcomeOf(getDb(), id).outcome).toBeNull();
  });

  it('no feedback deps → no flag fetch, behaviour unchanged', async () => {
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const id = seedPinged(getDb(), { accountId: 'a', uid: 10, from: 'x@x.com', pingedAt: 1000 });

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []), maxUidProbe: noProbe, validityProbe: noValidity,
      now: 1000 + IGNORE_MS + 1,
      // no feedback
    });

    const o = outcomeOf(getDb(), id);
    expect(o.outcome).toBeNull();
  });

  it('only re-polls UIDs for the current account', async () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 100, 1);
    store.updateLastSeenUid('b', 100, 1);
    seedPinged(getDb(), { accountId: 'a', uid: 11, from: 'x@x.com', pingedAt: 1000 });
    seedPinged(getDb(), { accountId: 'b', uid: 22, from: 'y@y.com', pingedAt: 1000 });
    const seenUids: number[] = [];
    const flagFetcher = vi.fn<FlagFetcher>(async (_acc, uids) => {
      seenUids.push(...uids);
      return uids.map((uid) => ({ uid, seen: false, answered: false }));
    });

    await runPollTick({
      accounts: [accA, accB], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []), maxUidProbe: noProbe, validityProbe: noValidity,
      now: 2000,
      feedback: feedbackDeps(flagFetcher),
    });

    // Each account's fetch saw only its own UID, never the other's.
    const calls = flagFetcher.mock.calls;
    const aCall = calls.find((c) => c[0].id === 'a');
    const bCall = calls.find((c) => c[0].id === 'b');
    expect(aCall?.[1]).toEqual([11]);
    expect(bCall?.[1]).toEqual([22]);
  });

  it('UIDVALIDITY reset purges this account\'s unresolved feedback (dead-epoch UIDs not re-polled)', async () => {
    const store = createEmailStore({ db: getDb() });
    store.setLastSeenAndValidity('a', 5000, 111, 1000); // ongoing, old epoch
    const pingedAt = 1000;
    const id = seedPinged(getDb(), { accountId: 'a', uid: 42, from: 'x@x.com', pingedAt });
    const flagFetcher = vi.fn<FlagFetcher>(async () => []);
    const validityProbe = vi.fn(async () => 222); // epoch changed
    const maxUidProbe = vi.fn(async () => 7);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []),
      maxUidProbe, validityProbe,
      now: pingedAt + 1000,
      feedback: feedbackDeps(flagFetcher),
    });

    // The reset bails before resolution, and the dead-epoch row is gone — so it
    // can never be re-polled against the new epoch and mis-finalized.
    expect(flagFetcher).not.toHaveBeenCalled();
    expect(outcomeOf(getDb(), id)).toBeUndefined();
    warn.mockRestore();
  });

  it('resolution also runs when new mail arrives in the same tick', async () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 100, 1);
    const pingedAt = 1000;
    const id = seedPinged(getDb(), { accountId: 'a', uid: 12, from: 'x@x.com', pingedAt });
    const flagFetcher = vi.fn<FlagFetcher>(async () => [{ uid: 12, seen: false, answered: true }]);

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => [msg(150)]),
      scorer: vi.fn(async (ms: NewMessage[]) => ms.map((m) => ({ uid: m.uid, importance: 5 }))),
      maxUidProbe: noProbe,
      validityProbe: noValidity,
      now: pingedAt + 1000,
      feedback: feedbackDeps(flagFetcher),
    });

    expect(store.getLastSeenUid('a')).toBe(150); // new mail processed
    expect(outcomeOf(getDb(), id).outcome).toBe('replied'); // and feedback resolved
  });
});

describe('runPollTick — \\Seen sync (auto-clear awaiting queue)', () => {
  // Insert an awaiting (queue-visible, non-urgent-pinged, undelivered) pending
  // row directly and return its id. Mirrors what the poller would have inserted
  // for a noticed-but-not-urgent email.
  function seedAwaiting(
    db: ReturnType<typeof getDb>,
    opts: { accountId: string; uid: number; receivedAt?: number },
  ): number {
    const info = db
      .prepare(
        `INSERT INTO email_pending
         (account_id, message_uid, from_addr, subject, snippet, importance,
          received_at, added_at)
         VALUES (?, ?, 'x@x.com', 's', 'x', 3, ?, ?)`,
      )
      .run(opts.accountId, opts.uid, opts.receivedAt ?? opts.uid, opts.receivedAt ?? opts.uid);
    return Number(info.lastInsertRowid);
  }

  function isDelivered(db: ReturnType<typeof getDb>, id: number): boolean {
    const row = db
      .prepare('SELECT delivered_at FROM email_pending WHERE id = ?')
      .get(id) as { delivered_at: number | null };
    return row.delivered_at != null;
  }

  // Ongoing account with no new mail so the tick goes straight to the sync pass.
  function ongoing(store: ReturnType<typeof createEmailStore>) {
    store.updateLastSeenUid('a', 100, 1);
  }

  it('awaiting row marked \\Seen in Gmail → auto-dismissed (leaves awaiting)', async () => {
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const id = seedAwaiting(getDb(), { accountId: 'a', uid: 5 });
    const flagFetcher = vi.fn<FlagFetcher>(async () => [{ uid: 5, seen: true, answered: false }]);

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []),
      maxUidProbe: noProbe, validityProbe: noValidity,
      now: 2000, flagFetcher,
    });

    expect(isDelivered(getDb(), id)).toBe(true);
    expect(store.countPendingUndelivered()).toBe(0);
  });

  it('awaiting row absent from a successful fetch (left INBOX) → auto-dismissed', async () => {
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const id = seedAwaiting(getDb(), { accountId: 'a', uid: 6 });
    // Successful but empty fetch: the UID has left INBOX (archived/deleted/moved).
    const flagFetcher = vi.fn<FlagFetcher>(async () => []);

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []),
      maxUidProbe: noProbe, validityProbe: noValidity,
      now: 2000, flagFetcher,
    });

    expect(isDelivered(getDb(), id)).toBe(true);
  });

  it('awaiting row present but \\Seen=false → NOT dismissed (still in queue)', async () => {
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const id = seedAwaiting(getDb(), { accountId: 'a', uid: 7 });
    const flagFetcher = vi.fn<FlagFetcher>(async () => [{ uid: 7, seen: false, answered: false }]);

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []),
      maxUidProbe: noProbe, validityProbe: noValidity,
      now: 2000, flagFetcher,
    });

    expect(isDelivered(getDb(), id)).toBe(false);
    expect(store.countPendingUndelivered()).toBe(1);
  });

  it('hard fetch failure (null) → nothing dismissed (safe bail)', async () => {
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const id = seedAwaiting(getDb(), { accountId: 'a', uid: 8 });
    // null carries no evidence — an absent UID must NOT be read as "left INBOX".
    const flagFetcher = vi.fn<FlagFetcher>(async () => null);

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []),
      maxUidProbe: noProbe, validityProbe: noValidity,
      now: 2000, flagFetcher,
    });

    expect(isDelivered(getDb(), id)).toBe(false);
  });

  it('urgent-pinged and already-delivered rows are out of scope (untouched)', async () => {
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    // A real urgent-pinged row (positive ts) and an already-delivered row: both
    // are excluded from the awaiting set, so the sync must never re-check them
    // and the fetch must carry only the genuine awaiting UID.
    const db = getDb();
    const pinged = db
      .prepare(
        `INSERT INTO email_pending
         (account_id, message_uid, from_addr, subject, snippet, importance,
          received_at, added_at, urgent_pinged_at)
         VALUES ('a', 20, 'x@x.com', 's', 'x', 5, 20, 20, 1500)`,
      )
      .run();
    const delivered = db
      .prepare(
        `INSERT INTO email_pending
         (account_id, message_uid, from_addr, subject, snippet, importance,
          received_at, added_at, delivered_at)
         VALUES ('a', 21, 'x@x.com', 's', 'x', 3, 21, 21, 1600)`,
      )
      .run();
    const awaitingId = seedAwaiting(db, { accountId: 'a', uid: 22 });

    let polledUids: number[] = [];
    const flagFetcher = vi.fn<FlagFetcher>(async (_acc, uids) => {
      polledUids = uids;
      return uids.map((uid) => ({ uid, seen: true, answered: false }));
    });

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []),
      maxUidProbe: noProbe, validityProbe: noValidity,
      now: 2000, flagFetcher,
    });

    // Only the awaiting UID was re-checked; pinged/delivered rows weren't fetched.
    expect(polledUids).toEqual([22]);
    expect(isDelivered(db, awaitingId)).toBe(true);
    // The urgent-pinged and delivered rows keep their original timestamps.
    const pingedRow = db
      .prepare('SELECT urgent_pinged_at, delivered_at FROM email_pending WHERE id = ?')
      .get(Number(pinged.lastInsertRowid)) as { urgent_pinged_at: number; delivered_at: number | null };
    expect(pingedRow.urgent_pinged_at).toBe(1500);
    expect(pingedRow.delivered_at).toBeNull();
    const deliveredRow = db
      .prepare('SELECT delivered_at FROM email_pending WHERE id = ?')
      .get(Number(delivered.lastInsertRowid)) as { delivered_at: number };
    expect(deliveredRow.delivered_at).toBe(1600);
  });

  it('no flagFetcher wired → no sync, awaiting row untouched', async () => {
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const id = seedAwaiting(getDb(), { accountId: 'a', uid: 9 });

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []),
      maxUidProbe: noProbe, validityProbe: noValidity,
      now: 2000, // no flagFetcher
    });

    expect(isDelivered(getDb(), id)).toBe(false);
  });

  it('only syncs the current account\'s awaiting UIDs', async () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 100, 1);
    store.updateLastSeenUid('b', 100, 1);
    seedAwaiting(getDb(), { accountId: 'a', uid: 11 });
    seedAwaiting(getDb(), { accountId: 'b', uid: 22 });
    const flagFetcher = vi.fn<FlagFetcher>(async (_acc, uids) =>
      uids.map((uid) => ({ uid, seen: false, answered: false })),
    );

    await runPollTick({
      accounts: [accA, accB], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []),
      maxUidProbe: noProbe, validityProbe: noValidity,
      now: 2000, flagFetcher,
    });

    const calls = flagFetcher.mock.calls;
    expect(calls.find((c) => c[0].id === 'a')?.[1]).toEqual([11]);
    expect(calls.find((c) => c[0].id === 'b')?.[1]).toEqual([22]);
  });

  it('a throwing flag fetch is isolated: no account error, awaiting untouched', async () => {
    const store = createEmailStore({ db: getDb() });
    ongoing(store);
    const id = seedAwaiting(getDb(), { accountId: 'a', uid: 12 });
    const flagFetcher = vi.fn<FlagFetcher>(async () => { throw new Error('imap boom'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => []), scorer: vi.fn(async () => []),
      maxUidProbe: noProbe, validityProbe: noValidity,
      now: 2000, flagFetcher,
    });

    expect(store.getAccountError('a')).toBeNull();
    expect(isDelivered(getDb(), id)).toBe(false);
    errSpy.mockRestore();
  });

  it('also runs when new mail arrives in the same tick', async () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 100, 1);
    const id = seedAwaiting(getDb(), { accountId: 'a', uid: 13 });
    const flagFetcher = vi.fn<FlagFetcher>(async () => [{ uid: 13, seen: true, answered: false }]);

    await runPollTick({
      accounts: [accA], store,
      fetcher: vi.fn(async () => [msg(150)]),
      scorer: vi.fn(async (ms: NewMessage[]) => ms.map((m) => ({ uid: m.uid, importance: 5 }))),
      maxUidProbe: noProbe, validityProbe: noValidity,
      now: 2000, flagFetcher,
    });

    expect(store.getLastSeenUid('a')).toBe(150); // new mail processed
    expect(isDelivered(getDb(), id)).toBe(true); // and the awaiting row cleared
  });
});

describe('runPollTick — onAccountBlind alert', () => {
  // Run `count` ticks that all fail for account `a`, returning the store and the
  // alert spy so tests can assert call counts/args.
  async function failTicks(
    count: number,
    opts: { blindAlertAfter?: number; onAccountBlind?: ReturnType<typeof vi.fn> } = {},
  ) {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 1, 100); // bypass first-tick branch
    const fetcher = vi.fn(async () => { throw new Error('socket-boom'); });
    const scorer = vi.fn(async (ms: NewMessage[]) => ms.map((m) => ({ uid: m.uid, importance: 5 })));
    const onAccountBlind = opts.onAccountBlind ?? vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < count; i++) {
      await runPollTick({
        accounts: [accA], store, fetcher, scorer,
        maxUidProbe: noProbe, validityProbe: noValidity,
        blindAlertAfter: opts.blindAlertAfter ?? 3,
        onAccountBlind,
        now: 1000 + i,
      });
    }
    errSpy.mockRestore();
    return { store, onAccountBlind, fetcher };
  }

  it('does NOT fire before the threshold', async () => {
    const { onAccountBlind } = await failTicks(2, { blindAlertAfter: 3 });
    expect(onAccountBlind).not.toHaveBeenCalled();
  });

  it('fires exactly once at the threshold with account/streak/lastError', async () => {
    const { onAccountBlind } = await failTicks(3, { blindAlertAfter: 3 });
    expect(onAccountBlind).toHaveBeenCalledTimes(1);
    expect(onAccountBlind).toHaveBeenCalledWith({
      account: 'a',
      consecutive: 3,
      lastError: 'socket-boom',
    });
  });

  it('does NOT re-fire on further failures past the threshold', async () => {
    const { onAccountBlind } = await failTicks(6, { blindAlertAfter: 3 });
    expect(onAccountBlind).toHaveBeenCalledTimes(1);
  });

  it('re-fires after a successful tick resets the streak', async () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 1, 100);
    const onAccountBlind = vi.fn();
    const scorer = vi.fn(async (ms: NewMessage[]) => ms.map((m) => ({ uid: m.uid, importance: 2 })));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = (fetcher: MessageFetcher, now: number) =>
      runPollTick({
        accounts: [accA], store, fetcher, scorer,
        maxUidProbe: noProbe, validityProbe: noValidity,
        blindAlertAfter: 2, onAccountBlind, now,
      });
    const fail: MessageFetcher = async () => { throw new Error('down'); };
    const ok: MessageFetcher = async () => [msg(5)];

    await run(fail, 1); await run(fail, 2); // hits threshold → alert #1
    expect(onAccountBlind).toHaveBeenCalledTimes(1);
    await run(ok, 3); // success clears consecutive_errors + blind_alerted
    await run(fail, 4); await run(fail, 5); // blind again → alert #2
    expect(onAccountBlind).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });

  it('a successful poll with NO new mail clears the streak and re-arms the alert', async () => {
    // Regression: the no-new-mail path returns without calling updateLastSeenUid /
    // setLastSeenAndValidity, so it must clear the error state itself — otherwise a
    // recovered-but-quiet mailbox keeps a stale last_error + latched blind_alerted
    // and never alerts on a later, distinct blind spell.
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 1, 100);
    const onAccountBlind = vi.fn();
    const scorer = vi.fn(async (ms: NewMessage[]) => ms.map((m) => ({ uid: m.uid, importance: 2 })));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = (fetcher: MessageFetcher, now: number) =>
      runPollTick({
        accounts: [accA], store, fetcher, scorer,
        maxUidProbe: noProbe, validityProbe: noValidity,
        blindAlertAfter: 2, onAccountBlind, now,
      });
    const fail: MessageFetcher = async () => { throw new Error('down'); };
    const okQuiet: MessageFetcher = async () => []; // connected, but no new mail

    await run(fail, 1); await run(fail, 2); // hits threshold → alert #1
    expect(onAccountBlind).toHaveBeenCalledTimes(1);

    await run(okQuiet, 3); // recovery tick with no new mail
    expect(store.getAccountErrorState('a')).toEqual({
      consecutive_errors: 0, blind_alerted: 0, last_error: null,
    });
    expect(store.getAccountError('a')).toBeNull(); // stale last_error cleared

    await run(fail, 4); await run(fail, 5); // blind again → alert #2 (re-armed)
    expect(onAccountBlind).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });

  it('is skipped when no onAccountBlind is wired (no throw)', async () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 1, 100);
    const fetcher = vi.fn(async () => { throw new Error('boom'); });
    const scorer = vi.fn(async (ms: NewMessage[]) => ms.map((m) => ({ uid: m.uid, importance: 5 })));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runPollTick({
      accounts: [accA], store, fetcher, scorer,
      maxUidProbe: noProbe, validityProbe: noValidity,
      blindAlertAfter: 1, now: 1,
    });
    expect(store.getAccountErrorState('a')?.consecutive_errors).toBe(1);
    errSpy.mockRestore();
  });

  it('blindAlertAfter <= 0 disables the alert while the streak still climbs', async () => {
    // The `threshold > 0` guard means a non-positive blindAlertAfter turns the
    // feature off even with onAccountBlind wired — the error counter must still
    // increment so visibility/self-heal are unaffected.
    const { store, onAccountBlind } = await failTicks(5, { blindAlertAfter: 0 });
    expect(onAccountBlind).not.toHaveBeenCalled();
    expect(store.getAccountErrorState('a')?.consecutive_errors).toBe(5);
  });

  it('a throwing alert hook does not crash the tick or latch the account, and retries next tick', async () => {
    // onAccountBlind dispatches onto an EventEmitter where a listener can throw
    // synchronously. Such a failure must not escape the per-account catch (no
    // tick crash) and must not latch blind_alerted — so the alert retries while
    // the account stays blind. First tick throws, second succeeds.
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 1, 100);
    const fetcher = vi.fn(async () => { throw new Error('socket-boom'); });
    const scorer = vi.fn(async (ms: NewMessage[]) => ms.map((m) => ({ uid: m.uid, importance: 5 })));
    const onAccountBlind = vi.fn()
      .mockImplementationOnce(() => { throw new Error('bus-listener-boom'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Tick 1: streak hits threshold (1), hook throws → must not reject.
    await expect(
      runPollTick({
        accounts: [accA], store, fetcher, scorer,
        maxUidProbe: noProbe, validityProbe: noValidity,
        blindAlertAfter: 1, onAccountBlind, now: 1000,
      }),
    ).resolves.toBeUndefined();
    expect(onAccountBlind).toHaveBeenCalledTimes(1);
    // Not latched: the failed dispatch left blind_alerted clear.
    expect(store.getAccountErrorState('a')?.blind_alerted).toBe(0);

    // Tick 2: still blind, hook retried and now succeeds → latched.
    await runPollTick({
      accounts: [accA], store, fetcher, scorer,
      maxUidProbe: noProbe, validityProbe: noValidity,
      blindAlertAfter: 1, onAccountBlind, now: 1001,
    });
    expect(onAccountBlind).toHaveBeenCalledTimes(2);
    expect(store.getAccountErrorState('a')?.blind_alerted).toBe(1);
    errSpy.mockRestore();
  });
});
