import type { ImapAccount, FullMessage } from './types.js';
import * as defaultImapClient from './imap-client.js';

// Max messages returned from a thread walk. Most threads are < 10; the cap is
// defensive against pathological cases (mass-cc loops, mailing-list digests
// that splice References) so the LLM prompt and IMAP round-trips stay bounded.
const MAX_THREAD_SIZE = 20;

type ImapClientShape = {
  fetchHeaders: typeof defaultImapClient.fetchHeaders;
  fetchByMessageId: typeof defaultImapClient.fetchByMessageId;
  fetchFullBody: typeof defaultImapClient.fetchFullBody;
};

let imapClient: ImapClientShape = defaultImapClient;

export function __setImapClientForThreadFetcher(c: ImapClientShape): void {
  imapClient = c;
}

export function __resetImapClientForThreadFetcher(): void {
  imapClient = defaultImapClient;
}

export async function fetchThread(account: ImapAccount, uid: number): Promise<FullMessage[]> {
  const headers = await imapClient.fetchHeaders(account, uid);

  // Build ancestor list from References; explicitly skip the current message's
  // own Message-ID so we never re-search for it. Current message is always
  // appended last via fetchFullBody — robust to null Message-ID (header missing)
  // and to the message having been moved between scoring and the user click.
  const ancestorIds: string[] = [];
  const seen = new Set<string>();
  if (headers.messageId) seen.add(headers.messageId);
  for (const ref of headers.references) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    ancestorIds.push(ref);
  }

  // Reserve a slot for the current message: cap ancestors at MAX-1 so the
  // current is always present even on pathological 30-deep threads.
  const capped = ancestorIds.length > MAX_THREAD_SIZE - 1
    ? ancestorIds.slice(ancestorIds.length - (MAX_THREAD_SIZE - 1))
    : ancestorIds;

  const out: FullMessage[] = [];
  for (const id of capped) {
    const msg = await imapClient.fetchByMessageId(account, id);
    if (msg) out.push(msg);
  }

  // Always append the current message by UID. Don't fail the whole thread if
  // fetchFullBody throws — ancestors plus a logged warning is better than
  // bubbling the error and leaving the user with no draft at all.
  try {
    const current = await imapClient.fetchFullBody(account, uid);
    out.push(current);
  } catch (err) {
    console.warn(
      '[emails.thread-fetcher] failed to fetch current message body:',
      err instanceof Error ? err.message : err,
    );
  }

  return out;
}
