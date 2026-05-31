import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db.js';
import { createEmailStore } from '../store.js';
import { createEmailFeedbackStore } from '../feedback-store.js';
import { runPollTick, type FlagFetcher, type FeedbackResolution } from '../multi-account-poller.js';
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

  it('first tick (no row) → validityProbe NOT called (exits before ongoing block)', async () => {
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
    expect(validityProbe).not.toHaveBeenCalled();
    expect(store.getLastSeenUid('a')).toBe(42);
    expect(store.getUidValidity('a')).toBeNull(); // initialized on the 2nd tick via backfill
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
