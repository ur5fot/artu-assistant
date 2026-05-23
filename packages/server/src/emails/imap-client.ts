import { ImapFlow } from 'imapflow';
import type { ImapAccount, NewMessage, FullMessage } from './types.js';
import { decodeHeader, decodeBodyPart, pickTextPart } from './mime-decode.js';

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
  const name = decodeHeader(from.name);
  if (name && from.address) return `${name} <${from.address}>`;
  return from.address || name || 'unknown';
}

function getBodyPart(bodyParts: any, partId: string): unknown {
  if (!bodyParts) return undefined;
  if (typeof bodyParts.get === 'function') return bodyParts.get(partId);
  if (typeof bodyParts === 'object') return (bodyParts as Record<string, unknown>)[partId];
  return undefined;
}

// When IMAP bodyStructure is available, dispatch by the reported encoding/charset
// of the picked text leaf (prefers text/plain over text/html). For image-only
// messages pickTextPart returns null and the snippet/body becomes empty —
// surfacing raw base64 of a JPEG to the LLM scorer is worse than empty.
//
// Legacy fallback (no bodyStructure on the row): decode part '1' with QP/utf-8
// defaults so existing tests and any code path that hasn't been wired to request
// bodyStructure keeps working.
function firstBodyPart(row: any): string {
  const bodyParts = row?.bodyParts;
  if (!bodyParts) return '';
  if (row?.bodyStructure) {
    const picked = pickTextPart(row.bodyStructure);
    if (!picked) return '';
    const buf = getBodyPart(bodyParts, picked.partId);
    if (buf == null) return '';
    return decodeBodyPart(buf, picked.encoding, picked.charset);
  }
  const buf = getBodyPart(bodyParts, '1');
  if (buf != null) return decodeBodyPart(buf, 'quoted-printable', 'utf-8');
  const values =
    typeof bodyParts.values === 'function'
      ? Array.from(bodyParts.values() as Iterable<unknown>)
      : Object.values(bodyParts);
  if (values.length === 0) return '';
  return decodeBodyPart(values[0], 'quoted-printable', 'utf-8');
}

// Snippet is used for LLM scoring — a single line of collapsed whitespace is
// fine (keeps prompt compact, scorer doesn't care about formatting).
function extractSnippet(row: any, limit: number): string {
  const text = firstBodyPart(row);
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

// Body is returned to the user via emails_get — preserve newlines so signatures
// and quoted replies stay readable. Normalize CRLF, drop NULs, and mark any
// hard truncation so the caller sees it was cut.
function extractBody(row: any, limit: number): string {
  const text = firstBodyPart(row);
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
    // bodyStructure rides on the same fetchAll — no extra round-trip. Request
    // the common text partIds upfront ('1' single-part, '1.1' nested-in-related,
    // '2' second leg of multipart/alternative) so the decoder always has the
    // buffer for whichever leaf pickTextPart selects. Costs a little bandwidth
    // on multipart messages, saves a per-message follow-up fetch.
    const rows = await client.fetchAll(
      cap,
      {
        envelope: true,
        internalDate: true,
        bodyStructure: true,
        bodyParts: ['1', '1.1', '2'],
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
        subject: decodeHeader(row.envelope?.subject),
        snippet: extractSnippet(row, SNIPPET_LEN),
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
      subject: decodeHeader(row.envelope?.subject),
      bodyText: extractBody(row, FULL_BODY_LEN),
      receivedAt: pickReceivedAt(row),
    };
  });
}
