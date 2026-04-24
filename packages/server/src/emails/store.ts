import type Database from 'better-sqlite3';
import type { EmailPendingRow } from './types.js';

export interface EmailStore {
  getLastSeenUid(accountId: string): number;
  updateLastSeenUid(accountId: string, uid: number, now: number): void;
  setAccountError(accountId: string, message: string, now: number): void;
  getAccountError(accountId: string): { message: string; at: number } | null;

  insertPending(row: Omit<EmailPendingRow, 'id' | 'delivered_at'>): void;
  countPendingUndelivered(): number;
  fetchPendingUndelivered(limit: number): EmailPendingRow[];
  fetchInWindow(sinceHours: number, limit: number, now: number): EmailPendingRow[];
  markDelivered(ids: number[], now: number): void;
  findByPendingId(id: number): EmailPendingRow | null;
}

export function createEmailStore(deps: { db: Database.Database }): EmailStore {
  const { db } = deps;
  return {
    getLastSeenUid(accountId) {
      const row = db
        .prepare('SELECT last_seen_uid FROM email_account_state WHERE account_id = ?')
        .get(accountId) as { last_seen_uid: number } | undefined;
      return row?.last_seen_uid ?? 0;
    },
    updateLastSeenUid(accountId, uid, now) {
      db.prepare(`
        INSERT INTO email_account_state (account_id, last_seen_uid, last_poll_at)
        VALUES (?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          last_seen_uid = excluded.last_seen_uid,
          last_poll_at = excluded.last_poll_at,
          last_error = NULL
      `).run(accountId, uid, now);
    },
    setAccountError(accountId, message, now) {
      db.prepare(`
        INSERT INTO email_account_state (account_id, last_seen_uid, last_poll_at, last_error)
        VALUES (?, 0, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          last_poll_at = excluded.last_poll_at,
          last_error = excluded.last_error
      `).run(accountId, now, message);
    },
    getAccountError(accountId) {
      const row = db
        .prepare('SELECT last_error, last_poll_at FROM email_account_state WHERE account_id = ?')
        .get(accountId) as { last_error: string | null; last_poll_at: number | null } | undefined;
      if (!row || !row.last_error) return null;
      return { message: row.last_error, at: row.last_poll_at ?? 0 };
    },
    insertPending(row) {
      db.prepare(`
        INSERT OR IGNORE INTO email_pending
        (account_id, message_uid, from_addr, subject, snippet, importance, received_at, added_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.account_id, row.message_uid, row.from_addr, row.subject,
        row.snippet, row.importance, row.received_at, row.added_at,
      );
    },
    countPendingUndelivered() {
      const row = db
        .prepare('SELECT COUNT(*) AS c FROM email_pending WHERE delivered_at IS NULL')
        .get() as { c: number };
      return row.c;
    },
    fetchPendingUndelivered(limit) {
      return db.prepare(`
        SELECT * FROM email_pending
        WHERE delivered_at IS NULL
        ORDER BY importance DESC, received_at DESC
        LIMIT ?
      `).all(limit) as EmailPendingRow[];
    },
    fetchInWindow(sinceHours, limit, now) {
      const cutoff = now - sinceHours * 3600_000;
      return db.prepare(`
        SELECT * FROM email_pending
        WHERE received_at >= ?
        ORDER BY importance DESC, received_at DESC
        LIMIT ?
      `).all(cutoff, limit) as EmailPendingRow[];
    },
    markDelivered(ids, now) {
      if (ids.length === 0) return;
      const stmt = db.prepare('UPDATE email_pending SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL');
      const txn = db.transaction((all: number[]) => {
        for (const id of all) stmt.run(now, id);
      });
      txn(ids);
    },
    findByPendingId(id) {
      const row = db.prepare('SELECT * FROM email_pending WHERE id = ?').get(id) as EmailPendingRow | undefined;
      return row ?? null;
    },
  };
}
