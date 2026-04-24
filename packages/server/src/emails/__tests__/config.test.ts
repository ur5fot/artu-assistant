import { describe, it, expect } from 'vitest';
import { parseImapAccounts } from '../config.js';

describe('parseImapAccounts', () => {
  it('returns empty array for empty/missing env', () => {
    expect(parseImapAccounts(undefined)).toEqual([]);
    expect(parseImapAccounts('')).toEqual([]);
    expect(parseImapAccounts('[]')).toEqual([]);
  });

  it('parses valid JSON array into typed accounts', () => {
    const raw = JSON.stringify([
      { id: 'gmail-main', host: 'imap.gmail.com', port: 993, user: 'a@gmail.com', password: 'p1', tls: true },
      { id: 'icloud', host: 'imap.mail.me.com', port: 993, user: 'a@icloud.com', password: 'p2', tls: true },
    ]);
    const accounts = parseImapAccounts(raw);
    expect(accounts).toHaveLength(2);
    expect(accounts[0].id).toBe('gmail-main');
    expect(accounts[1].host).toBe('imap.mail.me.com');
  });

  it('throws on duplicate id', () => {
    const raw = JSON.stringify([
      { id: 'x', host: 'h', port: 993, user: 'u', password: 'p', tls: true },
      { id: 'x', host: 'h2', port: 993, user: 'u2', password: 'p2', tls: true },
    ]);
    expect(() => parseImapAccounts(raw)).toThrow(/duplicate/);
  });

  it('throws on missing required field', () => {
    const raw = JSON.stringify([{ id: 'x', host: 'h', port: 993, user: 'u', tls: true }]);
    expect(() => parseImapAccounts(raw)).toThrow(/password/);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseImapAccounts('{bad json')).toThrow();
  });
});
