import nodemailer from 'nodemailer';
import type { ImapAccount } from './types.js';

export interface SendReplyParams {
  account: ImapAccount;
  to: string;
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: string[];
}

export type TransportFactory = (opts: any) => { sendMail: (mail: any) => Promise<any> };

// Per RFC 5322 §2.1.1 lines should not exceed 998 chars. The References header
// can grow unbounded in long threads; cap to the most recent N message-ids so
// the line stays well under the limit. Most servers also tolerate longer, but
// some (Exchange, older Postfix) truncate silently.
const MAX_REFS = 10;

let factory: TransportFactory = nodemailer.createTransport as unknown as TransportFactory;

export function __setTransportFactory(f: TransportFactory): void {
  factory = f;
}

export function __resetTransportFactory(): void {
  factory = nodemailer.createTransport as unknown as TransportFactory;
}

// Gmail: imap.gmail.com -> smtp.gmail.com; iCloud: imap.mail.me.com -> smtp.mail.me.com.
// Same Gmail app password works for both protocols.
export function smtpHostFor(imapHost: string): string {
  return imapHost.replace(/^imap/i, 'smtp');
}

function ensureRePrefix(subject: string): string {
  // An empty subject from the urgent row produces a bare "Re: " which some
  // SMTP servers reject and reads as broken to the recipient. Fall back to a
  // placeholder so the header is always at least informational.
  const trimmed = subject.trim();
  if (!trimmed) return 'Re: (no subject)';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

export async function sendReply(params: SendReplyParams): Promise<any> {
  const { account, to, subject, body, inReplyTo, references } = params;

  const transport = factory({
    host: smtpHostFor(account.host),
    port: 465,
    secure: true,
    auth: { user: account.user, pass: account.password },
  });

  const cappedRefs = references.length > MAX_REFS ? references.slice(-MAX_REFS) : references;

  const mail: Record<string, unknown> = {
    from: account.user,
    to,
    subject: ensureRePrefix(subject),
    text: body,
  };
  if (inReplyTo) mail.inReplyTo = inReplyTo;
  if (cappedRefs.length > 0) mail.references = cappedRefs;

  return transport.sendMail(mail);
}
