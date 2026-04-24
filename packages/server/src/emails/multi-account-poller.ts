import type { ImapAccount, NewMessage } from './types.js';
import type { EmailStore } from './store.js';

export type MessageFetcher = (account: ImapAccount, sinceUid: number, limit: number) => Promise<NewMessage[]>;
export type MessageScorer = (msgs: NewMessage[]) => Promise<Array<{ uid: number; importance: number }>>;

interface TickParams {
  accounts: ImapAccount[];
  store: EmailStore;
  fetcher: MessageFetcher;
  scorer: MessageScorer;
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
        const msgs = await params.fetcher(acc, sinceUid, fetchLimit);
        if (msgs.length === 0) return;

        const scored = await params.scorer(msgs);
        const byUid = new Map(scored.map((s) => [s.uid, s.importance]));

        for (const m of msgs) {
          const importance = byUid.get(m.uid) ?? 3;
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
  const tick = async () => {
    if (stopped) return;
    try {
      await runPollTick({ ...params, now: Date.now() });
    } catch (err) {
      console.error('[emails] poll tick crashed:', err instanceof Error ? err.message : err);
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), params.intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
