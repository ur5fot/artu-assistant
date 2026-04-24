import { describe, it, expect, vi } from 'vitest';
import type { ImapAccount } from '../types.js';
import { fetchNewMessages, fetchFullBody, __setImapFlowCtor } from '../imap-client.js';

const account: ImapAccount = {
  id: 'a', host: 'h', port: 993, user: 'u', password: 'p', tls: true,
};

function makeClientStub(options: {
  searchReturns?: number[];
  fetchRows?: Array<{ uid: number; envelope: any; bodyParts: Map<string, Buffer>; internalDate: Date }>;
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
});
