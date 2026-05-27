import { describe, it, expect, vi } from 'vitest';
import type { ImapAccount } from '../types.js';
import {
  fetchNewMessages,
  fetchFullBody,
  fetchHeaders,
  fetchByMessageId,
  getMaxUid,
  __setImapFlowCtor,
} from '../imap-client.js';

const account: ImapAccount = {
  id: 'a', host: 'h', port: 993, user: 'u', password: 'p', tls: true,
};

function makeClientStub(options: {
  searchReturns?: number[] | false;
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
            bodyStructure: {
              type: 'text/plain',
              encoding: '7bit',
              parameters: { charset: 'utf-8' },
              part: '1',
            },
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

  it('uses two-phase fetch: metadata-only first, then picked partId only', async () => {
    // Phase 1 must NOT request bodyParts (would download attachments at part
    // '2' on multipart/mixed). Phase 2 fetches only the leaf chosen by
    // pickTextPart.
    const calls: Array<{ uids: any; query: any }> = [];
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn(async () => [300]);
      fetchAll = vi.fn(async (uids: any, query: any) => {
        calls.push({ uids, query });
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
    expect(calls).toHaveLength(2);
    expect(calls[0].query).toEqual({
      envelope: true,
      internalDate: true,
      bodyStructure: true,
    });
    expect(calls[0].query.bodyParts).toBeUndefined();
    expect(calls[1].query).toEqual({ bodyParts: ['1'] });
    expect(calls[1].uids).toEqual([300]);
  });

  it('phase 2 batches UIDs sharing the same partId into one fetch', async () => {
    // Two messages, both text/plain at part '1' — should produce a single
    // phase-2 fetchAll over [uid1, uid2], not one per message.
    const calls: Array<{ uids: any; query: any }> = [];
    const meta = (uid: number) => ({
      uid,
      envelope: { from: [{ address: 'x@y' }], subject: 's' },
      bodyParts: new Map([['1', Buffer.from(`body-${uid}`, 'latin1')]]),
      bodyStructure: {
        type: 'text/plain',
        encoding: '7bit',
        parameters: { charset: 'utf-8' },
        part: '1',
      },
      internalDate: new Date(0),
    });
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn(async () => [301, 302]);
      fetchAll = vi.fn(async (uids: any, query: any) => {
        calls.push({ uids, query });
        return [meta(301), meta(302)];
      });
      fetchOne = vi.fn();
    };
    __setImapFlowCtor(Ctor as any);
    await fetchNewMessages(account, 0, 10);
    expect(calls).toHaveLength(2);
    expect(calls[1].query).toEqual({ bodyParts: ['1'] });
    expect(calls[1].uids).toEqual([301, 302]);
  });

  it('phase 2 issues separate fetches for different partIds', async () => {
    // One message body at '1', another at '1.1' — needs two phase-2 fetches,
    // each scoped to the UIDs whose pickTextPart selected that partId.
    const calls: Array<{ uids: any; query: any }> = [];
    const rowA = {
      uid: 401,
      envelope: { from: [{ address: 'x@y' }], subject: 's' },
      bodyParts: new Map([['1', Buffer.from('body-1', 'latin1')]]),
      bodyStructure: {
        type: 'text/plain',
        encoding: '7bit',
        parameters: { charset: 'utf-8' },
        part: '1',
      },
      internalDate: new Date(0),
    };
    const rowB = {
      uid: 402,
      envelope: { from: [{ address: 'x@y' }], subject: 's' },
      bodyParts: new Map([['1.1', Buffer.from('body-1.1', 'latin1')]]),
      bodyStructure: {
        type: 'multipart/alternative',
        childNodes: [
          {
            type: 'text/plain',
            encoding: '7bit',
            parameters: { charset: 'utf-8' },
            part: '1.1',
          },
        ],
      },
      internalDate: new Date(0),
    };
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn(async () => [401, 402]);
      fetchAll = vi.fn(async (uids: any, query: any) => {
        calls.push({ uids, query });
        if (!query.bodyParts) return [rowA, rowB];
        if (query.bodyParts[0] === '1') return [rowA];
        if (query.bodyParts[0] === '1.1') return [rowB];
        return [];
      });
      fetchOne = vi.fn();
    };
    __setImapFlowCtor(Ctor as any);
    const msgs = await fetchNewMessages(account, 0, 10);
    expect(calls).toHaveLength(3);
    const phase2 = calls.slice(1);
    const byPart = new Map(phase2.map((c) => [c.query.bodyParts[0], c.uids]));
    expect(byPart.get('1')).toEqual([401]);
    expect(byPart.get('1.1')).toEqual([402]);
    expect(msgs.find((m) => m.uid === 401)?.snippet).toBe('body-1');
    expect(msgs.find((m) => m.uid === 402)?.snippet).toBe('body-1.1');
  });

  it('skips phase 2 entirely when no message has a text part (image-only batch)', async () => {
    const calls: Array<{ uids: any; query: any }> = [];
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn(async () => [500]);
      fetchAll = vi.fn(async (uids: any, query: any) => {
        calls.push({ uids, query });
        return [
          {
            uid: 500,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyStructure: {
              type: 'image/jpeg',
              encoding: 'base64',
              parameters: { name: 'photo.jpg' },
              part: '1',
            },
            internalDate: new Date(0),
          },
        ];
      });
      fetchOne = vi.fn();
    };
    __setImapFlowCtor(Ctor as any);
    const msgs = await fetchNewMessages(account, 0, 10);
    expect(calls).toHaveLength(1);
    expect(msgs[0].snippet).toBe('');
  });

  it('skips text/plain hidden inside a message/rfc822 attachment subtree', async () => {
    // multipart/mixed with the real body at text/html and a forwarded
    // message/rfc822 attachment whose own text/plain would otherwise win
    // (pickTextPart prefers text/plain). The ancestor disposition must
    // disqualify the entire forwarded subtree so the outer text/html body
    // becomes the snippet.
    const html = '<p>Outer html body</p>';
    const b64 = Buffer.from(Buffer.from(html, 'utf-8').toString('base64'), 'latin1');
    __setImapFlowCtor(
      makeClientStub({
        searchReturns: [222],
        fetchRows: [
          {
            uid: 222,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([
              ['1', b64],
              ['2.1', Buffer.from('inner plain text', 'latin1')],
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
                  type: 'message/rfc822',
                  disposition: 'attachment',
                  part: '2',
                  childNodes: [
                    {
                      type: 'text/plain',
                      encoding: '7bit',
                      parameters: { charset: 'utf-8' },
                      part: '2.1',
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
    expect(msgs[0].snippet).toContain('Outer html body');
    expect(msgs[0].snippet).not.toContain('inner plain text');
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

describe('getMaxUid', () => {
  it('returns 0 for an empty inbox (search returns [])', async () => {
    __setImapFlowCtor(makeClientStub({ searchReturns: [] }) as any);
    const max = await getMaxUid(account);
    expect(max).toBe(0);
  });

  it('returns the max UID for a populated inbox', async () => {
    __setImapFlowCtor(makeClientStub({ searchReturns: [1, 2, 3, 100, 99] }) as any);
    const max = await getMaxUid(account);
    expect(max).toBe(100);
  });

  it('returns the actual max for non-contiguous UIDs (not the array length)', async () => {
    __setImapFlowCtor(makeClientStub({ searchReturns: [1, 5, 22532, 1000] }) as any);
    const max = await getMaxUid(account);
    expect(max).toBe(22532);
  });

  it('throws when imapflow search fails (caller handles)', async () => {
    __setImapFlowCtor(makeClientStub({ throwOn: 'search' }) as any);
    await expect(getMaxUid(account)).rejects.toThrow(/search/);
  });

  it('throws when imapflow search returns false (server NO/BAD) — must not be treated as empty inbox', async () => {
    // imapflow types `search()` as `number[] | false`; `false` signals a failed
    // SEARCH command. Treating it as `[]` would persist last_seen_uid=0 and
    // make the next tick crawl `UID 1:*` — the backlog this probe must skip.
    __setImapFlowCtor(makeClientStub({ searchReturns: false }) as any);
    await expect(getMaxUid(account)).rejects.toThrow(/SEARCH/);
  });

  it('uses search({ all: true }) — not a uid-range — to enumerate all UIDs', async () => {
    const calls: any[] = [];
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn(async (criteria: any, opts: any) => {
        calls.push({ criteria, opts });
        return [42];
      });
      fetchAll = vi.fn();
      fetchOne = vi.fn();
    };
    __setImapFlowCtor(Ctor as any);
    await getMaxUid(account);
    expect(calls).toHaveLength(1);
    expect(calls[0].criteria).toEqual({ all: true });
    expect(calls[0].opts).toEqual({ uid: true });
  });
});

describe('fetchFullBody', () => {
  const textPlainStructure = {
    type: 'text/plain',
    encoding: '7bit',
    parameters: { charset: 'utf-8' },
    part: '1',
  };

  it('returns body text for a uid', async () => {
    const body = Buffer.from('Full body text here');
    __setImapFlowCtor(
      makeClientStub({
        fetchRows: [
          {
            uid: 5,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([['1', body]]),
            bodyStructure: textPlainStructure,
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
            bodyStructure: textPlainStructure,
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
            bodyStructure: textPlainStructure,
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

  it('uses two-phase fetchOne: metadata first, then picked partId only', async () => {
    const queries: any[] = [];
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn(async () => []);
      fetchAll = vi.fn(async () => []);
      fetchOne = vi.fn(async (_uid: number, query: any) => {
        queries.push(query);
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
    expect(queries).toHaveLength(2);
    expect(queries[0]).toEqual({
      envelope: true,
      internalDate: true,
      bodyStructure: true,
    });
    expect(queries[0].bodyParts).toBeUndefined();
    expect(queries[1]).toEqual({ bodyParts: ['1'] });
  });

  it('fetchFullBody skips phase 2 when message has no text part', async () => {
    // Image-only message — body must be '' and no second fetchOne call.
    const queries: any[] = [];
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn(async () => []);
      fetchAll = vi.fn(async () => []);
      fetchOne = vi.fn(async (_uid: number, query: any) => {
        queries.push(query);
        return {
          uid: 10,
          envelope: { from: [{ address: 'x@y' }], subject: 's' },
          bodyStructure: {
            type: 'image/jpeg',
            encoding: 'base64',
            parameters: { name: 'photo.jpg' },
            part: '1',
          },
          internalDate: new Date(0),
        };
      });
    };
    __setImapFlowCtor(Ctor as any);
    const full = await fetchFullBody(account, 10);
    expect(queries).toHaveLength(1);
    expect(full.bodyText).toBe('');
  });
});

describe('fetchHeaders', () => {
  it('parses Message-ID, In-Reply-To and References from raw header buffer', async () => {
    const raw = [
      'Message-ID: <abc@host>',
      'In-Reply-To: <parent@host>',
      'References: <grandparent@host> <parent@host>',
      '',
    ].join('\r\n');
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn();
      fetchAll = vi.fn();
      fetchOne = vi.fn(async (_uid: number, _query: any) => ({
        uid: 700,
        headers: Buffer.from(raw, 'utf-8'),
      }));
    };
    __setImapFlowCtor(Ctor as any);
    const h = await fetchHeaders(account, 700);
    expect(h.messageId).toBe('<abc@host>');
    expect(h.inReplyTo).toBe('<parent@host>');
    expect(h.references).toEqual(['<grandparent@host>', '<parent@host>']);
  });

  it('returns null/[] for missing headers', async () => {
    const raw = ['Subject: hi', '', ''].join('\r\n');
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn();
      fetchAll = vi.fn();
      fetchOne = vi.fn(async () => ({ uid: 701, headers: Buffer.from(raw) }));
    };
    __setImapFlowCtor(Ctor as any);
    const h = await fetchHeaders(account, 701);
    expect(h.messageId).toBeNull();
    expect(h.inReplyTo).toBeNull();
    expect(h.references).toEqual([]);
  });

  it('handles wrapped References across multiple physical lines', async () => {
    // RFC 5322 allows long header values to be folded across lines starting
    // with whitespace.
    const raw = [
      'Message-ID: <m1@h>',
      'References: <a@h>',
      ' <b@h>',
      '\t<c@h>',
      '',
      '',
    ].join('\r\n');
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn();
      fetchAll = vi.fn();
      fetchOne = vi.fn(async () => ({ uid: 702, headers: Buffer.from(raw) }));
    };
    __setImapFlowCtor(Ctor as any);
    const h = await fetchHeaders(account, 702);
    expect(h.references).toEqual(['<a@h>', '<b@h>', '<c@h>']);
  });

  it('is case-insensitive on header names', async () => {
    const raw = [
      'MESSAGE-ID: <up@host>',
      'in-reply-to: <p@host>',
      'references: <p@host>',
      '',
    ].join('\r\n');
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn();
      fetchAll = vi.fn();
      fetchOne = vi.fn(async () => ({ uid: 703, headers: Buffer.from(raw) }));
    };
    __setImapFlowCtor(Ctor as any);
    const h = await fetchHeaders(account, 703);
    expect(h.messageId).toBe('<up@host>');
    expect(h.inReplyTo).toBe('<p@host>');
    expect(h.references).toEqual(['<p@host>']);
  });

  it('returns nulls/[] when fetchOne returns null (uid not found)', async () => {
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn();
      fetchAll = vi.fn();
      fetchOne = vi.fn(async () => null);
    };
    __setImapFlowCtor(Ctor as any);
    const h = await fetchHeaders(account, 704);
    expect(h).toEqual({ messageId: null, inReplyTo: null, references: [] });
  });

  it('dedupes References while preserving order', async () => {
    const raw = [
      'References: <a@h> <b@h> <a@h> <c@h>',
      '',
    ].join('\r\n');
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn();
      fetchAll = vi.fn();
      fetchOne = vi.fn(async () => ({ uid: 705, headers: Buffer.from(raw) }));
    };
    __setImapFlowCtor(Ctor as any);
    const h = await fetchHeaders(account, 705);
    expect(h.references).toEqual(['<a@h>', '<b@h>', '<c@h>']);
  });
});

describe('fetchByMessageId', () => {
  it('returns null when search finds no matching message', async () => {
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn(async () => []);
      fetchAll = vi.fn(async () => []);
      fetchOne = vi.fn();
    };
    __setImapFlowCtor(Ctor as any);
    const msg = await fetchByMessageId(account, '<missing@x>');
    expect(msg).toBeNull();
  });

  it('returns null when imapflow search returns false (server NO/BAD)', async () => {
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn(async () => false);
      fetchAll = vi.fn();
      fetchOne = vi.fn();
    };
    __setImapFlowCtor(Ctor as any);
    const msg = await fetchByMessageId(account, '<x@y>');
    expect(msg).toBeNull();
  });

  it('searches by header Message-ID and returns NewMessage', async () => {
    const calls: any[] = [];
    const Ctor = class {
      async connect() {}
      async logout() {}
      mailboxOpen = vi.fn(async () => {});
      search = vi.fn(async (criteria: any) => {
        calls.push(criteria);
        return [42];
      });
      fetchAll = vi.fn(async () => [
        {
          uid: 42,
          envelope: { from: [{ name: 'X', address: 'x@y' }], subject: 'hi' },
          bodyParts: new Map([['1', Buffer.from('body text', 'latin1')]]),
          bodyStructure: {
            type: 'text/plain',
            encoding: '7bit',
            parameters: { charset: 'utf-8' },
            part: '1',
          },
          internalDate: new Date('2026-04-20T10:00:00Z'),
        },
      ]);
      fetchOne = vi.fn();
    };
    __setImapFlowCtor(Ctor as any);
    const msg = await fetchByMessageId(account, '<m42@h>');
    expect(msg).not.toBeNull();
    expect(msg!.uid).toBe(42);
    expect(msg!.subject).toBe('hi');
    expect(msg!.snippet).toContain('body text');
    expect(calls[0]).toEqual({ header: { 'Message-ID': '<m42@h>' } });
  });
});
