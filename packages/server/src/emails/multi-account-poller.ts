import type { ImapAccount, NewMessage } from './types.js';
import type { EmailStore } from './store.js';
import type { EmailFeedbackStore } from './feedback-store.js';
import type { EmailSuppressionStore } from './suppression-store.js';
import { evaluateSender, type FeedbackScorerConfig } from './feedback-scorer.js';

export type MessageFetcher = (account: ImapAccount, sinceUid: number, limit: number) => Promise<NewMessage[]>;
export type MessageScorer = (msgs: NewMessage[]) => Promise<Array<{ uid: number; importance: number }>>;
export type MaxUidProbe = (account: ImapAccount) => Promise<number>;
/** Re-poll IMAP flags for an explicit UID list (see imap-client.fetchFlagsForUids).
 *  Best-effort: returns whatever it gathered, never throws into the poll loop. */
export type FlagFetcher = (
  account: ImapAccount,
  uids: number[],
) => Promise<Array<{ uid: number; seen: boolean; answered: boolean }>>;

/** Optional implicit-feedback resolution wiring. Absent (feature disabled) →
 *  the poll tick behaves exactly as before (no flag re-poll, no finalization). */
export interface FeedbackResolution {
  store: EmailFeedbackStore;
  flagFetcher: FlagFetcher;
  /** Hours after the ping before a not-yet-answered email is finalized as
   *  `read` (was `\Seen`) or `ignored` (never opened). */
  ignoreHours: number;
  /** Cap on unresolved rows re-polled per tick (IMAP-cost guard). */
  maxRepoll: number;
  /** Optional auto-suppression scoring run after each finalized outcome.
   *  Absent → outcomes are recorded but never act on the suppression rules. */
  scorer?: {
    suppressionStore: EmailSuppressionStore;
    config: FeedbackScorerConfig;
  };
}

interface TickParams {
  accounts: ImapAccount[];
  store: EmailStore;
  fetcher: MessageFetcher;
  scorer: MessageScorer;
  maxUidProbe: MaxUidProbe;
  now: number;
  fetchLimit?: number;
  importanceCutoff?: number;
  feedback?: FeedbackResolution;
}

const DEFAULT_FETCH_LIMIT = 50;
const DEFAULT_CUTOFF = 4;
const HOUR_MS = 3_600_000;
// Grace window for finalization after the ignore deadline: a row stays eligible
// for re-poll/finalize for this long past `ignoreHours` so a few missed ticks
// (downtime, slow IMAP) don't strand it forever as unresolved.
const FEEDBACK_FINALIZE_GRACE_MS = 7 * 24 * HOUR_MS;

// Implicit-feedback resolution for a single account: re-poll IMAP flags for the
// emails we pinged about that are still unresolved, record first-seen
// timestamps, and finalize each outcome once its window elapses.
//
// State machine (per pinged email):
//   `\Answered`            → replied   (immediately, even within the window)
//   `\Seen`, window over   → read
//   never seen, window over→ ignored
//   else                   → stays unresolved (re-checked next tick)
//
// Best-effort: scoped to its own try/catch so a flag re-poll failure is logged
// and never escalates into the account's setAccountError path.
// Run the downgrade-only scorer for a sender whose outcome just finalized.
// Scoped try/catch so a suppression-store hiccup never escalates into the
// account's error path. No-op when scoring isn't wired (feature/flag off).
function scoreSender(
  feedback: FeedbackResolution,
  sender: string,
  now: number,
): void {
  if (!feedback.scorer) return;
  try {
    evaluateSender(
      sender,
      feedback.store,
      feedback.scorer.suppressionStore,
      feedback.scorer.config,
      now,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[emails] feedback scoring failed for ${sender}:`, msg);
  }
}

async function resolveAccountFeedback(
  account: ImapAccount,
  feedback: FeedbackResolution | undefined,
  now: number,
): Promise<void> {
  if (!feedback) return;
  try {
    const ignoreMs = feedback.ignoreHours * HOUR_MS;
    // Window = wait period + grace, so a row missed across a few ticks still
    // gets finalized rather than aging out of `findUnresolved` unresolved.
    const maxAgeMs = ignoreMs + FEEDBACK_FINALIZE_GRACE_MS;
    // findUnresolved spans all accounts; filter to this one before the IMAP
    // call so we never fetch another account's UIDs against this connection.
    const rows = feedback.store
      .findUnresolved(now, maxAgeMs, feedback.maxRepoll)
      .filter((r) => r.account_id === account.id);
    if (rows.length === 0) return;

    const flags = await feedback.flagFetcher(
      account,
      rows.map((r) => r.message_uid),
    );
    // Empty result = the re-poll failed (fetchFlagsForUids swallows errors to
    // []). Don't finalize on stale data — leave the rows for the next tick.
    if (flags.length === 0) return;
    const flagByUid = new Map(flags.map((f) => [f.uid, f]));

    for (const row of rows) {
      const f = flagByUid.get(row.message_uid);
      if (f) {
        feedback.store.updateFlags(row.pending_id, {
          seenAt: f.seen ? now : undefined,
          answeredAt: f.answered ? now : undefined,
        });
      }
      // Combine this poll with any earlier observation (updateFlags COALESCEs,
      // but `row` is the pre-update snapshot, so OR them here).
      const answered = row.answered_at != null || (f?.answered ?? false);
      const seen = row.seen_at != null || (f?.seen ?? false);
      if (answered) {
        feedback.store.finalize(row.pending_id, 'replied', now);
        scoreSender(feedback, row.from_addr, now);
      } else if (now - row.pinged_at >= ignoreMs) {
        feedback.store.finalize(row.pending_id, seen ? 'read' : 'ignored', now);
        scoreSender(feedback, row.from_addr, now);
      }
      // else: still inside the window → leave unresolved.
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[emails] feedback resolution failed for ${account.id}:`, msg);
  }
}

export async function runPollTick(params: TickParams): Promise<void> {
  const fetchLimit = params.fetchLimit ?? DEFAULT_FETCH_LIMIT;
  const cutoff = params.importanceCutoff ?? DEFAULT_CUTOFF;

  await Promise.all(
    params.accounts.map(async (acc) => {
      try {
        // First tick for a fresh account (no row in email_account_state yet):
        // skip the historical backlog by probing the inbox's current max UID
        // and persisting it. Fetching from UID 1 would crawl years of mail at
        // 50/tick, blocking real new arrivals (which sit at higher UIDs) for
        // hours. We gate on row existence rather than `last_seen_uid === 0`
        // so that an account whose first-tick probe legitimately returned 0
        // (empty inbox) is treated as ongoing on the next tick — otherwise
        // the very first email to arrive in a fresh empty mailbox would be
        // dropped by a second first-tick probe.
        if (!params.store.hasAccountState(acc.id)) {
          try {
            const maxUid = await params.maxUidProbe(acc);
            params.store.updateLastSeenUid(acc.id, maxUid, params.now);
            console.log(
              `[emails] first tick for ${acc.id}: skipping backlog, last_seen_uid set to ${maxUid}`,
            );
          } catch (err) {
            // Don't write a state row on probe failure — next tick must retry
            // the first-tick branch (writing a row would force the ongoing
            // path which would crawl UID 1:* — the exact backlog we're
            // trying to skip).
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[emails] first-tick probe failed for ${acc.id}:`, msg);
          }
          return;
        }

        const sinceUid = params.store.getLastSeenUid(acc.id);
        const msgs = await params.fetcher(acc, sinceUid, fetchLimit);
        if (msgs.length === 0) {
          // No new mail, but unresolved feedback rows may still need a flag
          // re-poll (the user could have opened/replied since the ping).
          await resolveAccountFeedback(acc, params.feedback, params.now);
          return;
        }

        const scored = await params.scorer(msgs);
        const byUid = new Map(scored.map((s) => [s.uid, s.importance]));

        for (const m of msgs) {
          // Scorer guarantees coverage on success (see scorer.ts normalize).
          // A missing uid here signals a contract break, not a "low importance"
          // call — skip rather than default to 3 and silently drop.
          if (!byUid.has(m.uid)) continue;
          const importance = byUid.get(m.uid)!;
          if (importance >= cutoff) {
            params.store.insertPending({
              account_id: acc.id,
              message_uid: m.uid,
              from_addr: m.from,
              subject: m.subject,
              snippet: m.snippet,
              importance,
              received_at: m.receivedAt,
              added_at: params.now,
            });
          }
        }

        const maxUid = msgs.reduce((m, x) => Math.max(m, x.uid), 0);
        if (maxUid > 0) {
          params.store.updateLastSeenUid(acc.id, maxUid, params.now);
        }

        await resolveAccountFeedback(acc, params.feedback, params.now);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        params.store.setAccountError(acc.id, msg, params.now);
      }
    }),
  );
}

interface StartParams extends Omit<TickParams, 'now'> {
  intervalMs: number;
}

export function startEmailPoller(params: StartParams): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Self-scheduling loop: the next tick is only queued once the current one
  // resolves. setInterval would fire concurrently when a tick runs longer
  // than intervalMs (slow IMAP / LLM), doubling cost and racing on state.
  const runOnce = async () => {
    if (stopped) return;
    try {
      await runPollTick({ ...params, now: Date.now() });
    } catch (err) {
      console.error('[emails] poll tick crashed:', err instanceof Error ? err.message : err);
    }
    if (!stopped) {
      timer = setTimeout(runOnce, params.intervalMs);
    }
  };
  void runOnce();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
