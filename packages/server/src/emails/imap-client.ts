import { ImapFlow } from 'imapflow';
import type { ImapAccount, NewMessage, FullMessage } from './types.js';

type ImapFlowCtor = new (opts: any) => any;
let Ctor: ImapFlowCtor = ImapFlow as unknown as ImapFlowCtor;

export function __setImapFlowCtor(c: ImapFlowCtor): void {
  Ctor = c;
}

const CONNECT_TIMEOUT_MS = 10_000;
const SNIPPET_LEN = 500;

function formatFrom(envelope: any): string {
  const from = envelope?.from?.[0];
  if (!from) return 'unknown';
  if (from.name && from.address) return `${from.name} <${from.address}>`;
  return from.address || from.name || 'unknown';
}

function extractSnippet(bodyParts: any, limit: number): string {
  if (!bodyParts) return '';
  const iter: Iterable<unknown> =
    typeof bodyParts.values === 'function' ? bodyParts.values() : Object.values(bodyParts);
  for (const value of iter) {
    const text = Buffer.isBuffer(value) ? value.toString('utf-8') : String(value);
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.slice(0, limit);
  }
  return '';
}

async function withClient<T>(account: ImapAccount, fn: (client: any) => Promise<T>): Promise<T> {
  const client = new Ctor({
    host: account.host,
    port: account.port,
    secure: account.tls,
    auth: { user: account.user, pass: account.password },
    logger: false,
    socketTimeout: CONNECT_TIMEOUT_MS,
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
    const uids: number[] = (await client.search({ uid: `${sinceUid + 1}:*` })) || [];
    if (!uids || uids.length === 0) return [];
    const cap = uids.slice(-limit);
    const rows = await client.fetchAll(cap, {
      envelope: true,
      internalDate: true,
      bodyParts: ['1'],
    });
    const out: NewMessage[] = [];
    for (const row of rows) {
      if (!row || typeof row.uid !== 'number') continue;
      if (row.uid <= sinceUid) continue;
      out.push({
        uid: row.uid,
        from: formatFrom(row.envelope),
        subject: row.envelope?.subject ?? '',
        snippet: extractSnippet(row.bodyParts, SNIPPET_LEN),
        receivedAt: row.internalDate instanceof Date ? row.internalDate.getTime() : 0,
      });
    }
    return out;
  });
}

export async function fetchFullBody(account: ImapAccount, uid: number): Promise<FullMessage> {
  return withClient(account, async (client) => {
    const row = await client.fetchOne(uid, {
      envelope: true,
      internalDate: true,
      bodyParts: ['1'],
    });
    if (!row) throw new Error(`Message uid=${uid} not found in INBOX`);
    return {
      uid,
      from: formatFrom(row.envelope),
      subject: row.envelope?.subject ?? '',
      bodyText: extractSnippet(row.bodyParts, 50_000),
      receivedAt: row.internalDate instanceof Date ? row.internalDate.getTime() : 0,
    };
  });
}
