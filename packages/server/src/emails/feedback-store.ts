import type Database from 'better-sqlite3';
import { parseFromAddress } from './address.js';

export type FeedbackOutcome = 'replied' | 'read' | 'ignored';

/** One unresolved feedback row, joined to its `email_pending` source so the
 *  re-poll step (Task 5) has the account + UID needed to fetch IMAP flags. */
export interface UnresolvedFeedback {
  pending_id: number;
  account_id: string;
  message_uid: number;
  from_addr: string;
  pinged_at: number;
  seen_at: number | null;
  answered_at: number | null;
}

export interface SenderOutcomeCounts {
  replied: number;
  read: number;
  ignored: number;
}

export interface EmailFeedbackStore {
  /** Record that `pendingId` was urgent-pinged at `pingedAt`. Idempotent on
   *  the pending_id PK — a re-ping (shouldn't happen) leaves the first row. */
  recordPinged(pendingId: number, pingedAt: number): void;
  /** Unresolved rows (pinged, no `resolved_at`) whose ping is still within the
   *  age window (`pinged_at >= now - maxAgeMs`), oldest first, capped at
   *  `limit`. Joined to `email_pending` for the re-poll. */
  findUnresolved(now: number, maxAgeMs: number, limit: number): UnresolvedFeedback[];
  /** First-observation timestamps for the IMAP flags. COALESCE keeps the
   *  earliest non-null value so a later re-poll never clobbers when we first
   *  saw `\Seen`/`\Answered`. */
  updateFlags(pendingId: number, flags: { seenAt?: number; answeredAt?: number }): void;
  /** Terminal transition: set `outcome` + `resolved_at`. */
  finalize(pendingId: number, outcome: FeedbackOutcome, now: number): void;
  /** Counts of resolved outcomes for `sender` whose ping happened within the
   *  last `sinceMs` (anchored on `now`). Canonicalizes both sides to the bare
   *  address so display-name variants collapse to one sender. */
  recentOutcomesBySender(sender: string, sinceMs: number, now: number): SenderOutcomeCounts;
}

export function createEmailFeedbackStore(deps: {
  db: Database.Database;
}): EmailFeedbackStore {
  const { db } = deps;
  return {
    recordPinged(pendingId, pingedAt) {
      db.prepare(
        `INSERT OR IGNORE INTO email_feedback
         (pending_id, pinged_at, created_at)
         VALUES (?, ?, ?)`,
      ).run(pendingId, pingedAt, pingedAt);
    },
    findUnresolved(now, maxAgeMs, limit) {
      const minPingedAt = now - maxAgeMs;
      return db
        .prepare(
          `SELECT f.pending_id, f.pinged_at, f.seen_at, f.answered_at,
                  p.account_id, p.message_uid, p.from_addr
           FROM email_feedback f
           JOIN email_pending p ON p.id = f.pending_id
           WHERE f.resolved_at IS NULL AND f.pinged_at >= ?
           ORDER BY f.pinged_at ASC
           LIMIT ?`,
        )
        .all(minPingedAt, limit) as UnresolvedFeedback[];
    },
    updateFlags(pendingId, { seenAt, answeredAt }) {
      db.prepare(
        `UPDATE email_feedback
         SET seen_at = COALESCE(seen_at, ?),
             answered_at = COALESCE(answered_at, ?)
         WHERE pending_id = ?`,
      ).run(seenAt ?? null, answeredAt ?? null, pendingId);
    },
    finalize(pendingId, outcome, now) {
      db.prepare(
        `UPDATE email_feedback
         SET outcome = ?, resolved_at = ?
         WHERE pending_id = ?`,
      ).run(outcome, now, pendingId);
    },
    recentOutcomesBySender(sender, sinceMs, now) {
      const cutoff = now - sinceMs;
      const bare = parseFromAddress(sender);
      // Fetch the window, then canonicalize `from_addr` in JS so two
      // display-name variants ("John D" vs "John Doe") collapse to one sender
      // — same approach as store.countPendingFromSender, and avoids LIKE
      // wildcard / display-name-spoof pitfalls.
      const rows = db
        .prepare(
          `SELECT p.from_addr, f.outcome
           FROM email_feedback f
           JOIN email_pending p ON p.id = f.pending_id
           WHERE f.resolved_at IS NOT NULL
             AND f.outcome IS NOT NULL
             AND f.pinged_at >= ?`,
        )
        .all(cutoff) as { from_addr: string; outcome: FeedbackOutcome }[];
      const counts: SenderOutcomeCounts = { replied: 0, read: 0, ignored: 0 };
      for (const r of rows) {
        if (parseFromAddress(r.from_addr) === bare) counts[r.outcome]++;
      }
      return counts;
    },
  };
}
