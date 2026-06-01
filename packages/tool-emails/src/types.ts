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
}

export interface ImapClientLike {
  fetchFullBody(account: ImapAccount, uid: number): Promise<FullMessage>;
  getAccount(id: string): ImapAccount | null;
}
