import type Database from 'better-sqlite3';
import type { EmailPendingRow } from './types.js';

export interface EmailStore {
  getLastSeenUid(accountId: string): number;
  hasAccountState(accountId: string): boolean;
  updateLastSeenUid(accountId: string, uid: number, now: number): void;
  setAccountError(accountId: string, message: string, now: number): void;
  getAccountError(accountId: string): { message: string; at: number } | null;

  insertPending(row: Omit<EmailPendingRow, 'id' | 'delivered_at' | 'urgent_pinged_at'>): void;
  countPendingUndelivered(): number;
  fetchPendingUndelivered(limit: number): EmailPendingRow[];
  fetchInWindow(sinceHours: number, limit: number, now: number): EmailPendingRow[];
  markDelivered(ids: number[], now: number): void;
  findByPendingId(id: number): EmailPendingRow | null;
  findUnpingedUrgent(): EmailPendingRow | null;
  markUrgentPinged(id: number, now: number): void;
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
    hasAccountState(accountId) {
      const row = db
        .prepare('SELECT 1 FROM email_account_state WHERE account_id = ?')
        .get(accountId);
      return row !== undefined;
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
      // Exclude urgent-pinged rows: they were already surfaced to the user
      // via the urgent channel, so they shouldn't keep inflating the digest
      // threshold or get re-shown in the next batch.
      const row = db
        .prepare(
          'SELECT COUNT(*) AS c FROM email_pending WHERE delivered_at IS NULL AND urgent_pinged_at IS NULL',
        )
        .get() as { c: number };
      return row.c;
    },
    fetchPendingUndelivered(limit) {
      return db.prepare(`
        SELECT * FROM email_pending
        WHERE delivered_at IS NULL AND urgent_pinged_at IS NULL
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
    findUnpingedUrgent() {
      // Also exclude rows already delivered via the digest. Otherwise a
      // backlog importance=5 email that was first surfaced in the digest
      // would get re-surfaced as a separate urgent ping on the next tick.
      const row = db.prepare(`
        SELECT * FROM email_pending
        WHERE importance = 5 AND urgent_pinged_at IS NULL AND delivered_at IS NULL
        ORDER BY received_at ASC
        LIMIT 1
      `).get() as EmailPendingRow | undefined;
      return row ?? null;
    },
    // Silent no-op on missing id: the emailUrgent handler races with itself
    // across ticks (trigger sees row, run re-fetches, another tick already
    // marked it), and bumping an absent id is harmless. No throw.
    markUrgentPinged(id, now) {
      db.prepare('UPDATE email_pending SET urgent_pinged_at = ? WHERE id = ?').run(now, id);
    },
  };
}
