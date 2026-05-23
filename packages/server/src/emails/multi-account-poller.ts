import type { ImapAccount, NewMessage } from './types.js';
import type { EmailStore } from './store.js';

export type MessageFetcher = (account: ImapAccount, sinceUid: number, limit: number) => Promise<NewMessage[]>;
export type MessageScorer = (msgs: NewMessage[]) => Promise<Array<{ uid: number; importance: number }>>;
export type MaxUidProbe = (account: ImapAccount) => Promise<number>;

interface TickParams {
  accounts: ImapAccount[];
  store: EmailStore;
  fetcher: MessageFetcher;
  scorer: MessageScorer;
  maxUidProbe: MaxUidProbe;
  now: number;
  fetchLimit?: number;
  importanceCutoff?: number;
}

const DEFAULT_FETCH_LIMIT = 50;
const DEFAULT_CUTOFF = 4;

export async function runPollTick(params: TickParams): Promise<void> {
  const fetchLimit = params.fetchLimit ?? DEFAULT_FETCH_LIMIT;
  const cutoff = params.importanceCutoff ?? DEFAULT_CUTOFF;

  await Promise.all(
    params.accounts.map(async (acc) => {
      try {
        const sinceUid = params.store.getLastSeenUid(acc.id);

        // First tick for a fresh account: skip the historical backlog by
        // probing the inbox's current max UID and persisting it. Fetching
        // from UID 1 would crawl years of mail at 50/tick, blocking real
        // new arrivals (which sit at higher UIDs) for hours.
        if (sinceUid === 0) {
          const maxUid = await params.maxUidProbe(acc);
          params.store.updateLastSeenUid(acc.id, maxUid, params.now);
          console.log(
            `[emails] first tick for ${acc.id}: skipping backlog, last_seen_uid set to ${maxUid}`,
          );
          return;
        }

        const msgs = await params.fetcher(acc, sinceUid, fetchLimit);
        if (msgs.length === 0) return;

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
