import { describe, it, expect, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import {
  parseFromAddress,
  routeInteraction,
  type InteractionDeps,
} from '../interactions.js';
import { createDraftReplyService } from '../../../services/draft-reply-service.js';
import type { EmailStore } from '../../../emails/store.js';
import type { EmailPendingRow, ImapAccount, NewMessage } from '../../../emails/types.js';
import type { MessageHeaders } from '../../../emails/imap-client.js';

const SAMPLE_ROW: EmailPendingRow = {
  id: 7,
  account_id: 'acc-1',
  message_uid: 42,
  from_addr: 'Alice <alice@example.com>',
  subject: 'Project status',
  snippet: 'Hey, any update?',
  importance: 5,
  received_at: 1_700_000_000_000,
  added_at: 1_700_000_001_000,
  delivered_at: null,
  urgent_pinged_at: 1_700_000_002_000,
};

const SAMPLE_ACCOUNT: ImapAccount = {
  id: 'acc-1',
  host: 'imap.example.com',
  port: 993,
  user: 'me@example.com',
  password: 'secret',
  tls: true,
};

const SAMPLE_HEADERS: MessageHeaders = {
  messageId: '<orig@example.com>',
  inReplyTo: null,
  references: ['<root@example.com>'],
};

const SAMPLE_THREAD: NewMessage[] = [
  { uid: 30, from: 'Alice', subject: 'Project status', snippet: 'kickoff', receivedAt: 1 },
  { uid: 42, from: 'Alice', subject: 'Project status', snippet: 'Hey, any update?', receivedAt: 2 },
];

function makeDeps(overrides: Partial<InteractionDeps> = {}): InteractionDeps {
  const emailStore = {
    findByPendingId: vi.fn().mockReturnValue(SAMPLE_ROW),
  } as unknown as EmailStore;
  const imapClient = {
    fetchHeaders: vi.fn().mockResolvedValue(SAMPLE_HEADERS),
  };
  const threadFetcher = {
    fetchThread: vi.fn().mockResolvedValue(SAMPLE_THREAD),
  };
  const anthropic = {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Yes, shipping Friday.' }],
      }),
    },
  } as any;
  const imapAccounts = new Map<string, ImapAccount>([['acc-1', SAMPLE_ACCOUNT]]);
  const draftReplyService = createDraftReplyService({ pendingDrafts: new Map() });

  return {
    whitelist: new Set(['user-1']),
    reminderService: {} as any,
    permissionService: {} as any,
    planReviewService: {} as any,
    commandService: {} as any,
    cognitionService: {} as any,
    draftReplyService,
    emailStore,
    imapClient,
    threadFetcher,
    anthropic,
    imapAccounts,
    ...overrides,
  };
}

function makeButton(overrides: Record<string, any> = {}) {
  return {
    isButton: () => true,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    user: { id: 'user-1' },
    customId: 'email_draft:start:7',
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('parseFromAddress', () => {
  it('extracts address from "Name <addr>"', () => {
    expect(parseFromAddress('Alice <alice@example.com>')).toBe('alice@example.com');
  });
  it('returns bare address as-is', () => {
    expect(parseFromAddress('alice@example.com')).toBe('alice@example.com');
  });
  it('trims whitespace', () => {
    expect(parseFromAddress('  bob@example.com  ')).toBe('bob@example.com');
  });
});

describe('email_draft:start — happy path', () => {
  it('defers, loads row, fetches headers + thread, calls Claude, edits reply with buttons', async () => {
    const deps = makeDeps();
    const ixn = makeButton();
    await routeInteraction(ixn, deps);

    expect(ixn.deferReply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    expect((deps.emailStore as any).findByPendingId).toHaveBeenCalledWith(7);
    expect((deps.imapClient as any).fetchHeaders).toHaveBeenCalledWith(SAMPLE_ACCOUNT, 42);
    expect((deps.threadFetcher as any).fetchThread).toHaveBeenCalledWith(SAMPLE_ACCOUNT, 42);
    expect((deps.anthropic as any).messages.create).toHaveBeenCalledTimes(1);

    expect(ixn.editReply).toHaveBeenCalledTimes(1);
    const editArg = ixn.editReply.mock.calls[0]![0];
    expect(editArg.content).toContain('Yes, shipping Friday.');
    expect(editArg.components).toHaveLength(1);
    const row = editArg.components[0];
    const customIds = row.components.map((c: any) => c.data.custom_id);
    expect(customIds).toEqual([
      expect.stringMatching(/^email_draft:send:/),
      expect.stringMatching(/^email_draft:edit:/),
      expect.stringMatching(/^email_draft:cancel:/),
    ]);
  });

  it('stores draft state with parsed to-address and ordered references', async () => {
    const deps = makeDeps();
    const putSpy = vi.spyOn(deps.draftReplyService!, 'put');
    const ixn = makeButton();
    await routeInteraction(ixn, deps);

    expect(putSpy).toHaveBeenCalledTimes(1);
    const state = putSpy.mock.calls[0]![0];
    expect(state.accountId).toBe('acc-1');
    expect(state.originalUid).toBe(42);
    expect(state.to).toBe('alice@example.com');
    expect(state.subject).toBe('Project status');
    expect(state.inReplyTo).toBe('<orig@example.com>');
    expect(state.references).toEqual(['<root@example.com>', '<orig@example.com>']);
    expect(state.body).toBe('Yes, shipping Friday.');
    expect(typeof state.pendingId).toBe('string');
    expect(state.pendingId.length).toBeGreaterThan(0);
  });
});

describe('email_draft:start — error paths', () => {
  it('row not found → editReply "пропало", no Claude call', async () => {
    const deps = makeDeps({
      emailStore: { findByPendingId: vi.fn().mockReturnValue(null) } as unknown as EmailStore,
    });
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('пропало') }),
    );
    expect((deps.anthropic as any).messages.create).not.toHaveBeenCalled();
  });

  it('account missing → editReply with account error, no IMAP call', async () => {
    const deps = makeDeps({ imapAccounts: new Map() });
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('acc-1') }),
    );
    expect((deps.imapClient as any).fetchHeaders).not.toHaveBeenCalled();
  });

  it('thread fetch fails → editReply with error, no Claude call', async () => {
    const deps = makeDeps({
      threadFetcher: { fetchThread: vi.fn().mockRejectedValue(new Error('imap down')) },
    });
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('загрузить тред'),
      }),
    );
    expect((deps.anthropic as any).messages.create).not.toHaveBeenCalled();
  });

  it('Claude returns empty → editReply "не удалось сгенерировать"', async () => {
    const deps = makeDeps({
      anthropic: {
        messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '' }] }) },
      } as any,
    });
    const putSpy = vi.spyOn(deps.draftReplyService!, 'put');
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('сгенерировать') }),
    );
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('Claude throws → editReply with error', async () => {
    const deps = makeDeps({
      anthropic: {
        messages: { create: vi.fn().mockRejectedValue(new Error('rate limit')) },
      } as any,
    });
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('rate limit') }),
    );
  });

  it('deps not configured → ephemeral reply, no defer', async () => {
    const deps = makeDeps({ draftReplyService: undefined });
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('not configured'),
      }),
    );
    expect(ixn.deferReply).not.toHaveBeenCalled();
  });

  it('non-whitelisted user is rejected', async () => {
    const deps = makeDeps();
    const ixn = makeButton({ user: { id: 'evil' } });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    expect((deps.emailStore as any).findByPendingId).not.toHaveBeenCalled();
  });
});
