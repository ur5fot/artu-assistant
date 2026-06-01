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
    fetchPendingUndelivered: vi.fn((_l: number) => rows),
    countPendingUndelivered: vi.fn(() => rows.length),
    countHandledSince: vi.fn((_s: number) => 0),
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
  it('returns JSON array of rows with full public shape', async () => {
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
    // Lock down the full emitted shape so renaming/dropping a field is caught.
    expect(data[0]).toMatchObject({
      id: 1,
      account_id: 'a',
      from: 'A <a@b>',
      subject: 'S',
      snippet: 'x',
      importance: 5,
      received_at: 1001,
      delivered: false,
    });
    expect(data[1].delivered).toBe(true);
  });

  it('honours limit (default 10, max 50)', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => mkRow(i + 1, 4));
    const store = mkStore(rows);
    const tools = createTool({ emailStore: store, imapClient: mkImap() });
    const list = tools.find((t) => t.name === 'emails_list')!;

    await list.handler({});
    expect(store.fetchInWindow).toHaveBeenLastCalledWith(720, 10, expect.any(Number));

    await list.handler({ limit: 500 });
    expect(store.fetchInWindow).toHaveBeenLastCalledWith(720, 50, expect.any(Number));
  });

  it('clamps since_hours to [1, 8760] and uses 720 as default', async () => {
    const store = mkStore([]);
    const tools = createTool({ emailStore: store, imapClient: mkImap() });
    const list = tools.find((t) => t.name === 'emails_list')!;

    await list.handler({});
    expect(store.fetchInWindow).toHaveBeenLastCalledWith(720, 10, expect.any(Number));

    await list.handler({ since_hours: 0 });
    expect(store.fetchInWindow).toHaveBeenLastCalledWith(1, 10, expect.any(Number));

    await list.handler({ since_hours: 99_999 });
    expect(store.fetchInWindow).toHaveBeenLastCalledWith(8760, 10, expect.any(Number));

    await list.handler({ since_hours: 8760 });
    expect(store.fetchInWindow).toHaveBeenLastCalledWith(8760, 10, expect.any(Number));

    await list.handler({ since_hours: 'abc' });
    expect(store.fetchInWindow).toHaveBeenLastCalledWith(720, 10, expect.any(Number));
  });

  it('returns error when emailStore is null', async () => {
    const tools = createTool({ emailStore: null, imapClient: mkImap() });
    const list = tools.find((t) => t.name === 'emails_list')!;
    const res = await list.handler({});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/email/i);
  });
});

describe('emails_status tool', () => {
  it('returns awaiting list (any age) plus awaiting_count and handled_last_7d', async () => {
    const store = mkStore([mkRow(1, 5), mkRow(2, 4)]);
    vi.mocked(store.countHandledSince).mockReturnValue(7);
    const tools = createTool({ emailStore: store, imapClient: mkImap() });
    const status = tools.find((t) => t.name === 'emails_status')!;
    const res = await status.handler({});
    expect(res.success).toBe(true);
    const data = res.data as Record<string, unknown>;
    expect(data.awaiting_count).toBe(2);
    expect(data.handled_last_7d).toBe(7);
    const awaiting = data.awaiting as Array<Record<string, unknown>>;
    expect(awaiting).toHaveLength(2);
    expect(awaiting[0]).toMatchObject({ id: 1, from: 'A <a@b>', subject: 'S', importance: 5 });
  });

  it('honours limit (default 10, max 50) for the awaiting list', async () => {
    const store = mkStore([]);
    const tools = createTool({ emailStore: store, imapClient: mkImap() });
    const status = tools.find((t) => t.name === 'emails_status')!;

    await status.handler({});
    expect(store.fetchPendingUndelivered).toHaveBeenLastCalledWith(10);

    await status.handler({ limit: 500 });
    expect(store.fetchPendingUndelivered).toHaveBeenLastCalledWith(50);
  });

  it('counts handled emails over a ~7 day window', async () => {
    const store = mkStore([]);
    const tools = createTool({ emailStore: store, imapClient: mkImap() });
    const status = tools.find((t) => t.name === 'emails_status')!;
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const before = Date.now();
    await status.handler({});
    const after = Date.now();
    const arg = vi.mocked(store.countHandledSince).mock.lastCall![0];
    expect(arg).toBeGreaterThanOrEqual(before - SEVEN_DAYS);
    expect(arg).toBeLessThanOrEqual(after - SEVEN_DAYS);
  });

  it('returns error when emailStore is null', async () => {
    const tools = createTool({ emailStore: null, imapClient: mkImap() });
    const status = tools.find((t) => t.name === 'emails_status')!;
    const res = await status.handler({});
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
    // emails_get returns a structured object (matches emails_list's shape).
    const data = res.data as Record<string, unknown>;
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

  it('rejects invalid ids (0, negative, non-numeric, missing)', async () => {
    const tools = createTool({
      emailStore: mkStore([mkRow(5, 5)]),
      imapClient: mkImap(),
    });
    const get = tools.find((t) => t.name === 'emails_get')!;

    for (const bad of [0, -1, 'abc', NaN, undefined] as unknown[]) {
      const res = await get.handler(bad === undefined ? {} : { id: bad });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/positive number/i);
    }
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
