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
  /** Longer slice of the decoded body (than `snippet`) fed to the gist
   *  summarizer for more context. Same decoded text as `snippet`, no extra IMAP
   *  fetch. Optional: absent when the message has no text body — the gister then
   *  falls back to `snippet`. */
  bodyExcerpt?: string;
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
  /** Short native-language (Russian) summary of the email, or null when no
   *  summary exists (old rows, below cutoff, gist miss/failure, flag off). */
  gist: string | null;
}
