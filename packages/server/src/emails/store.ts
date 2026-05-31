import type Database from 'better-sqlite3';
import type { EmailPendingRow } from './types.js';
import { parseFromAddress } from './address.js';

export interface EmailStore {
  getLastSeenUid(accountId: string): number;
  hasAccountState(accountId: string): boolean;
  updateLastSeenUid(accountId: string, uid: number, now: number): void;
  /** Stored mailbox UIDVALIDITY for this account, or null when no row exists
   *  or the baseline has not been recorded yet (`uid_validity IS NULL`). */
  getUidValidity(accountId: string): number | null;
  /** Upsert `last_seen_uid` + `uid_validity` together (and clear `last_error`),
   *  mirroring `updateLastSeenUid`. Used to persist the watermark and the
   *  mailbox UIDVALIDITY in one write on backfill and on reset. */
  setLastSeenAndValidity(accountId: string, uid: number, uidValidity: number, now: number): void;
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
  /** Most recent row whose urgent path actually published (positive
   *  `urgent_pinged_at`). Suppressed rows (sentinel `-1`) and never-pinged
   *  rows (NULL) are excluded — `/why` with no arg targets only real pings. */
  findMostRecentUrgent(): EmailPendingRow | null;
  /** Count of distinct `email_pending` rows for this sender since `sinceMs`.
   *  Used by `/why` to surface frequency from the same sender. */
  countPendingFromSender(sender: string, sinceMs: number): number;
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
    getUidValidity(accountId) {
      const row = db
        .prepare('SELECT uid_validity FROM email_account_state WHERE account_id = ?')
        .get(accountId) as { uid_validity: number | null } | undefined;
      return row?.uid_validity ?? null;
    },
    setLastSeenAndValidity(accountId, uid, uidValidity, now) {
      db.prepare(`
        INSERT INTO email_account_state (account_id, last_seen_uid, uid_validity, last_poll_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          last_seen_uid = excluded.last_seen_uid,
          uid_validity = excluded.uid_validity,
          last_poll_at = excluded.last_poll_at,
          last_error = NULL
      `).run(accountId, uid, uidValidity, now);
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
      // Exclude rows that already reached the user via an urgent ping
      // (positive epoch ms). Suppressed-by-rule rows carry the sentinel `-1`
      // (see SUPPRESSED_PING_SENTINEL) — those were NOT shown to the user, so
      // they still belong in the digest as the only remaining surface.
      const row = db
        .prepare(
          `SELECT COUNT(*) AS c FROM email_pending
           WHERE delivered_at IS NULL
             AND (urgent_pinged_at IS NULL OR urgent_pinged_at < 0)`,
        )
        .get() as { c: number };
      return row.c;
    },
    fetchPendingUndelivered(limit) {
      // Same NULL-or-sentinel rule as countPendingUndelivered: suppressed rows
      // are still candidates for the digest even though they skipped urgent.
      return db.prepare(`
        SELECT * FROM email_pending
        WHERE delivered_at IS NULL
          AND (urgent_pinged_at IS NULL OR urgent_pinged_at < 0)
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
    //
    // `now` is normally a positive epoch ms, but the urgent handler also passes
    // the sentinel -1 to mark a row as "suppressed by an active rule before any
    // ping went out" (see SUPPRESSED_PING_SENTINEL in emailUrgent.ts). Both
    // shapes are stored verbatim — the column type is INTEGER and downstream
    // queries (`findUnpingedUrgent`, `/why`) interpret the value.
    markUrgentPinged(id, now) {
      db.prepare('UPDATE email_pending SET urgent_pinged_at = ? WHERE id = ?').run(now, id);
    },
    findMostRecentUrgent() {
      // Filter on `> 0` (not `IS NOT NULL`) so the suppression sentinel `-1`
      // doesn't get surfaced as a real urgent ping by `/why` without args.
      const row = db
        .prepare(
          `SELECT * FROM email_pending
           WHERE urgent_pinged_at IS NOT NULL AND urgent_pinged_at > 0
           ORDER BY urgent_pinged_at DESC
           LIMIT 1`,
        )
        .get() as EmailPendingRow | undefined;
      return row ?? null;
    },
    countPendingFromSender(sender, sinceMs) {
      // Match on the canonical bare address: rows are stored verbatim — either
      // `addr@host` or `"Display Name" <addr@host>` depending on the sender's
      // mail client. We fetch the window in SQL, then canonicalize each stored
      // `from_addr` with parseFromAddress in JS so two display-name variants
      // ("John D" vs "John Doe") still collapse to one count.
      //
      // Why not `LIKE '%<bare>%'` in SQL: (a) `_` and `%` in addresses (e.g.
      // `john_doe@x.com`) are LIKE wildcards and would overcount, and (b) an
      // attacker can stuff `<victim@bank.com>` into the display name and have
      // a different sender match the substring. parseFromAddress already picks
      // the LAST angle-bracketed group precisely to defeat that spoof.
      const bare = parseFromAddress(sender);
      const rows = db
        .prepare(
          `SELECT from_addr FROM email_pending WHERE received_at >= ?`,
        )
        .all(sinceMs) as { from_addr: string }[];
      let count = 0;
      for (const r of rows) {
        if (parseFromAddress(r.from_addr) === bare) count++;
      }
      return count;
    },
  };
}
