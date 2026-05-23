import { describe, it, expect, vi } from 'vitest';
import type { ImapAccount } from '../types.js';
import { fetchNewMessages, fetchFullBody, __setImapFlowCtor } from '../imap-client.js';

const account: ImapAccount = {
  id: 'a', host: 'h', port: 993, user: 'u', password: 'p', tls: true,
};

function makeClientStub(options: {
  searchReturns?: number[];
  fetchRows?: Array<{ uid: number; envelope: any; bodyParts: Map<string, Buffer>; internalDate?: Date; bodyStructure?: any }>;
  throwOn?: 'connect' | 'search' | 'fetch';
}) {
  const { searchReturns = [], fetchRows = [], throwOn } = options;
  return class {
    async connect() { if (throwOn === 'connect') throw new Error('connect fail'); }
    async logout() {}
    mailboxOpen = vi.fn(async () => {});
    search = vi.fn(async () => {
      if (throwOn === 'search') throw new Error('search fail');
      return searchReturns;
    });
    fetchAll = vi.fn(async () => {
      if (throwOn === 'fetch') throw new Error('fetch fail');
      return fetchRows;
    });
    fetchOne = vi.fn(async (_uid: number, _query: any, _opts: any) => {
      return fetchRows[0] ?? null;
    });
  };
}

describe('fetchNewMessages', () => {
  it('returns empty when nothing above sinceUid', async () => {
    __setImapFlowCtor(makeClientStub({ searchReturns: [] }) as any);
    const msgs = await fetchNewMessages(account, 100, 50);
    expect(msgs).toEqual([]);
  });

  it('maps imapflow rows to NewMessage[]', async () => {
    const body = Buffer.from('First 500 chars of the body...');
    __setImapFlowCtor(
      makeClientStub({
        searchReturns: [101, 102],
        fetchRows: [
          {
            uid: 101,
            envelope: {
              from: [{ name: 'Alice', address: 'a@b.com' }],
              subject: 'hi',
            },
            bodyParts: new Map([['1', body]]),
            internalDate: new Date('2026-04-24T10:00:00Z'),
          },
        ],
      }) as any,
    );
    const msgs = await fetchNewMessages(account, 100, 50);
    expect(msgs[0]).toMatchObject({
      uid: 101, from: expect.stringContaining('Alice'), subject: 'hi',
    });
    expect(msgs[0].snippet.length).toBeLessThanOrEqual(500);
    expect(msgs[0].receivedAt).toBe(new Date('2026-04-24T10:00:00Z').getTime());
  });

  it('propagates connection errors', async () => {
    __setImapFlowCtor(makeClientStub({ throwOn: 'connect' }) as any);
    await expect(fetchNewMessages(account, 0, 10)).rejects.toThrow(/connect/);
  });

  it('decodes quoted-printable text/plain when bodyStructure reports QP', async () => {
    // "Привет, мир" encoded as quoted-printable utf-8
    const qpBody = Buffer.from('=D0=9F=D1=80=D0=B8=D0=B2=D0=B5=D1=82, =D0=BC=D0=B8=D1=80', 'latin1');
    __setImapFlowCtor(
      makeClientStub({
        searchReturns: [201],
        fetchRows: [
          {
            uid: 201,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([['1', qpBody]]),
            bodyStructure: {
              type: 'text/plain',
              encoding: 'quoted-printable',
              parameters: { charset: 'utf-8' },
              part: '1',
            },
            internalDate: new Date(0),
          },
        ],
      }) as any,
    );
    const msgs = await fetchNewMessages(account, 200, 50);
    expect(msgs[0].snippet).toBe('Привет, мир');
  });

  it('decodes base64 text/html when bodyStructure reports base64', async () => {
    const html = '<p>Hello, world</p>';
    const b64Body = Buffer.from(Buffer.from(html, 'utf-8').toString('base64'), 'latin1');
    __setImapFlowCtor(
      makeClientStub({
        searchReturns: [202],
        fetchRows: [
          {
            uid: 202,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([['1', b64Body]]),
            bodyStructure: {
              type: 'text/html',
              encoding: 'base64',
              parameters: { charset: 'utf-8' },
              part: '1',
            },
            internalDate: new Date(0),
          },
        ],
      }) as any,
    );
    const msgs = await fetchNewMessages(account, 200, 50);
    expect(msgs[0].snippet).toContain('Hello, world');
    expect(msgs[0].snippet).toContain('<p>');
  });

  it('prefers text/plain over text/html in multipart/alternative', async () => {
    const plainText = Buffer.from('plain version', 'latin1');
    const htmlBody = Buffer.from(
      Buffer.from('<p>html version</p>', 'utf-8').toString('base64'),
      'latin1',
    );
    __setImapFlowCtor(
      makeClientStub({
        searchReturns: [203],
        fetchRows: [
          {
            uid: 203,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([
              ['1', plainText],
              ['2', htmlBody],
            ]),
            bodyStructure: {
              type: 'multipart/alternative',
              childNodes: [
                {
                  type: 'text/plain',
                  encoding: '7bit',
                  parameters: { charset: 'utf-8' },
                  part: '1',
                },
                {
                  type: 'text/html',
                  encoding: 'base64',
                  parameters: { charset: 'utf-8' },
                  part: '2',
                },
              ],
            },
            internalDate: new Date(0),
          },
        ],
      }) as any,
    );
    const msgs = await fetchNewMessages(account, 200, 50);
    expect(msgs[0].snippet).toBe('plain version');
    expect(msgs[0].snippet).not.toContain('html');
  });

  it('decodes deep-nested partId 1.1.1 from multipart/signed → multipart/alternative', async () => {
    // PGP/S-MIME signed mail nests the body two levels under multipart/signed,
    // so the text leaf lives at 1.1.1. Without the 3-level prefetch the
    // snippet would silently come back empty.
    const text = 'Signed message body';
    __setImapFlowCtor(
      makeClientStub({
        searchReturns: [220],
        fetchRows: [
          {
            uid: 220,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([['1.1.1', Buffer.from(text, 'latin1')]]),
            bodyStructure: {
              type: 'multipart/signed',
              childNodes: [
                {
                  type: 'multipart/alternative',
                  childNodes: [
                    {
                      type: 'text/plain',
                      encoding: '7bit',
                      parameters: { charset: 'utf-8' },
                      part: '1.1.1',
                    },
                  ],
                },
              ],
            },
            internalDate: new Date(0),
          },
        ],
      }) as any,
    );
    const msgs = await fetchNewMessages(account, 200, 50);
    expect(msgs[0].snippet).toBe(text);
  });

  it('skips text/plain leaves marked as Content-Disposition: attachment', async () => {
    // Forwarded mail with HTML body + attached .txt log. The attachment leaf
    // is text/plain, so without the disposition filter pickTextPart would
    // pick it over the HTML body and emails_get would surface the log file
    // instead of the message.
    const html = '<p>Forwarded body</p>';
    const b64 = Buffer.from(Buffer.from(html, 'utf-8').toString('base64'), 'latin1');
    const logText = Buffer.from('2026-05-01 ERROR: db down', 'latin1');
    __setImapFlowCtor(
      makeClientStub({
        searchReturns: [221],
        fetchRows: [
          {
            uid: 221,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([
              ['1', b64],
              ['2', logText],
            ]),
            bodyStructure: {
              type: 'multipart/mixed',
              childNodes: [
                {
                  type: 'text/html',
                  encoding: 'base64',
                  parameters: { charset: 'utf-8' },
                  part: '1',
                },
                {
                  type: 'text/plain',
                  encoding: '7bit',
                  parameters: { charset: 'utf-8' },
                  part: '2',
                  disposition: 'attachment',
                },
              ],
            },
            internalDate: new Date(0),
          },
        ],
      }) as any,
    );
    const msgs = await fetchNewMessages(account, 200, 50);
    expect(msgs[0].snippet).toContain('Forwarded body');
    expect(msgs[0].snippet).not.toContain('ERROR');
  });

  it('decodes nested partId 1.2 from multipart/mixed → multipart/alternative', async () => {
    // Common shape for marketing emails (Upwork/Djinni): top-level
    // multipart/mixed wraps a multipart/alternative whose html-only leaf lives
    // at partId 1.2. The prefetch list must cover this so the snippet doesn't
    // silently come back empty.
    const html = '<p>Marketing body</p>';
    const b64 = Buffer.from(Buffer.from(html, 'utf-8').toString('base64'), 'latin1');
    __setImapFlowCtor(
      makeClientStub({
        searchReturns: [206],
        fetchRows: [
          {
            uid: 206,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([['1.2', b64]]),
            bodyStructure: {
              type: 'multipart/mixed',
              childNodes: [
                {
                  type: 'multipart/alternative',
                  childNodes: [
                    {
                      type: 'text/html',
                      encoding: 'base64',
                      parameters: { charset: 'utf-8' },
                      part: '1.2',
                    },
                  ],
                },
              ],
            },
            internalDate: new Date(0),
          },
        ],
      }) as any,
    );
    const msgs = await fetchNewMessages(account, 200, 50);
    expect(msgs[0].snippet).toContain('Marketing body');
  });

  it('falls back to envelope.date when internalDate is missing', async () => {
    const envDate = new Date('2026-04-20T12:00:00Z');
    __setImapFlowCtor(
      makeClientStub({
        searchReturns: [207],
        fetchRows: [
          {
            uid: 207,
            envelope: { from: [{ address: 'x@y' }], subject: 's', date: envDate },
            bodyParts: new Map([['1', Buffer.from('hi', 'latin1')]]),
            bodyStructure: {
              type: 'text/plain',
              encoding: '7bit',
              parameters: { charset: 'utf-8' },
              part: '1',
            },
            // internalDate intentionally omitted to exercise envelope.date branch
          } as any,
        ],
      }) as any,
    );
    const msgs = await fetchNewMessages(account, 200, 50);
    expect(msgs[0].receivedAt).toBe(envDate.getTime());
  });

  it('falls back to Date.now() when both internalDate and envelope.date are missing', async () => {
    const before = Date.now();
    __setImapFlowCtor(
      makeClientStub({
        searchReturns: [208],
        fetchRows: [
          {
            uid: 208,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([['1', Buffer.from('hi', 'latin1')]]),
            bodyStructure: {
              type: 'text/plain',
              encoding: '7bit',
              parameters: { charset: 'utf-8' },
              part: '1',
            },
          } as any,
        ],
      }) as any,
    );
    const msgs = await fetchNewMessages(account, 200, 50);
    const after = Date.now();
    expect(msgs[0].receivedAt).toBeGreaterThanOrEqual(before);
    expect(msgs[0].receivedAt).toBeLessThanOrEqual(after);
  });

  it('emits empty snippet for image-only message (no text part)', async () => {
    // Only an image attachment, no text leaves at all.
    __setImapFlowCtor(
      makeClientStub({
        searchReturns: [204],
        fetchRows: [
          {
            uid: 204,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([['1', Buffer.from('not-real-jpeg-bytes', 'latin1')]]),
            bodyStructure: {
              type: 'image/jpeg',
              encoding: 'base64',
              parameters: { name: 'photo.jpg' },
              part: '1',
            },
            internalDate: new Date(0),
          },
        ],
      }) as any,
    );
    const msgs = await fetchNewMessages(account, 200, 50);
    expect(msgs[0].snippet).toBe('');
  });

  it('requests bodyStructure and common text partIds in fetchAll', async () => {
    let capturedQuery: any = null;
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn(async () => [300]);
      fetchAll = vi.fn(async (_uids: number[], query: any) => {
        capturedQuery = query;
        return [
          {
            uid: 300,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([['1', Buffer.from('hi', 'latin1')]]),
            bodyStructure: {
              type: 'text/plain',
              encoding: '7bit',
              parameters: { charset: 'utf-8' },
              part: '1',
            },
            internalDate: new Date(0),
          },
        ];
      });
      fetchOne = vi.fn();
    };
    __setImapFlowCtor(Ctor as any);
    await fetchNewMessages(account, 0, 10);
    expect(capturedQuery.bodyStructure).toBe(true);
    expect(capturedQuery.bodyParts).toEqual([
      '1', '1.1', '1.2', '1.1.1', '1.2.1',
      '2', '2.1', '2.2', '2.1.1', '2.2.1',
      '3',
    ]);
  });

  it('decodes RFC2047-encoded subject and from.name', async () => {
    __setImapFlowCtor(
      makeClientStub({
        searchReturns: [205],
        fetchRows: [
          {
            uid: 205,
            envelope: {
              from: [{ name: '=?utf-8?B?0JDQu9C40YHQsA==?=', address: 'a@b.com' }],
              subject: '=?utf-8?Q?=D0=9F=D1=80=D0=B8=D0=B2=D0=B5=D1=82?=',
            },
            bodyParts: new Map([['1', Buffer.from('body', 'latin1')]]),
            bodyStructure: {
              type: 'text/plain',
              encoding: '7bit',
              parameters: { charset: 'utf-8' },
              part: '1',
            },
            internalDate: new Date(0),
          },
        ],
      }) as any,
    );
    const msgs = await fetchNewMessages(account, 200, 50);
    expect(msgs[0].subject).toBe('Привет');
    expect(msgs[0].from).toContain('Алиса');
    expect(msgs[0].from).toContain('a@b.com');
  });

  it('caps with oldest-first slice so backlog > limit does not skip older UIDs', async () => {
    // 100 UIDs waiting, limit=10. slice(-limit) would return [91..100] and the
    // poller's maxUid advancement would orphan UIDs 1..90 forever. slice(0, limit)
    // returns [1..10] — oldest first, so last_seen_uid stays contiguous with
    // what we have actually fetched.
    const searchReturns = Array.from({ length: 100 }, (_, i) => i + 1);
    let fetchedCap: number[] | null = null;
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn(async () => searchReturns);
      fetchAll = vi.fn(async (cap: number[]) => {
        fetchedCap = cap;
        return cap.map((uid) => ({
          uid,
          envelope: { from: [{ address: 'x@y' }], subject: 's' },
          bodyParts: new Map([['1', Buffer.from('snip')]]),
          internalDate: new Date(0),
        }));
      });
      fetchOne = vi.fn();
    };
    __setImapFlowCtor(Ctor as any);
    const msgs = await fetchNewMessages(account, 0, 10);
    expect(fetchedCap).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(msgs.map((m) => m.uid)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('fetchFullBody', () => {
  it('returns body text for a uid', async () => {
    const body = Buffer.from('Full body text here');
    __setImapFlowCtor(
      makeClientStub({
        fetchRows: [
          {
            uid: 5,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([['1', body]]),
            internalDate: new Date(0),
          },
        ],
      }) as any,
    );
    const full = await fetchFullBody(account, 5);
    expect(full.bodyText).toContain('Full body text here');
  });

  it('preserves newlines and normalizes CRLF — full body is not snippet-flattened', async () => {
    const body = Buffer.from('Line 1\r\nLine 2\r\n\r\nParagraph 2');
    __setImapFlowCtor(
      makeClientStub({
        fetchRows: [
          {
            uid: 5,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([['1', body]]),
            internalDate: new Date(0),
          },
        ],
      }) as any,
    );
    const full = await fetchFullBody(account, 5);
    expect(full.bodyText).toBe('Line 1\nLine 2\n\nParagraph 2');
  });

  it('appends truncation marker when body exceeds limit', async () => {
    const big = Buffer.from('a'.repeat(60_000));
    __setImapFlowCtor(
      makeClientStub({
        fetchRows: [
          {
            uid: 5,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([['1', big]]),
            internalDate: new Date(0),
          },
        ],
      }) as any,
    );
    const full = await fetchFullBody(account, 5);
    expect(full.bodyText.length).toBeLessThanOrEqual(50_000);
    expect(full.bodyText).toContain('[truncated]');
  });

  it('throws when uid not found', async () => {
    __setImapFlowCtor(makeClientStub({ fetchRows: [] }) as any);
    await expect(fetchFullBody(account, 999)).rejects.toThrow(/not found/i);
  });

  it('decodes quoted-printable body when bodyStructure reports QP', async () => {
    // "Привет, мир\nLine 2" QP-encoded as utf-8
    const qpBody = Buffer.from(
      '=D0=9F=D1=80=D0=B8=D0=B2=D0=B5=D1=82, =D0=BC=D0=B8=D1=80\r\nLine 2',
      'latin1',
    );
    __setImapFlowCtor(
      makeClientStub({
        fetchRows: [
          {
            uid: 7,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([['1', qpBody]]),
            bodyStructure: {
              type: 'text/plain',
              encoding: 'quoted-printable',
              parameters: { charset: 'utf-8' },
              part: '1',
            },
            internalDate: new Date(0),
          },
        ],
      }) as any,
    );
    const full = await fetchFullBody(account, 7);
    expect(full.bodyText).toBe('Привет, мир\nLine 2');
  });

  it('decodes base64 body when bodyStructure reports base64', async () => {
    const html = '<p>Hello, world</p>\n<p>Second line</p>';
    const b64Body = Buffer.from(Buffer.from(html, 'utf-8').toString('base64'), 'latin1');
    __setImapFlowCtor(
      makeClientStub({
        fetchRows: [
          {
            uid: 8,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([['1', b64Body]]),
            bodyStructure: {
              type: 'text/html',
              encoding: 'base64',
              parameters: { charset: 'utf-8' },
              part: '1',
            },
            internalDate: new Date(0),
          },
        ],
      }) as any,
    );
    const full = await fetchFullBody(account, 8);
    expect(full.bodyText).toContain('<p>Hello, world</p>');
    expect(full.bodyText).toContain('<p>Second line</p>');
  });

  it('requests bodyStructure and common text partIds in fetchOne', async () => {
    let capturedQuery: any = null;
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn(async () => []);
      fetchAll = vi.fn(async () => []);
      fetchOne = vi.fn(async (_uid: number, query: any) => {
        capturedQuery = query;
        return {
          uid: 9,
          envelope: { from: [{ address: 'x@y' }], subject: 's' },
          bodyParts: new Map([['1', Buffer.from('hi', 'latin1')]]),
          bodyStructure: {
            type: 'text/plain',
            encoding: '7bit',
            parameters: { charset: 'utf-8' },
            part: '1',
          },
          internalDate: new Date(0),
        };
      });
    };
    __setImapFlowCtor(Ctor as any);
    await fetchFullBody(account, 9);
    expect(capturedQuery.bodyStructure).toBe(true);
    expect(capturedQuery.bodyParts).toEqual([
      '1', '1.1', '1.2', '1.1.1', '1.2.1',
      '2', '2.1', '2.2', '2.1.1', '2.2.1',
      '3',
    ]);
  });
});
