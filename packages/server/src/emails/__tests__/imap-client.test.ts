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
    fetchOne = vi.fn(async (_uid: number, _opts: any) => {
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

  it('throws when uid not found', async () => {
    __setImapFlowCtor(makeClientStub({ fetchRows: [] }) as any);
    await expect(fetchFullBody(account, 999)).rejects.toThrow(/not found/i);
  });
});
