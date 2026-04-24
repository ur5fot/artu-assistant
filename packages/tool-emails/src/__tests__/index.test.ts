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
