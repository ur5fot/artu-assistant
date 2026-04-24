import type { ImapAccount } from './types.js';

const REQUIRED: Array<keyof ImapAccount> = ['id', 'host', 'port', 'user', 'password', 'tls'];

export function parseImapAccounts(raw: string | undefined): ImapAccount[] {
  if (!raw || raw.trim() === '' || raw.trim() === '[]') return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('IMAP_ACCOUNTS must be a JSON array');
  }
  const seen = new Set<string>();
  const out: ImapAccount[] = [];
  for (const item of parsed) {
    for (const key of REQUIRED) {
      if (item[key] === undefined || item[key] === null) {
        throw new Error(`IMAP account missing required field "${key}"`);
      }
    }
    if (seen.has(item.id)) {
      throw new Error(`IMAP accounts contain duplicate id "${item.id}"`);
    }
    seen.add(item.id);
    // Strict typing for tls/port: Boolean("false") === true silently enables TLS
    // and Boolean(0) === false silently disables it — neither is intended.
    // Likewise Number("abc") === NaN would surface as an opaque connect failure.
    if (typeof item.tls !== 'boolean') {
      throw new Error(`IMAP account "${item.id}" field "tls" must be a JSON boolean`);
    }
    const port = Number(item.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`IMAP account "${item.id}" field "port" must be a positive integer (1-65535)`);
    }
    out.push({
      id: String(item.id),
      host: String(item.host),
      port,
      user: String(item.user),
      password: String(item.password),
      tls: item.tls,
    });
  }
  return out;
}
