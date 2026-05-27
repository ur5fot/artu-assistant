import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ImapAccount } from '../types.js';
import {
  sendReply,
  smtpHostFor,
  __setTransportFactory,
  __resetTransportFactory,
} from '../smtp-client.js';

const account: ImapAccount = {
  id: 'a',
  host: 'imap.gmail.com',
  port: 993,
  user: 'me@example.com',
  password: 'app-pw',
  tls: true,
};

function makeStubTransport(behavior?: { rejectWith?: Error; result?: any }) {
  const sendMail = vi.fn(async (_mail: any) => {
    if (behavior?.rejectWith) throw behavior.rejectWith;
    return behavior?.result ?? { messageId: '<x@y>', response: '250 OK' };
  });
  const factory = vi.fn((_opts: any) => ({ sendMail }));
  return { factory, sendMail };
}

describe('smtpHostFor', () => {
  it('maps imap.gmail.com to smtp.gmail.com', () => {
    expect(smtpHostFor('imap.gmail.com')).toBe('smtp.gmail.com');
  });

  it('maps imap.mail.me.com to smtp.mail.me.com', () => {
    expect(smtpHostFor('imap.mail.me.com')).toBe('smtp.mail.me.com');
  });

  it('handles uppercase IMAP prefix', () => {
    expect(smtpHostFor('IMAP.example.com')).toBe('smtp.example.com');
  });

  it('returns host unchanged when no imap prefix', () => {
    expect(smtpHostFor('mail.custom.com')).toBe('mail.custom.com');
  });
});

describe('sendReply', () => {
  afterEach(() => __resetTransportFactory());

  it('builds transport with smtp host, port 465, secure, account creds', async () => {
    const { factory } = makeStubTransport();
    __setTransportFactory(factory as any);
    await sendReply({
      account,
      to: 't@x.com',
      subject: 'Hi',
      body: 'b',
      inReplyTo: null,
      references: [],
    });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: 'me@example.com', pass: 'app-pw' },
      }),
    );
  });

  it('sends with from = account.user, to and plain-text body', async () => {
    const { factory, sendMail } = makeStubTransport();
    __setTransportFactory(factory as any);
    await sendReply({
      account,
      to: 'them@x.com',
      subject: 'Hi',
      body: 'hello there',
      inReplyTo: null,
      references: [],
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'me@example.com',
        to: 'them@x.com',
        text: 'hello there',
      }),
    );
  });

  it('prepends "Re: " when subject does not start with it', async () => {
    const { factory, sendMail } = makeStubTransport();
    __setTransportFactory(factory as any);
    await sendReply({
      account,
      to: 't@x.com',
      subject: 'Hello world',
      body: 'b',
      inReplyTo: null,
      references: [],
    });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Re: Hello world' }));
  });

  it('keeps existing Re: prefix (case-insensitive)', async () => {
    const { factory, sendMail } = makeStubTransport();
    __setTransportFactory(factory as any);
    await sendReply({
      account,
      to: 't@x.com',
      subject: 'RE: Hello world',
      body: 'b',
      inReplyTo: null,
      references: [],
    });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ subject: 'RE: Hello world' }));
  });

  it('sets inReplyTo and references when provided', async () => {
    const { factory, sendMail } = makeStubTransport();
    __setTransportFactory(factory as any);
    const refs = ['<a@x>', '<b@x>', '<c@x>'];
    await sendReply({
      account,
      to: 't@x.com',
      subject: 'Hi',
      body: 'b',
      inReplyTo: '<c@x>',
      references: refs,
    });
    const arg = sendMail.mock.calls[0][0] as any;
    expect(arg.inReplyTo).toBe('<c@x>');
    expect(arg.references).toEqual(refs);
  });

  it('omits inReplyTo when null', async () => {
    const { factory, sendMail } = makeStubTransport();
    __setTransportFactory(factory as any);
    await sendReply({
      account,
      to: 't@x.com',
      subject: 'Hi',
      body: 'b',
      inReplyTo: null,
      references: [],
    });
    const arg = sendMail.mock.calls[0][0] as any;
    expect(arg.inReplyTo).toBeUndefined();
  });

  it('omits references when empty', async () => {
    const { factory, sendMail } = makeStubTransport();
    __setTransportFactory(factory as any);
    await sendReply({
      account,
      to: 't@x.com',
      subject: 'Hi',
      body: 'b',
      inReplyTo: null,
      references: [],
    });
    const arg = sendMail.mock.calls[0][0] as any;
    expect(arg.references).toBeUndefined();
  });

  it('truncates references to last 10 when longer (oldest dropped)', async () => {
    const { factory, sendMail } = makeStubTransport();
    __setTransportFactory(factory as any);
    const refs = Array.from({ length: 15 }, (_, i) => `<r${i}@x>`);
    await sendReply({
      account,
      to: 't@x.com',
      subject: 'Hi',
      body: 'b',
      inReplyTo: '<r14@x>',
      references: refs,
    });
    const arg = sendMail.mock.calls[0][0] as any;
    expect(arg.references).toHaveLength(10);
    expect(arg.references).toEqual(refs.slice(-10));
  });

  it('returns delivery info from sendMail on success', async () => {
    const { factory } = makeStubTransport({
      result: { messageId: '<sent@x>', response: '250 OK', envelope: { from: 'a', to: ['b'] } },
    });
    __setTransportFactory(factory as any);
    const info = await sendReply({
      account,
      to: 't@x.com',
      subject: 'Hi',
      body: 'b',
      inReplyTo: null,
      references: [],
    });
    expect(info).toMatchObject({ messageId: '<sent@x>', response: '250 OK' });
  });

  it('propagates sendMail rejection (does not swallow)', async () => {
    const { factory } = makeStubTransport({ rejectWith: new Error('SMTP 550 bounce') });
    __setTransportFactory(factory as any);
    await expect(
      sendReply({
        account,
        to: 't@x.com',
        subject: 'Hi',
        body: 'b',
        inReplyTo: null,
        references: [],
      }),
    ).rejects.toThrow(/SMTP 550 bounce/);
  });
});
