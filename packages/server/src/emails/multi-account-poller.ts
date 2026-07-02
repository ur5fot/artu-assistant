import type { ImapAccount, NewMessage } from './types.js';
import type { EmailStore } from './store.js';
import type { EmailFeedbackStore } from './feedback-store.js';
import type { EmailSuppressionStore } from './suppression-store.js';
import { evaluateSender, type FeedbackScorerConfig } from './feedback-scorer.js';

export type MessageFetcher = (account: ImapAccount, sinceUid: number, limit: number) => Promise<NewMessage[]>;
export type MessageScorer = (msgs: NewMessage[]) => Promise<Array<{ uid: number; importance: number }>>;
/** Summarize a batch of above-cutoff emails into short native-language gists,
 *  keyed by uid. Best-effort: never throws (see summarizeGists), a missing uid
 *  simply yields no gist for that row (stored NULL → snippet shown). */
export type Gister = (
  msgs: Array<{ uid: number; from: string; subject: string; body: string }>,
) => Promise<Map<number, string>>;
export type MaxUidProbe = (account: ImapAccount) => Promise<number>;
/** Read the mailbox's current UIDVALIDITY (imap-client.getUidValidity). Probed
 *  at the start of every ongoing tick, BEFORE the fetch, so we never ingest a
 *  partial slice from a foreign UID epoch. A throw is treated like any other
 *  per-account failure (→ setAccountError, retried next tick). */
export type ValidityProbe = (account: ImapAccount) => Promise<number>;
/** Re-poll IMAP flags for an explicit UID list (see imap-client.fetchFlagsForUids).
 *  Best-effort: never throws into the poll loop. Returns the gathered rows on
 *  success ([] when every UID has left INBOX), or `null` on a hard fetch failure
 *  (connection/timeout/server NO|BAD) — a `null` carries no evidence and must
 *  not drive finalization. */
export type FlagFetcher = (
  account: ImapAccount,
  uids: number[],
) => Promise<Array<{ uid: number; seen: boolean; answered: boolean }> | null>;

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
  // Required (not optional) on purpose: this is the core detection mechanism,
  // like `provider` for window-logger. Making it optional would let forgotten
  // wiring silently re-introduce the exact silent-blindness class we're fixing.
  validityProbe: ValidityProbe;
  now: number;
  fetchLimit?: number;
  importanceCutoff?: number;
  // Optional native-language gist summarizer (behind EMAIL_GIST_ENABLED). Absent
  // or `gistEnabled` false → the gist step is skipped entirely (no LLM tokens
  // spent) and every row is stored with `gist=null` — behaviour identical to
  // before the feature. Only above-cutoff (ingested) messages are summarized.
  gister?: Gister;
  gistEnabled?: boolean;
  feedback?: FeedbackResolution;
  // Re-poll IMAP `\Seen` flags for the awaiting (queue-visible, non-urgent-pinged)
  // rows so any email the user already read OR moved out of INBOX in Gmail is
  // auto-dismissed from R2's queue (see syncSeenStatus). Unlike `feedback` this
  // is always-on wiring (no config flag): absent only when no flag fetcher is
  // available (e.g. tests, or email disabled) → the sync pass is skipped.
  flagFetcher?: FlagFetcher;
  // Per-account paging cursor (offset into the awaiting set) for the `\Seen`
  // sync, so a backlog larger than SEEN_SYNC_CAP is covered across successive
  // ticks instead of re-checking only the oldest cap forever (which would
  // permanently strand mid-queue rows the user has since handled in Gmail).
  // Owned by startEmailPoller's closure and passed in unchanged each tick.
  // Absent (single-shot / most tests) → the sync always starts at offset 0, so
  // a one-tick call still checks the oldest cap exactly as before.
  seenSyncCursors?: Map<string, number>;
  // Optional alert hook (like `onBlind`): fired once per UIDVALIDITY reset.
  onUidValidityReset?: (info: { account: string; previous: number; current: number }) => void;
  // After this many consecutive failed ticks an account is "blind" and
  // `onAccountBlind` fires once (latched via `blind_alerted` until the next
  // success clears the streak). Optional: omitted (or <= 0) disables the alert
  // entirely — the error is still recorded and logged, just never escalated.
  blindAlertAfter?: number;
  // Optional alert hook: fired exactly once when an account crosses
  // `blindAlertAfter` consecutive failures, until a successful tick resets it.
  onAccountBlind?: (info: { account: string; consecutive: number; lastError: string }) => void;
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
    // Scope to this account in SQL so `maxRepoll` is a per-account cap and we
    // never fetch another account's UIDs against this connection.
    const rows = feedback.store.findUnresolved(
      account.id,
      now,
      maxAgeMs,
      feedback.maxRepoll,
    );
    if (rows.length === 0) return;

    const flags = await feedback.flagFetcher(
      account,
      rows.map((r) => r.message_uid),
    );
    // `null` = a hard fetch failure (connection/timeout/server NO|BAD). It
    // carries no evidence about any UID, so we must not finalize this tick:
    // a row already observed `\Seen` whose message is still in INBOX could have
    // just been answered, and a *successful* re-poll would observe `\Answered`
    // and finalize `replied`. Finalizing it `read` here off stale `seen_at`
    // would fabricate negative feedback for a sender the user actually replied
    // to. Bail and leave every row unresolved for the next (hopefully
    // successful) tick — the grace window keeps them eligible.
    if (flags === null) return;
    // A successful-but-empty `[]` is different: every UID has left INBOX
    // (archived/deleted/moved). We do NOT bail — finalization below is gated on
    // `observed`, which for a UID absent this tick is true only when we recorded
    // `\Seen`/`\Answered` on an earlier tick. Such a row carries its own evidence
    // (a real prior observation, not stale flag data) and finalizes correctly as
    // read/replied; a row with no prior observation stays unresolved regardless.
    // Bailing here would strand already-observed rows whose message left INBOX
    // before the window elapsed — they'd age out unresolved and never finalize,
    // contradicting "seen_at set ⇒ read".
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
      // Did we actually observe this message's state? A UID that came back in
      // the flag fetch (`f`) or that we've seen before (`seen`/answered prior)
      // is observed. A UID *absent* from a non-empty fetch is no longer in
      // INBOX (moved/archived/deleted/expunged) — unknown state, NOT evidence
      // the user never opened it. Finalizing those as `ignored` would fabricate
      // negative feedback and could auto-suppress a sender the user triaged.
      const observed = f != null || seen || answered;
      if (answered) {
        feedback.store.finalize(row.pending_id, 'replied', now);
        scoreSender(feedback, row.from_addr, now);
      } else if (observed && now - row.pinged_at >= ignoreMs) {
        feedback.store.finalize(row.pending_id, seen ? 'read' : 'ignored', now);
        scoreSender(feedback, row.from_addr, now);
      }
      // else: still inside the window, or no observation of this UID this tick
      // (gone from INBOX) → leave unresolved for a later tick. If it never
      // reappears it ages out of `findUnresolved` past the grace window and
      // simply yields no feedback signal — the safe default for unknown state.
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[emails] feedback resolution failed for ${account.id}:`, msg);
  }
}

// Cap on awaiting rows re-polled per tick for the `\Seen` sync (IMAP-cost
// guard). A huge backlog can't blow up one tick's flag fetch. The sync pages
// through the awaiting set across ticks via a per-account cursor (see
// syncSeenStatus) so a backlog larger than the cap is fully covered over
// successive ticks rather than re-checking only the oldest window forever.
const SEEN_SYNC_CAP = 50;

// Per-account `\Seen` sync: re-check IMAP flags for the awaiting (queue-visible,
// non-urgent-pinged, undelivered) emails and auto-dismiss (markDelivered) any
// the user has already handled in Gmail — read (`\Seen`) OR moved out of INBOX
// (absent from a SUCCESSFUL flag fetch → archived/deleted/moved). This makes
// R2's awaiting queue track what the user actually did, with zero manual input.
//
// Distinct from resolveAccountFeedback above: that pass is urgent-ping-only and
// records sender scoring; this one sweeps the awaiting (non-pinged) rows and
// only calls markDelivered. No feedback signal is recorded for these auto-cleared
// rows (out of scope by design — the feedback loop stays urgent-only).
//
// Best-effort, own try/catch so a flag-fetch failure is logged and never
// escalates into the account's setAccountError path.
async function syncSeenStatus(
  account: ImapAccount,
  params: TickParams,
): Promise<void> {
  const flagFetcher = params.flagFetcher;
  if (!flagFetcher) return;
  try {
    const cursors = params.seenSyncCursors;
    // Page through the awaiting backlog across ticks: start where the last tick
    // left off so rows beyond the first cap aren't starved. Without a cursor
    // (single-shot / tests) offset stays 0 → oldest cap, unchanged behaviour.
    let offset = cursors?.get(account.id) ?? 0;
    let rows = params.store.fetchAwaitingForAccount(account.id, SEEN_SYNC_CAP, offset);
    // The awaiting set shrinks as rows get dismissed/delivered, so a cursor from
    // an earlier (larger) backlog can land past the end. Wrap to the oldest this
    // same tick rather than wasting a tick on an empty page.
    if (rows.length === 0 && offset > 0) {
      offset = 0;
      rows = params.store.fetchAwaitingForAccount(account.id, SEEN_SYNC_CAP, 0);
    }
    if (rows.length === 0) {
      cursors?.set(account.id, 0);
      return;
    }

    const flags = await flagFetcher(account, rows.map((r) => r.message_uid));
    // `null` = a hard fetch failure (connection/timeout/server NO|BAD). It
    // carries no evidence about any UID, so a row absent here must NOT be read
    // as "left INBOX" and dismissed. Bail and change nothing this tick.
    if (flags === null) return;
    // A successful-but-empty `[]` means every UID has left INBOX — those rows
    // ARE handled (the `!has` branch below dismisses them). Only `null` bails.
    const flagByUid = new Map(flags.map((f) => [f.uid, f]));

    const handled: number[] = [];
    for (const row of rows) {
      const f = flagByUid.get(row.message_uid);
      // handled = read (`\Seen`) OR no longer in INBOX (absent from a
      // successful fetch). Gated on `flags !== null` above, so absence is real
      // evidence the message was archived/deleted/moved, not a failed fetch.
      if (f?.seen === true || !flagByUid.has(row.message_uid)) {
        handled.push(row.id);
      }
    }
    if (handled.length > 0) params.store.markDelivered(handled, params.now);

    // Advance the paging cursor. A full page (== cap) means more awaiting rows
    // may lie beyond it → page forward next tick; a short page means we reached
    // the end → wrap to the oldest. The rows we just dismissed leave the awaiting
    // set, so the rows after the window shift down by `handled.length`; subtract
    // it so we resume exactly where we left off instead of skipping that many.
    if (cursors) {
      const next =
        rows.length < SEEN_SYNC_CAP ? 0 : Math.max(0, offset + SEEN_SYNC_CAP - handled.length);
      cursors.set(account.id, next);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[emails] \\Seen sync failed for ${account.id}:`, msg);
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
            // Capture UIDVALIDITY together with the initial watermark. If we
            // deferred this to the next tick's backfill branch (as the original
            // design did), a mailbox recreation between this tick and the next
            // would pair the now-stale watermark with the new epoch's
            // UIDVALIDITY and the watcher would go silently blind. Recording the
            // baseline here means the next tick sees `stored !== current` and
            // self-heals instead.
            //
            // Probe UIDVALIDITY BEFORE maxUid (two separate IMAP connections, so
            // not truly atomic). A mailbox recreation landing between the two
            // probes can only pair an *old* validity with a *new* watermark —
            // next tick then sees `stored !== current` and self-heals via reset.
            // The reverse order (maxUid then validity) could pair a *stale* high
            // watermark with the *new* validity, which matches next tick and
            // blinds the watcher to all new-epoch mail below it — the exact trap
            // we're avoiding.
            const currentValidity = await params.validityProbe(acc);
            const maxUid = await params.maxUidProbe(acc);
            params.store.setLastSeenAndValidity(acc.id, maxUid, currentValidity, params.now);
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

        // UIDVALIDITY guard, BEFORE the fetch — IMAP UIDs are only stable while
        // the mailbox's UIDVALIDITY is unchanged. If the provider recreates the
        // mailbox, UIDs restart from low numbers and `uid:${last+1}:*` returns
        // nothing (new mail sits below the dead high-watermark) or only the
        // high tail of the new epoch (silently losing everything below). We
        // detect the change here and self-heal so we never act on a foreign
        // epoch's UID data.
        const storedValidity = params.store.getUidValidity(acc.id);
        const currentValidity = await params.validityProbe(acc);
        if (storedValidity == null) {
          // First time we learn the UIDVALIDITY (new account on its 2nd tick, or
          // an account older than this column): adopt it as the baseline WITHOUT
          // resetting the watermark — there's no reason to assume it changed.
          params.store.setLastSeenAndValidity(acc.id, sinceUid, currentValidity, params.now);
        } else if (currentValidity !== storedValidity) {
          // Mailbox recreated: `last_seen_uid` is a dead epoch's watermark. Reset
          // by the first-tick strategy — skip backlog (last_seen_uid = current
          // maxUid), persist the new validity — and alert once. Next tick runs
          // normally (stored == current).
          console.warn(
            `[emails] UIDVALIDITY changed for ${acc.id}: ${storedValidity} → ${currentValidity}; mailbox recreated, resetting last_seen_uid to current maxUid (skipping backlog).`,
          );
          const maxUid = await params.maxUidProbe(acc);
          // The dead epoch's UIDs are meaningless in the recreated mailbox, so
          // purge this account's pending rows (and their referencing feedback —
          // deletePendingForAccount emulates the missing ON DELETE CASCADE in one
          // transaction, FK-safe whether or not feedback resolution is wired).
          // Otherwise:
          //  - a recycled new-epoch UID could be silently dropped by
          //    insertPending's INSERT OR IGNORE on a stale (account_id,
          //    message_uid) row, losing a real new email; and
          //  - emails_get / draft-reply could fetch a *different* new-epoch
          //    message body by a stale pending UID; and
          //  - feedback `message_uid`s belong to the dead epoch too, so
          //    re-polling them against the new epoch could mis-finalize the
          //    wrong sender (resolved sender history for THIS account is lost —
          //    an acceptable, rare cost of a provider mailbox recreation).
          // Purge BEFORE advancing the watermark/validity: if the delete throws
          // (e.g. an unexpected FK/IO error), state stays on the dead epoch so
          // next tick still sees stored != current and retries the reset, rather
          // than advancing past it and stranding the dead-epoch rows forever.
          params.store.deletePendingForAccount(acc.id);
          params.store.setLastSeenAndValidity(acc.id, maxUid, currentValidity, params.now);
          params.onUidValidityReset?.({ account: acc.id, previous: storedValidity, current: currentValidity });
          return; // skip this tick's ingest; next tick proceeds normally
        }

        const msgs = await params.fetcher(acc, sinceUid, fetchLimit);
        if (msgs.length === 0) {
          // A connection that fetched (even with no new mail) is a successful
          // poll, so clear any error streak/blind latch here — the watermark
          // update paths (updateLastSeenUid / setLastSeenAndValidity) that
          // normally reset it are skipped on this no-new-mail branch, and a
          // recovered mailbox is most often quiet on its recovery tick.
          params.store.clearAccountError(acc.id, params.now);
          // Unresolved feedback rows may still need a flag re-poll (the user
          // could have opened/replied since the ping).
          await resolveAccountFeedback(acc, params.feedback, params.now);
          // Awaiting rows the user has since read/archived in Gmail should leave
          // the queue even on a quiet tick (no new mail ≠ nothing to sync).
          await syncSeenStatus(acc, params);
          return;
        }

        const scored = await params.scorer(msgs);
        const byUid = new Map(scored.map((s) => [s.uid, s.importance]));

        // Above-cutoff messages we're about to ingest. Scorer guarantees
        // coverage on success (see scorer.ts normalize); a missing uid signals a
        // contract break, not "low importance" — skip rather than default and
        // silently drop.
        const toIngest = msgs.filter((m) => (byUid.get(m.uid) ?? -1) >= cutoff);

        // Gist step (behind the flag): summarize only the above-cutoff batch so
        // no tokens are spent on below-cutoff mail. Best-effort — summarizeGists
        // never throws, but the extra try/catch guarantees a wiring/gister bug
        // can't break the (already-scored) importance ingest path below.
        let gistByUid = new Map<number, string>();
        if (params.gistEnabled && params.gister && toIngest.length > 0) {
          try {
            gistByUid = await params.gister(
              toIngest.map((m) => ({
                uid: m.uid,
                from: m.from,
                subject: m.subject,
                body: m.bodyExcerpt ?? m.snippet,
              })),
            );
          } catch (err) {
            const gmsg = err instanceof Error ? err.message : String(err);
            console.warn(`[emails] gist step failed for ${acc.id}, storing without gists:`, gmsg);
          }
        }

        for (const m of toIngest) {
          params.store.insertPending({
            account_id: acc.id,
            message_uid: m.uid,
            from_addr: m.from,
            subject: m.subject,
            snippet: m.snippet,
            importance: byUid.get(m.uid)!,
            received_at: m.receivedAt,
            added_at: params.now,
            gist: gistByUid.get(m.uid) ?? null,
          });
        }

        const maxUid = msgs.reduce((m, x) => Math.max(m, x.uid), 0);
        if (maxUid > 0) {
          params.store.updateLastSeenUid(acc.id, maxUid, params.now);
        }

        await resolveAccountFeedback(acc, params.feedback, params.now);
        await syncSeenStatus(acc, params);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[emails] poll failed for ${acc.id}:`, msg);
        params.store.setAccountError(acc.id, msg, params.now);
        // Blind-account alert: fire once the failure streak reaches the
        // threshold. The `blind_alerted` latch is what guarantees exactly one
        // alert per blind episode; `>=` (rather than `===`) makes the trigger
        // robust if the counter is already past the threshold on first check
        // (e.g. an operator lowers blindAlertAfter mid-outage and restarts).
        // The success paths reset both counters, so a recovered-then-re-blinded
        // account alerts again. Skipped when the alert isn't wired or disabled.
        const threshold = params.blindAlertAfter;
        if (params.onAccountBlind && threshold != null && threshold > 0) {
          const state = params.store.getAccountErrorState(acc.id);
          if (
            state &&
            state.consecutive_errors >= threshold &&
            state.blind_alerted === 0
          ) {
            // Dispatch first, latch only on success. `onAccountBlind` emits onto
            // an EventEmitter (reminderBus), where a synchronous listener failure
            // propagates back here. If we latched before dispatch, a throwing hook
            // would mark the account alerted while delivering nothing, and the
            // exception would escape this per-account catch into the tick crash
            // handler. Instead, swallow+log hook failures so one bad alert can't
            // sink the poll tick; an undelivered alert stays un-latched and retries
            // next tick (still blind → same branch fires again).
            try {
              params.onAccountBlind({
                account: acc.id,
                consecutive: state.consecutive_errors,
                // `msg` is the error just written by setAccountError above, so it
                // equals the persisted last_error — use it directly.
                lastError: msg,
              });
              params.store.markBlindAlerted(acc.id);
            } catch (alertErr) {
              console.error(
                `[emails] blind alert hook failed for ${acc.id}:`,
                alertErr instanceof Error ? alertErr.message : String(alertErr),
              );
            }
          }
        }
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

  // Persistent per-account paging cursor for the `\Seen` sync, living for the
  // life of the poller so successive ticks page through the whole awaiting
  // backlog instead of re-checking only the oldest cap every tick.
  const seenSyncCursors = new Map<string, number>();

  // Self-scheduling loop: the next tick is only queued once the current one
  // resolves. setInterval would fire concurrently when a tick runs longer
  // than intervalMs (slow IMAP / LLM), doubling cost and racing on state.
  const runOnce = async () => {
    if (stopped) return;
    try {
      await runPollTick({ ...params, now: Date.now(), seenSyncCursors });
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
