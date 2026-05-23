import { ImapFlow } from 'imapflow';
import type { ImapAccount, NewMessage, FullMessage } from './types.js';
import { decodeHeader, decodeBodyPart, pickTextPart, type PickedPart } from './mime-decode.js';

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

// Decode the buffer of a picked text leaf. Returns '' when the message has
// no text part (image-only) or the part wasn't returned by the server.
function decodePickedText(buf: unknown, picked: PickedPart | null): string {
  if (!picked || buf == null) return '';
  return decodeBodyPart(buf, picked.encoding, picked.charset);
}

// Snippet is used for LLM scoring — a single line of collapsed whitespace is
// fine (keeps prompt compact, scorer doesn't care about formatting).
function toSnippet(text: string, limit: number): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

// Body is returned to the user via emails_get — preserve newlines so signatures
// and quoted replies stay readable. Normalize CRLF, drop NULs, and mark any
// hard truncation so the caller sees it was cut.
function toBody(text: string, limit: number): string {
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

// Used by the poller on first tick (when `last_seen_uid === 0`) to skip the
// historical backlog: the probe returns the current max UID, the poller
// persists it as `last_seen_uid`, and only mail arriving after that point
// is fetched on subsequent ticks. IMAP guarantees monotonically increasing
// UID assignment per mailbox, so anything that arrives between this call
// and the next tick is safely captured by `uid: ${max+1}:*`.
export async function getMaxUid(account: ImapAccount): Promise<number> {
  return withClient(account, async (client) => {
    const uids: number[] =
      (await client.search({ all: true }, { uid: true })) || [];
    if (!uids || uids.length === 0) return 0;
    return Math.max(...uids);
  });
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

    // Phase 1: metadata + bodyStructure only — no bodyParts. Eagerly
    // requesting body parts here would download whatever lives at part '2' /
    // '3' in multipart/mixed messages (commonly large PDF/video
    // attachments). For 50 messages × multi-MB attachments that easily
    // saturates the 60s socket timeout and starves the poller.
    const metaRows = await client.fetchAll(
      cap,
      { envelope: true, internalDate: true, bodyStructure: true },
      { uid: true },
    );

    const uidsOrdered: number[] = [];
    const metaByUid = new Map<number, any>();
    const pickedByUid = new Map<number, PickedPart | null>();
    const uidsByPartId = new Map<string, number[]>();
    for (const row of metaRows) {
      if (!row || typeof row.uid !== 'number' || row.uid <= sinceUid) continue;
      uidsOrdered.push(row.uid);
      metaByUid.set(row.uid, row);
      const picked = pickTextPart(row.bodyStructure);
      pickedByUid.set(row.uid, picked);
      if (picked) {
        const list = uidsByPartId.get(picked.partId) || [];
        list.push(row.uid);
        uidsByPartId.set(picked.partId, list);
      }
    }

    // Phase 2: fetch only the picked text leaves, grouped by partId so each
    // unique partId across the batch costs one round-trip. Common case (all
    // messages have body at '1') is a single follow-up fetch; nothing fires
    // for image-only / attachment-only messages where pickTextPart is null.
    const bufByUid = new Map<number, unknown>();
    for (const [partId, partUids] of uidsByPartId) {
      const bodyRows = await client.fetchAll(
        partUids,
        { bodyParts: [partId] },
        { uid: true },
      );
      for (const row of bodyRows) {
        if (!row || typeof row.uid !== 'number') continue;
        const buf = getBodyPart(row.bodyParts, partId);
        if (buf != null) bufByUid.set(row.uid, buf);
      }
    }

    const out: NewMessage[] = [];
    for (const uid of uidsOrdered) {
      const row = metaByUid.get(uid);
      const text = decodePickedText(bufByUid.get(uid), pickedByUid.get(uid) ?? null);
      out.push({
        uid,
        from: formatFrom(row.envelope),
        subject: decodeHeader(row.envelope?.subject),
        snippet: toSnippet(text, SNIPPET_LEN),
        receivedAt: pickReceivedAt(row),
      });
    }
    return out;
  });
}

export async function fetchFullBody(account: ImapAccount, uid: number): Promise<FullMessage> {
  return withClient(account, async (client) => {
    // Same two-phase shape as fetchNewMessages — see comments there. Avoids
    // downloading attachments at part '2'+ when the user just asked for the
    // body of a single message.
    const meta = await client.fetchOne(
      uid,
      { envelope: true, internalDate: true, bodyStructure: true },
      { uid: true },
    );
    if (!meta) throw new Error(`Message uid=${uid} not found in INBOX`);

    const picked = pickTextPart(meta.bodyStructure);
    let buf: unknown = undefined;
    if (picked) {
      const bodyRow = await client.fetchOne(
        uid,
        { bodyParts: [picked.partId] },
        { uid: true },
      );
      if (bodyRow) buf = getBodyPart(bodyRow.bodyParts, picked.partId);
    }

    const text = decodePickedText(buf, picked);
    return {
      uid,
      from: formatFrom(meta.envelope),
      subject: decodeHeader(meta.envelope?.subject),
      bodyText: toBody(text, FULL_BODY_LEN),
      receivedAt: pickReceivedAt(meta),
    };
  });
}
