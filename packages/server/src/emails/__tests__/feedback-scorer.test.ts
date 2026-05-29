import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb, closeDb } from '../../db.js';
import { createEmailStore } from '../store.js';
import { createEmailFeedbackStore } from '../feedback-store.js';
import { createEmailSuppressionStore } from '../suppression-store.js';
import {
  evaluateSender,
  AUTO_FEEDBACK_VIA,
  type FeedbackScorerConfig,
} from '../feedback-scorer.js';
import type { FeedbackOutcome } from '../feedback-store.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

const DAY = 86400_000;

const CFG: FeedbackScorerConfig = {
  lookbackMs: 30 * DAY,
  suppressAfter: 3,
  suppressTtlDays: 7,
};

/** Insert a pending row and a resolved feedback row for it, returning nothing.
 *  `pingedAt` defaults near `now` so it sits inside the lookback window. */
function addResolved(
  from_addr: string,
  outcome: FeedbackOutcome,
  opts: { uid: number; pingedAt: number },
): void {
  const db = getDb();
  const store = createEmailStore({ db });
  store.insertPending({
    account_id: 'acc1',
    message_uid: opts.uid,
    from_addr,
    subject: 's',
    snippet: 'x',
    importance: 5,
    received_at: opts.pingedAt,
    added_at: opts.pingedAt,
  });
  const row = db
    .prepare('SELECT id FROM email_pending WHERE message_uid = ?')
    .get(opts.uid) as { id: number };
  const fb = createEmailFeedbackStore({ db });
  fb.recordPinged(row.id, opts.pingedAt);
  fb.finalize(row.id, outcome, opts.pingedAt + 1);
}

describe('evaluateSender', () => {
  it('creates a TTL\'d auto_feedback rule once negative outcomes reach the threshold', () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fb = createEmailFeedbackStore({ db: getDb() });
    const sup = createEmailSuppressionStore({ db: getDb() });

    addResolved('noisy@x.com', 'ignored', { uid: 1, pingedAt: now - 3 * DAY });
    addResolved('noisy@x.com', 'read', { uid: 2, pingedAt: now - 2 * DAY });
    addResolved('noisy@x.com', 'ignored', { uid: 3, pingedAt: now - 1 * DAY });

    const res = evaluateSender('noisy@x.com', fb, sup, CFG, now);

    expect(res.action).toBe('suppressed');
    expect(res.ruleId).toBeGreaterThan(0);
    const rule = getDb()
      .prepare('SELECT * FROM email_suppression_rules WHERE id = ?')
      .get(res.ruleId) as {
        rule_type: string;
        pattern: string;
        created_via: string;
        expires_at: number;
      };
    expect(rule.rule_type).toBe('sender');
    expect(rule.pattern).toBe('noisy@x.com');
    expect(rule.created_via).toBe(AUTO_FEEDBACK_VIA);
    expect(rule.expires_at).toBe(now + CFG.suppressTtlDays * DAY);
  });

  it('does not suppress below the threshold', () => {
    const now = 1_700_000_000_000;
    addResolved('quiet@x.com', 'ignored', { uid: 1, pingedAt: now - DAY });
    addResolved('quiet@x.com', 'read', { uid: 2, pingedAt: now - DAY });

    const fb = createEmailFeedbackStore({ db: getDb() });
    const sup = createEmailSuppressionStore({ db: getDb() });
    const res = evaluateSender('quiet@x.com', fb, sup, CFG, now);

    expect(res.action).toBe('none');
    expect(sup.listActive(now)).toHaveLength(0);
  });

  it('does not duplicate an already-active rule', () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fb = createEmailFeedbackStore({ db: getDb() });
    const sup = createEmailSuppressionStore({ db: getDb() });
    // Pre-existing active auto rule for the same sender.
    sup.insertRule({
      rule_type: 'sender',
      pattern: 'noisy@x.com',
      ttl_days: 7,
      created_via: AUTO_FEEDBACK_VIA,
    });

    addResolved('noisy@x.com', 'ignored', { uid: 1, pingedAt: now - 3 * DAY });
    addResolved('noisy@x.com', 'ignored', { uid: 2, pingedAt: now - 2 * DAY });
    addResolved('noisy@x.com', 'read', { uid: 3, pingedAt: now - DAY });

    const res = evaluateSender('noisy@x.com', fb, sup, CFG, now);

    expect(res.action).toBe('none');
    expect(sup.listActive(now)).toHaveLength(1); // no duplicate
  });

  it('clears active auto_feedback rule on a reply, leaving manual rules untouched', () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fb = createEmailFeedbackStore({ db: getDb() });
    const sup = createEmailSuppressionStore({ db: getDb() });

    const auto = sup.insertRule({
      rule_type: 'sender',
      pattern: 'boss@x.com',
      ttl_days: 7,
      created_via: AUTO_FEEDBACK_VIA,
    });
    const manual = sup.insertRule({
      rule_type: 'sender',
      pattern: 'spam@y.com',
      ttl_days: 7,
      created_via: 'discord_button',
    });

    addResolved('boss@x.com', 'replied', { uid: 1, pingedAt: now - DAY });

    const res = evaluateSender('boss@x.com', fb, sup, CFG, now);

    expect(res.action).toBe('cleared');
    expect(res.clearedRuleIds).toEqual([auto.id]);
    const remaining = sup.listActive(now);
    expect(remaining.map((r) => r.id)).toEqual([manual.id]);
  });

  it('does not touch a manual rule for the same sender on reply', () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fb = createEmailFeedbackStore({ db: getDb() });
    const sup = createEmailSuppressionStore({ db: getDb() });

    const manual = sup.insertRule({
      rule_type: 'sender',
      pattern: 'boss@x.com',
      ttl_days: 7,
      created_via: 'discord_button',
    });
    addResolved('boss@x.com', 'replied', { uid: 1, pingedAt: now - DAY });

    const res = evaluateSender('boss@x.com', fb, sup, CFG, now);

    expect(res.action).toBe('none');
    expect(sup.listActive(now).map((r) => r.id)).toEqual([manual.id]);
  });

  it('a reply prevents suppression even when negatives are present', () => {
    const now = 1_700_000_000_000;
    const fb = createEmailFeedbackStore({ db: getDb() });
    const sup = createEmailSuppressionStore({ db: getDb() });

    addResolved('mixed@x.com', 'ignored', { uid: 1, pingedAt: now - 4 * DAY });
    addResolved('mixed@x.com', 'ignored', { uid: 2, pingedAt: now - 3 * DAY });
    addResolved('mixed@x.com', 'read', { uid: 3, pingedAt: now - 2 * DAY });
    addResolved('mixed@x.com', 'replied', { uid: 4, pingedAt: now - DAY });

    const res = evaluateSender('mixed@x.com', fb, sup, CFG, now);

    expect(res.action).toBe('none'); // reply wins; nothing to clear, no suppress
    expect(sup.listActive(now)).toHaveLength(0);
  });

  it('ignores outcomes outside the lookback window', () => {
    const now = 1_700_000_000_000;
    const fb = createEmailFeedbackStore({ db: getDb() });
    const sup = createEmailSuppressionStore({ db: getDb() });
    // All three negatives are older than the 30-day lookback.
    addResolved('old@x.com', 'ignored', { uid: 1, pingedAt: now - 40 * DAY });
    addResolved('old@x.com', 'ignored', { uid: 2, pingedAt: now - 35 * DAY });
    addResolved('old@x.com', 'read', { uid: 3, pingedAt: now - 31 * DAY });

    const res = evaluateSender('old@x.com', fb, sup, CFG, now);

    expect(res.action).toBe('none');
    expect(sup.listActive(now)).toHaveLength(0);
  });
});
