export interface ImapAccount {
  id: string;
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
}

export interface NewMessage {
  uid: number;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: number;
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
  // Schema allows NULL for both subject and snippet — IMAP envelopes for
  // header-only / multipart messages don't always carry them. Callers must
  // tolerate null (most use `?? ''` or `?? '(no subject)'`).
  subject: string | null;
  snippet: string | null;
  importance: number;
  received_at: number;
  added_at: number;
  delivered_at: number | null;
  urgent_pinged_at: number | null;
}
