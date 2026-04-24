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
    out.push({
      id: String(item.id),
      host: String(item.host),
      port: Number(item.port),
      user: String(item.user),
      password: String(item.password),
      tls: Boolean(item.tls),
    });
  }
  return out;
}
