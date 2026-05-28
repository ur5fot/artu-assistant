import type Database from 'better-sqlite3';

export type EmailSentAction = 'sent' | 'cancelled' | 'error';

export interface EmailSentLogEntry {
  action: EmailSentAction;
  draftId: string;
  to: string;
  subject: string;
  errorMessage?: string;
}

export interface EmailSentLog {
  record(entry: EmailSentLogEntry): void;
  countLastDays(action: EmailSentAction, days: number): number;
  /** Count of `action` events to `sender` (matched by `to_addr`, which is the
   *  recipient of the reply = original sender of the urgent email) within the
   *  last `days` days. Used by `/why` to show per-sender history. `now`
   *  overrides the wall-clock anchor (tests / historical reproduction). */
  countBySender(
    sender: string,
    days: number,
    action: EmailSentAction,
    now?: number,
  ): number;
}

export function createEmailSentLog(deps: { db: Database.Database }): EmailSentLog {
  const { db } = deps;
  return {
    record(entry) {
      db.prepare(
        `INSERT INTO email_sent_log
         (action, draft_id, to_addr, subject, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        entry.action,
        entry.draftId,
        entry.to,
        entry.subject,
        entry.errorMessage ?? null,
        Date.now(),
      );
    },
    countLastDays(action, days) {
      const cutoff = Date.now() - days * 86400_000;
      const row = db
        .prepare(
          'SELECT COUNT(*) AS c FROM email_sent_log WHERE action = ? AND created_at > ?',
        )
        .get(action, cutoff) as { c: number };
      return row.c;
    },
    countBySender(sender, days, action, now) {
      const cutoff = (now ?? Date.now()) - days * 86400_000;
      const row = db
        .prepare(
          `SELECT COUNT(*) AS c FROM email_sent_log
           WHERE to_addr = ? AND action = ? AND created_at > ?`,
        )
        .get(sender, action, cutoff) as { c: number };
      return row.c;
    },
  };
}
