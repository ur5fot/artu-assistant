import { describe, it, expect, vi } from 'vitest';
import { createTool } from '../index.js';
import type { EmailStoreLike, ImapClientLike, EmailPendingRow } from '../types.js';

function mkRow(id: number, importance: number, delivered = false): EmailPendingRow {
  return {
    id,
    account_id: 'a',
    message_uid: id,
    from_addr: 'A <a@b>',
    subject: 'S',
    snippet: 'x',
    importance,
    received_at: 1000 + id,
    added_at: 1000 + id,
    delivered_at: delivered ? 2000 : null,
  };
}

function mkStore(rows: EmailPendingRow[]): EmailStoreLike {
  return {
    fetchInWindow: vi.fn((_h: number, _l: number, _now: number) => rows),
    findByPendingId: vi.fn((id: number) => rows.find((r) => r.id === id) ?? null),
  };
}

function mkImap(overrides: Partial<ImapClientLike> = {}): ImapClientLike {
  return {
    fetchFullBody: vi.fn(),
    getAccount: vi.fn(() => ({ id: 'a', host: 'h', port: 993, user: 'u', password: 'p', tls: true })),
    ...overrides,
  };
}

describe('emails_list tool', () => {
  it('returns JSON array of rows', async () => {
    const tools = createTool({
      emailStore: mkStore([mkRow(1, 5), mkRow(2, 4, true)]),
      imapClient: mkImap(),
    });
    const list = tools.find((t) => t.name === 'emails_list')!;
    const res = await list.handler({});
    expect(res.success).toBe(true);
    const data = res.data as Array<Record<string, unknown>>;
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(2);
    expect(data[0]).toHaveProperty('importance');
    expect(data[0]).toHaveProperty('delivered');
  });

  it('honours limit (default 10, max 50)', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => mkRow(i + 1, 4));
    const store = mkStore(rows);
    const tools = createTool({ emailStore: store, imapClient: mkImap() });
    const list = tools.find((t) => t.name === 'emails_list')!;

    await list.handler({});
    expect(store.fetchInWindow).toHaveBeenLastCalledWith(72, 10, expect.any(Number));

    await list.handler({ limit: 500 });
    expect(store.fetchInWindow).toHaveBeenLastCalledWith(72, 50, expect.any(Number));
  });

  it('returns error when emailStore is null', async () => {
    const tools = createTool({ emailStore: null, imapClient: mkImap() });
    const list = tools.find((t) => t.name === 'emails_list')!;
    const res = await list.handler({});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/email/i);
  });
});

describe('emails_get tool', () => {
  it('returns full body for known id', async () => {
    const rows = [mkRow(5, 5)];
    const fetchFullBody = vi.fn(async () => ({
      uid: 5,
      from: 'A <a@b>',
      subject: 'S',
      bodyText: 'Full body here',
      receivedAt: 1000,
    }));
    const tools = createTool({
      emailStore: mkStore(rows),
      imapClient: mkImap({ fetchFullBody }),
    });
    const get = tools.find((t) => t.name === 'emails_get')!;
    const res = await get.handler({ id: 5 });
    expect(res.success).toBe(true);
    const data = JSON.parse(res.data as string);
    expect(data.body_text).toBe('Full body here');
    expect(data.id).toBe(5);
    expect(data.from).toBe('A <a@b>');
    expect(data.subject).toBe('S');
    expect(data.received_at).toBe(1000);
  });

  it('returns error when id unknown', async () => {
    const tools = createTool({
      emailStore: mkStore([]),
      imapClient: mkImap(),
    });
    const get = tools.find((t) => t.name === 'emails_get')!;
    const res = await get.handler({ id: 999 });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it('returns error when account missing', async () => {
    const tools = createTool({
      emailStore: mkStore([mkRow(5, 5)]),
      imapClient: mkImap({ getAccount: () => null }),
    });
    const get = tools.find((t) => t.name === 'emails_get')!;
    const res = await get.handler({ id: 5 });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/account/i);
  });

  it('propagates IMAP fetch failure', async () => {
    const tools = createTool({
      emailStore: mkStore([mkRow(5, 5)]),
      imapClient: mkImap({
        fetchFullBody: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
    });
    const get = tools.find((t) => t.name === 'emails_get')!;
    const res = await get.handler({ id: 5 });
    expect(res.success).toBe(false);
    expect(res.error).toContain('boom');
  });
});
