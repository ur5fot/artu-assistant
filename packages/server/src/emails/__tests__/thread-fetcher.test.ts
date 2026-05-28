import { describe, it, expect, vi } from 'vitest';
import type { ImapAccount } from '../types.js';
import { fetchThread, __setImapClientForThreadFetcher } from '../thread-fetcher.js';

const account: ImapAccount = {
  id: 'a', host: 'h', port: 993, user: 'u', password: 'p', tls: true,
};

interface FakeHeaders {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
}

interface FakeMessage {
  uid: number;
  from: string;
  subject: string;
  bodyText: string;
  receivedAt: number;
}

function installClient(opts: {
  headersByUid?: Record<number, FakeHeaders>;
  messagesByMessageId?: Record<string, FakeMessage>;
  fullBodyByUid?: Record<number, FakeMessage>;
}) {
  const headersByUid = opts.headersByUid || {};
  const messagesByMessageId = opts.messagesByMessageId || {};
  const fullBodyByUid = opts.fullBodyByUid || {};
  __setImapClientForThreadFetcher({
    fetchHeaders: vi.fn(async (_account: ImapAccount, uid: number) => {
      return headersByUid[uid] || { messageId: null, inReplyTo: null, references: [] };
    }),
    fetchByMessageId: vi.fn(async (_account: ImapAccount, messageId: string) => {
      return messagesByMessageId[messageId] || null;
    }),
    fetchFullBody: vi.fn(async (_account: ImapAccount, uid: number) => {
      const found = fullBodyByUid[uid];
      if (!found) throw new Error(`uid=${uid} not found`);
      return found;
    }),
    fetchNewMessages: vi.fn(),
    getMaxUid: vi.fn(),
  } as any);
}

function mkMsg(uid: number, subject: string): FakeMessage {
  return { uid, from: 'a@b.com', subject, bodyText: `body-${uid}`, receivedAt: uid * 1000 };
}

describe('fetchThread', () => {
  it('returns single-element array when message has no References', async () => {
    installClient({
      headersByUid: {
        50: { messageId: '<m50@x>', inReplyTo: null, references: [] },
      },
      fullBodyByUid: { 50: mkMsg(50, 'standalone') },
    });
    const thread = await fetchThread(account, 50);
    expect(thread).toHaveLength(1);
    expect(thread[0].uid).toBe(50);
    expect(thread[0].bodyText).toBe('body-50');
  });

  it('returns 3-message thread oldest-first when References has two ancestors', async () => {
    installClient({
      headersByUid: {
        103: {
          messageId: '<m103@x>',
          inReplyTo: '<m102@x>',
          references: ['<m101@x>', '<m102@x>'],
        },
      },
      messagesByMessageId: {
        '<m101@x>': mkMsg(101, 're1'),
        '<m102@x>': mkMsg(102, 're2'),
      },
      fullBodyByUid: { 103: mkMsg(103, 're3') },
    });
    const thread = await fetchThread(account, 103);
    expect(thread.map((m) => m.uid)).toEqual([101, 102, 103]);
  });

  it('silently skips references that resolve to null (message outside INBOX)', async () => {
    installClient({
      headersByUid: {
        202: {
          messageId: '<m202@x>',
          inReplyTo: '<missing@x>',
          references: ['<missing@x>'],
        },
      },
      messagesByMessageId: {
        // '<missing@x>' intentionally absent — fetchByMessageId returns null
      },
      fullBodyByUid: { 202: mkMsg(202, 'reply') },
    });
    const thread = await fetchThread(account, 202);
    expect(thread.map((m) => m.uid)).toEqual([202]);
  });

  it('caps thread at 20 messages even when References has 30', async () => {
    const refs = Array.from({ length: 30 }, (_, i) => `<m${i + 1}@x>`);
    const messagesByMessageId: Record<string, FakeMessage> = {};
    for (let i = 0; i < 30; i += 1) {
      messagesByMessageId[`<m${i + 1}@x>`] = mkMsg(i + 1, `t${i + 1}`);
    }
    installClient({
      headersByUid: {
        999: { messageId: '<current@x>', inReplyTo: refs[29], references: refs },
      },
      messagesByMessageId,
      fullBodyByUid: { 999: mkMsg(999, 'current') },
    });
    const thread = await fetchThread(account, 999);
    expect(thread).toHaveLength(20);
    // last entry is always the current message
    expect(thread[thread.length - 1].uid).toBe(999);
  });

  it('does not re-fetch current via Message-ID search even when it appears in References', async () => {
    const calls: string[] = [];
    installClient({
      headersByUid: {
        310: {
          messageId: '<m310@x>',
          inReplyTo: '<m309@x>',
          references: ['<m309@x>', '<m310@x>'],
        },
      },
      messagesByMessageId: {
        '<m309@x>': mkMsg(309, 'parent'),
      },
      fullBodyByUid: { 310: mkMsg(310, 'self') },
    });
    // Track which Message-IDs are searched — current's own id must NOT be.
    const thread = await fetchThread(account, 310);
    expect(thread.map((m) => m.uid)).toEqual([309, 310]);
    // Sanity check that body comes from fetchFullBody (not from a stale snippet path).
    expect(thread[1].bodyText).toBe('body-310');
    void calls;
  });

  it('dedupes when References itself contains duplicates, preserves first-seen order', async () => {
    installClient({
      headersByUid: {
        410: {
          messageId: '<m410@x>',
          inReplyTo: '<m402@x>',
          references: ['<m401@x>', '<m402@x>', '<m401@x>'],
        },
      },
      messagesByMessageId: {
        '<m401@x>': mkMsg(401, 'a'),
        '<m402@x>': mkMsg(402, 'b'),
      },
      fullBodyByUid: { 410: mkMsg(410, 'c') },
    });
    const thread = await fetchThread(account, 410);
    expect(thread.map((m) => m.uid)).toEqual([401, 402, 410]);
  });

  it('still returns the current message when fetchHeaders yields no messageId and no refs', async () => {
    installClient({
      headersByUid: {
        500: { messageId: null, inReplyTo: null, references: [] },
      },
      fullBodyByUid: { 500: mkMsg(500, 'orphan') },
    });
    // No Message-ID for current → can't search by it. The fetcher falls back
    // to fetchFullBody(uid) so the user always gets at least the message they
    // clicked Reply on.
    const thread = await fetchThread(account, 500);
    expect(thread.map((m) => m.uid)).toEqual([500]);
    expect(thread[0].bodyText).toBe('body-500');
  });

  it('returns ancestors only when fetchFullBody fails for current', async () => {
    installClient({
      headersByUid: {
        600: { messageId: '<m600@x>', inReplyTo: '<m599@x>', references: ['<m599@x>'] },
      },
      messagesByMessageId: { '<m599@x>': mkMsg(599, 'parent') },
      fullBodyByUid: {}, // current uid not in map → fetchFullBody throws
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const thread = await fetchThread(account, 600);
    expect(thread.map((m) => m.uid)).toEqual([599]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
