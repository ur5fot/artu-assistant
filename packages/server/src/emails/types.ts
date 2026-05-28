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
  subject: string;
  snippet: string;
  importance: number;
  received_at: number;
  added_at: number;
  delivered_at: number | null;
  urgent_pinged_at: number | null;
}
