// These shapes mirror packages/server/src/emails/types.ts. Duplicated locally
// to keep @r2/tool-emails self-contained (no cross-package relative imports).
// TypeScript's structural typing means the real server types satisfy these.
// If these drift, lift them into @r2/shared.

export interface ImapAccount {
  id: string;
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
}

export interface FullMessage {
  uid: number;
  from: string;
  subject: string;
  bodyText: string;
  receivedAt: number;
}

export interface EmailPendingRow {
  id: number;
  account_id: string;
  message_uid: number;
  from_addr: string;
  subject: string;
  snippet: string;
  importance: number;
  received_at: number;
  added_at: number;
  delivered_at: number | null;
}

export interface EmailStoreLike {
  fetchInWindow(sinceHours: number, limit: number, now: number): EmailPendingRow[];
  fetchPendingUndelivered(limit: number): EmailPendingRow[];
  countPendingUndelivered(): number;
  countHandledSince(sinceMs: number): number;
  findByPendingId(id: number): EmailPendingRow | null;
  // Mark pending emails handled (sets delivered_at), removing them from the
  // awaiting queue while keeping the rows. Used by emails_dismiss.
  markDelivered(ids: number[], now: number): void;
  // Per-account health for the emails_status `accounts` list. Null when the
  // account has no state row yet (configured but not polled).
  getAccountState(
    accountId: string,
  ): { last_poll_at: number | null; last_error: string | null; consecutive_errors: number } | null;
}

export interface ImapClientLike {
  fetchFullBody(account: ImapAccount, uid: number): Promise<FullMessage>;
  getAccount(id: string): ImapAccount | null;
  // All configured IMAP accounts, so emails_status can report which/how many
  // mailboxes are connected — independent of whether any mail is stored yet.
  listAccounts(): ImapAccount[];
}
