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

/**
 * Returns the highest UID currently in the account's INBOX, or `0` if empty.
 *
 * Used by `multi-account-poller.runPollTick` on first tick (no row in
 * `email_account_state` yet) to skip the historical backlog: the poller
 * persists this value as `last_seen_uid` and processes zero rows that tick,
 * so only mail arriving after the account is configured is fetched on
 * subsequent ticks. IMAP guarantees monotonically increasing UID assignment
 * per mailbox, so anything that arrives between this call and the next tick
 * is safely captured by `uid: ${max+1}:*` in `fetchNewMessages`.
 *
 * Throws if the SEARCH command itself fails (imapflow returns `false` on
 * server NO/BAD). Returning 0 in that case would let the poller persist
 * last_seen_uid=0 as if the inbox were empty, and the next tick's ongoing
 * path would crawl `UID 1:*` — the exact backlog this probe exists to skip.
 */
export async function getMaxUid(account: ImapAccount): Promise<number> {
  return withClient(account, async (client) => {
    const result = await client.search({ all: true }, { uid: true });
    if (result === false) {
      throw new Error('IMAP SEARCH ALL failed (server returned NO/BAD)');
    }
    const uids: number[] = result || [];
    // reduce instead of Math.max(...uids): on a real backlog (the plan cites
    // a 9416-message inbox) the spread can approach V8's argument-count limit.
    return uids.reduce((m, x) => (x > m ? x : m), 0);
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

// imapflow returns message flags as a Set of strings (e.g. '\\Seen'), but a
// stubbed client or a future lib version may hand back an array — accept both.
function flagHas(flags: unknown, flag: string): boolean {
  if (!flags) return false;
  if (flags instanceof Set) return flags.has(flag);
  if (Array.isArray(flags)) return flags.includes(flag);
  if (typeof (flags as { has?: unknown }).has === 'function') {
    return (flags as { has: (f: string) => boolean }).has(flag);
  }
  return false;
}

// Re-poll only flags for an explicit list of already-known UIDs. Used by the
// implicit-feedback resolver to learn whether the user opened (`\Seen`) or
// replied to (`\Answered`) an email we pinged about. Unlike the other fetchers
// this NEVER throws into the caller: a flag re-poll is best-effort telemetry,
// so a dead connection or server NO/BAD must not crash the poll tick — we log
// and return whatever we gathered (empty on a hard failure). Large UID lists
// are chunked so one FETCH command can't blow past the socket timeout.
const FLAG_FETCH_CHUNK = 200;

export async function fetchFlagsForUids(
  account: ImapAccount,
  uids: number[],
  opts?: { chunkSize?: number },
): Promise<Array<{ uid: number; seen: boolean; answered: boolean }>> {
  if (!uids || uids.length === 0) return [];
  const chunkSize = opts?.chunkSize && opts.chunkSize > 0 ? opts.chunkSize : FLAG_FETCH_CHUNK;
  try {
    return await withClient(account, async (client) => {
      const out: Array<{ uid: number; seen: boolean; answered: boolean }> = [];
      for (let i = 0; i < uids.length; i += chunkSize) {
        const chunk = uids.slice(i, i + chunkSize);
        const rows = await client.fetchAll(chunk, { flags: true }, { uid: true });
        for (const row of rows || []) {
          if (!row || typeof row.uid !== 'number') continue;
          out.push({
            uid: row.uid,
            seen: flagHas(row.flags, '\\Seen'),
            answered: flagHas(row.flags, '\\Answered'),
          });
        }
      }
      return out;
    });
  } catch (err) {
    console.error(
      `[emails] fetchFlagsForUids failed for ${account.id}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

export interface MessageHeaders {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
}

// Header values may be folded across lines per RFC 5322 §2.2.3 (continuation
// lines begin with WSP). Unfold by collapsing each CRLF+WSP into a single space
// before splitting into individual headers.
function unfoldHeaders(raw: string): string {
  return raw.replace(/\r?\n[ \t]+/g, ' ');
}

function parseHeaderValue(unfolded: string, name: string): string | null {
  const pattern = new RegExp(`^${name}\\s*:\\s*(.*)$`, 'im');
  const m = unfolded.match(pattern);
  if (!m) return null;
  const v = m[1].trim();
  return v.length > 0 ? v : null;
}

function parseReferences(unfolded: string): string[] {
  const v = parseHeaderValue(unfolded, 'References');
  if (!v) return [];
  // References is a space-separated list of msg-ids: <a@h> <b@h> <c@h>
  const ids = v.match(/<[^>]+>/g) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export async function fetchHeaders(account: ImapAccount, uid: number): Promise<MessageHeaders> {
  return withClient(account, async (client) => {
    const row = await client.fetchOne(
      uid,
      { headers: ['Message-ID', 'In-Reply-To', 'References'] },
      { uid: true },
    );
    if (!row || !row.headers) {
      return { messageId: null, inReplyTo: null, references: [] };
    }
    const raw = Buffer.isBuffer(row.headers)
      ? row.headers.toString('utf-8')
      : String(row.headers);
    const unfolded = unfoldHeaders(raw);
    return {
      messageId: parseHeaderValue(unfolded, 'Message-ID'),
      inReplyTo: parseHeaderValue(unfolded, 'In-Reply-To'),
      references: parseReferences(unfolded),
    };
  });
}

// Search INBOX for a message by RFC 5322 Message-ID. Returns a FullMessage so
// the draft-reply prompt can include real body text (not a 500-char snippet —
// the plan calls for "full thread context for higher draft quality"). Null
// when the id isn't found (ref points to Sent or another folder we don't index)
// or when the server's SEARCH returns NO/BAD — treat both as "not in INBOX",
// the caller silently skips.
export async function fetchByMessageId(
  account: ImapAccount,
  messageId: string,
): Promise<FullMessage | null> {
  return withClient(account, async (client) => {
    const result = await client.search({ header: { 'Message-ID': messageId } }, { uid: true });
    if (!result || result === false || result.length === 0) return null;
    const uid = result[0];
    const metaRows = await client.fetchAll(
      [uid],
      { envelope: true, internalDate: true, bodyStructure: true },
      { uid: true },
    );
    const meta = metaRows[0];
    if (!meta) return null;
    const picked = pickTextPart(meta.bodyStructure);
    let buf: unknown = undefined;
    if (picked) {
      const bodyRows = await client.fetchAll(
        [uid],
        { bodyParts: [picked.partId] },
        { uid: true },
      );
      const bodyRow = bodyRows[0];
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
