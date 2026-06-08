import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  routeInteraction,
  type InteractionDeps,
} from '../channels/discord/interactions.js';
import {
  createDraftReplyService,
  type DraftState,
} from '../services/draft-reply-service.js';
import { createEmailSentLog } from '../emails/sent-log.js';
import { initDb, closeDb, getDb } from '../db.js';
import type { ImapAccount } from '../emails/types.js';

// Integration boundaries: real draftReplyService + real emailSentLog backed by
// an in-memory SQLite. Only smtpClient and the Discord interaction surface are
// mocked — the goal is to exercise the full hold-zone flow end-to-end and prove
// the modules actually compose, not to re-test branch coverage already nailed
// down by the per-module unit tests.

const SAMPLE_ACCOUNT: ImapAccount = {
  id: 'acc-1',
  host: 'imap.example.com',
  port: 993,
  user: 'me@example.com',
  password: 'secret',
  tls: true,
};

function sampleDraftState(overrides: Partial<DraftState> = {}): DraftState {
  return {
    pendingId: 'p1',
    originalUid: 42,
    accountId: 'acc-1',
    to: 'alice@example.com',
    subject: 'Re: Project status',
    inReplyTo: '<orig@example.com>',
    references: ['<root@example.com>', '<orig@example.com>'],
    body: 'Yes, shipping Friday.',
    ...overrides,
  };
}

function makeButton(overrides: Record<string, any> = {}) {
  const webhookEditMessage = vi.fn().mockResolvedValue(undefined);
  return {
    isButton: () => true,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isChatInputCommand: () => false,
    user: { id: 'user-1' },
    customId: 'email_draft:send:p1',
    createdTimestamp: Date.now(),
    deferReply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({ id: 'msg-99' }),
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
    webhook: { editMessage: webhookEditMessage },
    ...overrides,
  } as any;
}

function makeDeps(overrides: Partial<InteractionDeps>): InteractionDeps {
  const draftReplyService = createDraftReplyService({ pendingDrafts: new Map() });
  const emailSentLog = createEmailSentLog({ db: getDb() });
  const smtpClient = { sendReply: vi.fn().mockResolvedValue({ messageId: 'smtp-1' }) };
  const imapAccounts = new Map<string, ImapAccount>([['acc-1', SAMPLE_ACCOUNT]]);

  return {
    whitelist: new Set(['user-1']),
    reminderService: {} as any,
    permissionService: {} as any,
    planReviewService: {} as any,
    commandService: {} as any,
    cognitionService: {} as any,
    draftReplyService,
    smtpClient,
    imapAccounts,
    emailSentLog,
    emailSendHoldSeconds: 30,
    ...overrides,
  };
}

function fetchAllLog(): Array<{ action: string; draft_id: string; to_addr: string; subject: string; error_message: string | null }> {
  return getDb()
    .prepare(
      'SELECT action, draft_id, to_addr, subject, error_message FROM email_sent_log ORDER BY id',
    )
    .all() as any;
}

describe('email send hold zone — integration', () => {
  beforeEach(() => {
    initDb(':memory:');
  });
  afterEach(() => {
    vi.useRealTimers();
    closeDb();
  });

  it('hold success path: Send → "Will send at" + Cancel button + no SMTP yet, then timer fires → SMTP + "Sent" + one sent row', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const deps = makeDeps({ emailSendHoldSeconds: 30 });
    deps.draftReplyService!.put(sampleDraftState());

    const sendIxn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });
    await routeInteraction(sendIxn, deps);

    // Pre-fire assertions.
    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    expect(fetchAllLog()).toEqual([]);
    const editArg = sendIxn.editReply.mock.calls[sendIxn.editReply.mock.calls.length - 1][0];
    expect(editArg.content).toMatch(/Will send at \d{2}:\d{2}:\d{2}/);
    expect(editArg.components).toHaveLength(1);
    const cancelCustomId = editArg.components[0].components[0].data.custom_id;
    expect(cancelCustomId).toBe('email_draft:cancelSend:p1');

    // Advance past the hold (30s + a sliver to absorb microtask scheduling).
    await vi.advanceTimersByTimeAsync(30_100);

    expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
    expect(sendIxn.webhook.editMessage).toHaveBeenCalledWith(
      '@original',
      expect.objectContaining({
        content: expect.stringContaining('Sent'),
        components: [],
      }),
    );
    const rows = fetchAllLog();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'sent',
      draft_id: 'p1',
      to_addr: 'alice@example.com',
      subject: 'Re: Project status',
      error_message: null,
    });
    expect(deps.draftReplyService!.has('p1')).toBe(false);
  });

  it('cancel path: Send → Cancel → advance well past 30s → SMTP never called + "Cancelled" + one cancelled row', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const deps = makeDeps({ emailSendHoldSeconds: 30 });
    deps.draftReplyService!.put(sampleDraftState());

    const sendIxn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });
    await routeInteraction(sendIxn, deps);

    const cancelIxn = makeButton({ customId: 'email_draft:cancelSend:p1' });
    await routeInteraction(cancelIxn, deps);

    // Drive past the original hold window — clearTimeout must have killed the
    // scheduled callback, so SMTP should still be untouched.
    await vi.advanceTimersByTimeAsync(120_000);

    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    const cancelEdit = cancelIxn.editReply.mock.calls[cancelIxn.editReply.mock.calls.length - 1][0];
    expect(cancelEdit.content).toContain('Cancelled');
    expect(cancelEdit.components).toEqual([]);

    const rows = fetchAllLog();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'cancelled',
      draft_id: 'p1',
      to_addr: 'alice@example.com',
      subject: 'Re: Project status',
      error_message: null,
    });
    expect(deps.draftReplyService!.has('p1')).toBe(false);
  });

  it('bypass path: holdSeconds=0 → Send fires SMTP synchronously, no timer wait, one sent row', async () => {
    const deps = makeDeps({ emailSendHoldSeconds: 0 });
    deps.draftReplyService!.put(sampleDraftState());

    const sendIxn = makeButton({ customId: 'email_draft:send:p1' });
    await routeInteraction(sendIxn, deps);

    expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
    const editArg = sendIxn.editReply.mock.calls[sendIxn.editReply.mock.calls.length - 1][0];
    expect(editArg.content).toContain('Отправлено');
    expect(editArg.components).toEqual([]);

    const rows = fetchAllLog();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'sent',
      draft_id: 'p1',
      to_addr: 'alice@example.com',
      subject: 'Re: Project status',
      error_message: null,
    });
    expect(deps.draftReplyService!.has('p1')).toBe(false);
  });

  it('15-min pre-check: interaction created 14 min ago + hold=30 → refuse, drop state, no timer, no SMTP, no log row', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const deps = makeDeps({ emailSendHoldSeconds: 30 });
    deps.draftReplyService!.put(sampleDraftState());

    const sendIxn = makeButton({
      customId: 'email_draft:send:p1',
      // Only 1 min of ephemeral life left, less than hold(30) + 60s buffer.
      createdTimestamp: Date.now() - 14 * 60 * 1000,
    });
    await routeInteraction(sendIxn, deps);

    const editArg = sendIxn.editReply.mock.calls[sendIxn.editReply.mock.calls.length - 1][0];
    expect(editArg.content).toContain('истекает');
    expect(editArg.components).toEqual([]);
    expect(deps.draftReplyService!.has('p1')).toBe(false);

    // Even with a long advance no timer should fire — the handler must not
    // have armed one.
    await vi.advanceTimersByTimeAsync(120_000);
    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    expect(fetchAllLog()).toEqual([]);
  });
});
