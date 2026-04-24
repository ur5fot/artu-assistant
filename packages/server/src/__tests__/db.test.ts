import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../db.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => closeDb());

describe('email tables', () => {
  it('creates email_account_state with expected columns', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('email_account_state')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(['account_id', 'last_error', 'last_poll_at', 'last_seen_uid'].sort());
  });

  it('creates email_pending with expected columns', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('email_pending')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'account_id', 'added_at', 'delivered_at', 'from_addr',
      'id', 'importance', 'message_uid', 'received_at', 'snippet', 'subject',
    ].sort());
  });

  it('enforces UNIQUE(account_id, message_uid) on email_pending', () => {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO email_pending
      (account_id, message_uid, from_addr, subject, snippet, importance, received_at, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run('acc1', 123, 'a@b.com', 's', 'snip', 4, 1000, 1000);
    expect(() => stmt.run('acc1', 123, 'a@b.com', 's', 'snip', 4, 1000, 1000)).toThrow();
  });
});
