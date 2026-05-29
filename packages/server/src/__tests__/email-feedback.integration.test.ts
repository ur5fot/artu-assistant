import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, getDb, closeDb } from '../db.js';
import { createEmailStore } from '../emails/store.js';
import { createEmailSuppressionStore } from '../emails/suppression-store.js';
import { createEmailFeedbackStore } from '../emails/feedback-store.js';
import { createEmailUrgentHandler } from '../cognition/handlers/emailUrgent.js';
import { runPollTick, type FeedbackResolution } from '../emails/multi-account-poller.js';
import { AUTO_FEEDBACK_VIA } from '../emails/feedback-scorer.js';
import type { ImapAccount, EmailPendingRow, NewMessage } from '../emails/types.js';

// Integration boundaries: real EmailStore + EmailSuppressionStore +
// EmailFeedbackStore + emailUrgent handler + poll-tick resolution/scorer, all
// against one in-memory SQLite. Only IMAP I/O is faked (message fetcher +
// flag fetcher). This pins the full implicit-feedback path the way index.ts
// wires it — it is not a re-test of per-module branch coverage.

const ACCOUNT: ImapAccount = {
  id: 'acc-1',
  host: 'imap.example.com',
  port: 993,
  user: 'me@example.com',
  password: 'secret',
  tls: true,
} as ImapAccount;

const SENDER = 'noisy@newsletter.com';
const HOUR_MS = 3_600_000;
// Outside the 22:00 Europe/Kyiv quiet window (12:00 UTC = 14:00 Kyiv).
const PING_TIME = new Date('2024-01-15T12:00:00Z').getTime();

function insertPending(opts: {
  message_uid: number;
  received_at: number;
  from_addr?: string;
  subject?: string;
}): EmailPendingRow {
  const store = createEmailStore({ db: getDb() });
  store.insertPending({
    account_id: ACCOUNT.id,
    message_uid: opts.message_uid,
    from_addr: opts.from_addr ?? SENDER,
    subject: opts.subject ?? `Subject ${opts.message_uid}`,
    snippet: 'snip',
    importance: 5,
    received_at: opts.received_at,
    added_at: opts.received_at + 1_000,
  });
  return getDb()
    .prepare('SELECT * FROM email_pending WHERE message_uid = ? AND account_id = ?')
    .get(opts.message_uid, ACCOUNT.id) as EmailPendingRow;
}

// Drive one urgent ping through the real handler: trigger → run → onPublished
// (which marks urgent_pinged_at AND records a feedback row). onPublished stamps
// the ping epoch with Date.now(), so the caller derives the re-poll `now` from
// the real clock (PING ≈ now) rather than the synthetic PING_TIME used only for
// the quiet-hours check.
async function pingOnce(
  handler: ReturnType<typeof createEmailUrgentHandler>,
): Promise<void> {
  const triggered = await handler.trigger(
    { now: PING_TIME, lastFiredAt: null, lastResult: null },
    { db: getDb() },
  );
  if (!triggered) return;
  const res = await handler.run({
    db: getDb(),
    signal: new AbortController().signal,
    firedAt: PING_TIME,
  });
  if ('publish' in res && res.publish && typeof res.onPublished === 'function') {
    res.onPublished();
  }
}

function makeFeedback(
  feedbackStore: ReturnType<typeof createEmailFeedbackStore>,
  suppressionStore: ReturnType<typeof createEmailSuppressionStore>,
  flagFetcher: FeedbackResolution['flagFetcher'],
): FeedbackResolution {
  return {
    store: feedbackStore,
    flagFetcher,
    ignoreHours: 24,
    maxRepoll: 50,
    scorer: {
      suppressionStore,
      config: { lookbackMs: 7 * 24 * HOUR_MS, suppressAfter: 3, suppressTtlDays: 7 },
    },
  };
}

describe('email implicit feedback — integration', () => {
  beforeEach(() => initDb(':memory:'));
  afterEach(() => closeDb());

  it('ping → ignored×3 → auto-suppress → next email from sender demoted to digest', async () => {
    const emailStore = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const feedbackStore = createEmailFeedbackStore({ db: getDb() });
    const handler = createEmailUrgentHandler({
      store: emailStore,
      suppressionStore,
      feedbackStore,
      tz: 'Europe/Kyiv',
      quietStart: 22,
    });

    // Seed account state so runPollTick treats it as ongoing (a fresh account
    // does a backlog-skip probe and returns before the feedback resolution).
    emailStore.updateLastSeenUid(ACCOUNT.id, 1_000, PING_TIME);

    // Three urgent emails from the same noisy sender, each pinged. onPublished
    // stamps pinged_at with the real clock.
    for (let i = 0; i < 3; i++) {
      insertPending({ message_uid: 100 + i, received_at: PING_TIME + i * 1_000 });
      await pingOnce(handler);
    }
    expect(
      (getDb().prepare('SELECT COUNT(*) c FROM email_feedback').get() as { c: number }).c,
    ).toBe(3);

    // Re-poll well past the ignore window; the user never opened any of them.
    // Derive from the real clock since onPublished used Date.now() for pinged_at.
    const pollNow = Date.now() + 25 * HOUR_MS;
    const flagFetcher: FeedbackResolution['flagFetcher'] = async (_acc, uids) =>
      uids.map((uid) => ({ uid, seen: false, answered: false }));
    const fetcher = async (): Promise<NewMessage[]> => [];

    await runPollTick({
      accounts: [ACCOUNT],
      store: emailStore,
      fetcher,
      scorer: async () => [],
      maxUidProbe: async () => 200,
      now: pollNow,
      feedback: makeFeedback(feedbackStore, suppressionStore, flagFetcher),
    });

    // All three finalized as ignored.
    const outcomes = getDb()
      .prepare('SELECT outcome FROM email_feedback WHERE resolved_at IS NOT NULL')
      .all() as { outcome: string }[];
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.outcome === 'ignored')).toBe(true);

    // An auto-feedback suppression rule now exists for the sender with the
    // configured 7-day TTL.
    const rules = suppressionStore.listActive(pollNow);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      rule_type: 'sender',
      pattern: SENDER,
      created_via: AUTO_FEEDBACK_VIA,
    });
    // insertRule stamps expires_at from its own Date.now(), so check the 7-day
    // TTL against the real clock with a generous tolerance.
    const expectedExpiry = Date.now() + 7 * 24 * HOUR_MS;
    expect(rules[0]!.expires_at).toBeGreaterThan(expectedExpiry - 60_000);
    expect(rules[0]!.expires_at).toBeLessThan(expectedExpiry + 60_000);

    // A new urgent email from the same sender is demoted (-1 → falls into the
    // digest) by the existing findActiveMatch check, no new code path.
    const row4 = insertPending({ message_uid: 200, received_at: pollNow + 1_000 });
    const triggered = await handler.trigger(
      { now: pollNow, lastFiredAt: null, lastResult: null },
      { db: getDb() },
    );
    expect(triggered).toBe(false);
    const row4After = emailStore.findByPendingId(row4.id);
    expect(row4After!.urgent_pinged_at).toBe(-1);
  });

  it('reply → auto-rule cleared, manual rule untouched', async () => {
    const emailStore = createEmailStore({ db: getDb() });
    const suppressionStore = createEmailSuppressionStore({ db: getDb() });
    const feedbackStore = createEmailFeedbackStore({ db: getDb() });
    const handler = createEmailUrgentHandler({
      store: emailStore,
      suppressionStore,
      feedbackStore,
      tz: 'Europe/Kyiv',
      quietStart: 22,
    });

    // Seed account state so runPollTick runs the feedback resolution (see above).
    emailStore.updateLastSeenUid(ACCOUNT.id, 1_000, PING_TIME);

    // Pre-existing auto-feedback rule for the sender + an unrelated manual rule.
    const autoRule = suppressionStore.insertRule({
      rule_type: 'sender',
      pattern: SENDER,
      ttl_days: 7,
      created_via: AUTO_FEEDBACK_VIA,
    });
    const manualRule = suppressionStore.insertRule({
      rule_type: 'sender',
      pattern: 'someone@else.com',
      ttl_days: 7,
      created_via: 'discord_button',
    });

    // Ping one email from the sender, then the user replies (\Answered).
    insertPending({ message_uid: 300, received_at: PING_TIME });
    // The active auto-rule would demote this; insert the feedback row directly
    // to model "a ping that did go out before the rule existed".
    feedbackStore.recordPinged(
      emailStore.findUnpingedUrgent()!.id,
      PING_TIME,
    );

    const pollNow = PING_TIME + 2 * HOUR_MS; // reply detected before ignore window
    const flagFetcher: FeedbackResolution['flagFetcher'] = async (_acc, uids) =>
      uids.map((uid) => ({ uid, seen: true, answered: true }));

    await runPollTick({
      accounts: [ACCOUNT],
      store: emailStore,
      fetcher: async () => [],
      scorer: async () => [],
      maxUidProbe: async () => 300,
      now: pollNow,
      feedback: makeFeedback(feedbackStore, suppressionStore, flagFetcher),
    });

    // Outcome is replied; the auto rule is gone, the manual rule survives.
    const fb = getDb()
      .prepare('SELECT outcome FROM email_feedback')
      .get() as { outcome: string };
    expect(fb.outcome).toBe('replied');

    const active = suppressionStore.listActive(pollNow);
    expect(active.find((r) => r.id === autoRule.id)).toBeUndefined();
    expect(active.find((r) => r.id === manualRule.id)).toBeDefined();
  });
});
