import { ImapFlow } from 'imapflow';
import type { ImapAccount, NewMessage, FullMessage } from './types.js';

type ImapFlowCtor = new (opts: any) => any;
let Ctor: ImapFlowCtor = ImapFlow as unknown as ImapFlowCtor;

export function __setImapFlowCtor(c: ImapFlowCtor): void {
  Ctor = c;
}

// imapflow's `socketTimeout` is a per-operation idle timeout, not just a connect
// deadline. A SEARCH over a large INBOX plus a FETCH of up to 50 messages can
// stall for tens of seconds on slow links; 10s would force setAccountError on
// every tick and the account would never advance last_seen_uid.
const SOCKET_TIMEOUT_MS = 60_000;
const SNIPPET_LEN = 500;
const FULL_BODY_LEN = 50_000;
const TRUNCATION_MARKER = '\n…[truncated]';

// Falling back to 0 when internalDate/envelope.date are missing would push the
// row outside `fetchInWindow` (WHERE received_at >= now - H*3600000) forever —
// the user would never see it in `emails_list` even though it was scored and
// stored. Use "now" as a last resort so the row is at least discoverable.
function pickReceivedAt(row: any): number {
  if (row?.internalDate instanceof Date) return row.internalDate.getTime();
  if (row?.envelope?.date instanceof Date) return row.envelope.date.getTime();
  return Date.now();
}

function formatFrom(envelope: any): string {
  const from = envelope?.from?.[0];
  if (!from) return 'unknown';
  if (from.name && from.address) return `${from.name} <${from.address}>`;
  return from.address || from.name || 'unknown';
}

function firstBodyPart(bodyParts: any): string {
  if (!bodyParts) return '';
  const values =
    typeof bodyParts.values === 'function'
      ? Array.from(bodyParts.values() as Iterable<unknown>)
      : Object.values(bodyParts);
  if (values.length === 0) return '';
  const value = values[0];
  if (value == null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  if (typeof value === 'string') return value;
  return '';
}

// Snippet is used for LLM scoring — a single line of collapsed whitespace is
// fine (keeps prompt compact, scorer doesn't care about formatting).
function extractSnippet(bodyParts: any, limit: number): string {
  const text = firstBodyPart(bodyParts);
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

// Body is returned to the user via emails_get — preserve newlines so signatures
// and quoted replies stay readable. Normalize CRLF, drop NULs, and mark any
// hard truncation so the caller sees it was cut.
function extractBody(bodyParts: any, limit: number): string {
  const text = firstBodyPart(bodyParts);
  if (!text) return '';
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\0/g, '').trim();
  if (normalized.length <= limit) return normalized;
  return normalized.slice(0, limit - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

async function withClient<T>(account: ImapAccount, fn: (client: any) => Promise<T>): Promise<T> {
  const client = new Ctor({
    host: account.host,
    port: account.port,
    secure: account.tls,
    auth: { user: account.user, pass: account.password },
    logger: false,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    return await fn(client);
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}

export async function fetchNewMessages(
  account: ImapAccount,
  sinceUid: number,
  limit: number,
): Promise<NewMessage[]> {
  return withClient(account, async (client) => {
    const uids: number[] =
      (await client.search({ uid: `${sinceUid + 1}:*` }, { uid: true })) || [];
    if (!uids || uids.length === 0) return [];
    // Oldest-first slice. IMAP SEARCH returns UIDs ascending; taking the head
    // guarantees contiguous progress: maxUid of the fetched batch stays flush
    // with the last processed UID. slice(-limit) would drop older items past
    // the cap, and the poller's maxUid advancement would then silently skip
    // them forever on the next tick (first-boot + big-backlog data loss).
    const cap = uids.slice(0, limit);
    const rows = await client.fetchAll(
      cap,
      {
        envelope: true,
        internalDate: true,
        bodyParts: ['1'],
      },
      { uid: true },
    );
    const out: NewMessage[] = [];
    for (const row of rows) {
      if (!row || typeof row.uid !== 'number') continue;
      if (row.uid <= sinceUid) continue;
      out.push({
        uid: row.uid,
        from: formatFrom(row.envelope),
        subject: row.envelope?.subject ?? '',
        snippet: extractSnippet(row.bodyParts, SNIPPET_LEN),
        receivedAt: pickReceivedAt(row),
      });
    }
    return out;
  });
}

export async function fetchFullBody(account: ImapAccount, uid: number): Promise<FullMessage> {
  return withClient(account, async (client) => {
    const row = await client.fetchOne(
      uid,
      {
        envelope: true,
        internalDate: true,
        bodyParts: ['1'],
      },
      { uid: true },
    );
    if (!row) throw new Error(`Message uid=${uid} not found in INBOX`);
    return {
      uid,
      from: formatFrom(row.envelope),
      subject: row.envelope?.subject ?? '',
      bodyText: extractBody(row.bodyParts, FULL_BODY_LEN),
      receivedAt: pickReceivedAt(row),
    };
  });
}
