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
  };
}
