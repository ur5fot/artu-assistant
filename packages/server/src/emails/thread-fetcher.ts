import type { ImapAccount, NewMessage } from './types.js';
import * as defaultImapClient from './imap-client.js';

// Max messages returned from a thread walk. Most threads are < 10; the cap is
// defensive against pathological cases (mass-cc loops, mailing-list digests
// that splice References) so the LLM prompt and IMAP round-trips stay bounded.
const MAX_THREAD_SIZE = 20;

type ImapClientShape = {
  fetchHeaders: typeof defaultImapClient.fetchHeaders;
  fetchByMessageId: typeof defaultImapClient.fetchByMessageId;
};

let imapClient: ImapClientShape = defaultImapClient;

export function __setImapClientForThreadFetcher(c: ImapClientShape): void {
  imapClient = c;
}

export function __resetImapClientForThreadFetcher(): void {
  imapClient = defaultImapClient;
}

export async function fetchThread(account: ImapAccount, uid: number): Promise<NewMessage[]> {
  const headers = await imapClient.fetchHeaders(account, uid);

  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const ref of headers.references) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    orderedIds.push(ref);
  }
  if (headers.messageId && !seen.has(headers.messageId)) {
    seen.add(headers.messageId);
    orderedIds.push(headers.messageId);
  }

  const capped = orderedIds.length > MAX_THREAD_SIZE
    ? orderedIds.slice(orderedIds.length - MAX_THREAD_SIZE)
    : orderedIds;

  const out: NewMessage[] = [];
  for (const id of capped) {
    const msg = await imapClient.fetchByMessageId(account, id);
    if (msg) out.push(msg);
  }
  return out;
}
