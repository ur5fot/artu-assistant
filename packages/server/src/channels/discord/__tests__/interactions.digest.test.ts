import { describe, it, expect, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { routeInteraction, type InteractionDeps } from '../interactions.js';
import type { EmailStore } from '../../../emails/store.js';
import type { EmailPendingRow, FullMessage, ImapAccount } from '../../../emails/types.js';

const SAMPLE_ROW: EmailPendingRow = {
  id: 7,
  account_id: 'acc-1',
  message_uid: 42,
  from_addr: 'alerts@bank.com',
  subject: 'Large transaction notice',
  snippet: 'Your account was charged 100 USD',
  importance: 5,
  received_at: 1_700_000_000_000,
  added_at: 1_700_000_001_000,
  delivered_at: null,
  urgent_pinged_at: null,
  gist: null,
};

function makeDeps(overrides: Partial<InteractionDeps> = {}): InteractionDeps {
  const emailStore = {
    findByPendingId: vi.fn().mockReturnValue(SAMPLE_ROW),
  } as unknown as EmailStore;

  return {
    whitelist: new Set(['user-1']),
    reminderService: {} as any,
    permissionService: {} as any,
    planReviewService: {} as any,
    commandService: {} as any,
    cognitionService: {} as any,
    emailStore,
    ...overrides,
  };
}

function makeSelectMenu(overrides: Record<string, any> = {}) {
  return {
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    user: { id: 'user-1' },
    customId: 'email_digest:pick',
    values: ['7'],
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('email_digest:pick (select menu → action card)', () => {
  it('valid pick → ephemeral card with all 5 action buttons', async () => {
    const deps = makeDeps();
    const ixn = makeSelectMenu();

    await routeInteraction(ixn, deps);

    expect(ixn.reply).toHaveBeenCalledTimes(1);
    const arg = ixn.reply.mock.calls[0]![0];
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
    expect(arg.content).toContain('alerts@bank.com');
    expect(arg.content).toContain('Large transaction notice');
    expect(arg.content).toContain('Your account was charged 100 USD');
    expect(arg.components).toHaveLength(1);
    const buttons = arg.components[0].toJSON().components as any[];
    expect(buttons.map((b) => b.custom_id)).toEqual([
      'email_digest:dismiss:7',
      'email_draft:start:7',
      'email_suppress:sender_start:7',
      'email_suppress:subject_start:7',
      'email_digest:fulltext:7',
    ]);
  });

  it('email-controlled @everyone text → reply suppresses mentions', async () => {
    const deps = makeDeps({
      emailStore: {
        findByPendingId: vi.fn().mockReturnValue({
          ...SAMPLE_ROW,
          from_addr: '@everyone',
          subject: 'ping @here now',
        }),
      } as unknown as EmailStore,
    });
    const ixn = makeSelectMenu();

    await routeInteraction(ixn, deps);

    const arg = ixn.reply.mock.calls[0]![0];
    expect(arg.content).toContain('@everyone');
    expect(arg.allowedMentions).toEqual({ parse: [] });
  });

  it('missing row → ephemeral "недоступно", no card buttons', async () => {
    const deps = makeDeps({
      emailStore: {
        findByPendingId: vi.fn().mockReturnValue(null),
      } as unknown as EmailStore,
    });
    const ixn = makeSelectMenu();

    await routeInteraction(ixn, deps);

    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('недоступно'),
      }),
    );
    const arg = ixn.reply.mock.calls[0]![0];
    expect(arg.components).toBeUndefined();
  });

  it('non-numeric value → ephemeral "Некорректная", no DB read', async () => {
    const deps = makeDeps();
    const ixn = makeSelectMenu({ values: ['not-a-number'] });

    await routeInteraction(ixn, deps);

    expect((deps.emailStore as any).findByPendingId).not.toHaveBeenCalled();
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('Некорректная'),
      }),
    );
  });

  it('empty values array → guarded, no DB read', async () => {
    const deps = makeDeps();
    const ixn = makeSelectMenu({ values: [] });

    await routeInteraction(ixn, deps);

    expect((deps.emailStore as any).findByPendingId).not.toHaveBeenCalled();
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Некорректная'),
      }),
    );
  });

  it('emailStore not configured → ephemeral "not configured"', async () => {
    const deps = makeDeps({ emailStore: undefined });
    const ixn = makeSelectMenu();

    await routeInteraction(ixn, deps);

    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('not configured'),
      }),
    );
  });

  it('non-whitelisted user is rejected before store access', async () => {
    const deps = makeDeps();
    const ixn = makeSelectMenu({ user: { id: 'evil' } });

    await routeInteraction(ixn, deps);

    expect((deps.emailStore as any).findByPendingId).not.toHaveBeenCalled();
  });
});

const SAMPLE_ACCOUNT: ImapAccount = {
  id: 'acc-1',
  host: 'imap.example.com',
  port: 993,
  user: 'me@example.com',
  password: 'secret',
  tls: true,
};

const SAMPLE_FULL: FullMessage = {
  uid: 42,
  from: 'alerts@bank.com',
  subject: 'Large transaction notice',
  bodyText: 'Hello, world. Your card was charged.',
  receivedAt: 1_700_000_000_000,
};

function makeButton(overrides: Record<string, any> = {}) {
  return {
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    user: { id: 'user-1' },
    customId: 'email_digest:dismiss:7',
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('email_digest:dismiss (Разобрать button)', () => {
  it('awaiting row → markDelivered + "✓ Разобрано"', async () => {
    const markDelivered = vi.fn();
    const deps = makeDeps({
      emailStore: {
        findByPendingId: vi.fn().mockReturnValue(SAMPLE_ROW),
        markDelivered,
      } as unknown as EmailStore,
    });
    const ixn = makeButton();

    await routeInteraction(ixn, deps);

    expect(markDelivered).toHaveBeenCalledWith([7], expect.any(Number));
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('Разобрано'),
      }),
    );
  });

  it('already-delivered row → idempotent "Уже разобрано", no markDelivered', async () => {
    const markDelivered = vi.fn();
    const deps = makeDeps({
      emailStore: {
        findByPendingId: vi
          .fn()
          .mockReturnValue({ ...SAMPLE_ROW, delivered_at: 123 }),
        markDelivered,
      } as unknown as EmailStore,
    });
    const ixn = makeButton();

    await routeInteraction(ixn, deps);

    expect(markDelivered).not.toHaveBeenCalled();
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Уже разобрано') }),
    );
  });

  it('positively urgent-pinged row → "Уже разобрано", no markDelivered', async () => {
    const markDelivered = vi.fn();
    const deps = makeDeps({
      emailStore: {
        findByPendingId: vi
          .fn()
          .mockReturnValue({ ...SAMPLE_ROW, urgent_pinged_at: 999 }),
        markDelivered,
      } as unknown as EmailStore,
    });
    const ixn = makeButton();

    await routeInteraction(ixn, deps);

    expect(markDelivered).not.toHaveBeenCalled();
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Уже разобрано') }),
    );
  });

  it('missing row → "недоступно"', async () => {
    const deps = makeDeps({
      emailStore: {
        findByPendingId: vi.fn().mockReturnValue(null),
        markDelivered: vi.fn(),
      } as unknown as EmailStore,
    });
    const ixn = makeButton();

    await routeInteraction(ixn, deps);

    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('недоступно') }),
    );
  });

  it('non-numeric id → "Некорректная", no DB read', async () => {
    const deps = makeDeps({
      emailStore: {
        findByPendingId: vi.fn(),
        markDelivered: vi.fn(),
      } as unknown as EmailStore,
    });
    const ixn = makeButton({ customId: 'email_digest:dismiss:abc' });

    await routeInteraction(ixn, deps);

    expect((deps.emailStore as any).findByPendingId).not.toHaveBeenCalled();
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Некорректная') }),
    );
  });
});

describe('email_digest:fulltext (Полный текст button)', () => {
  function fullTextDeps(overrides: Partial<InteractionDeps> = {}): InteractionDeps {
    return makeDeps({
      emailStore: {
        findByPendingId: vi.fn().mockReturnValue(SAMPLE_ROW),
      } as unknown as EmailStore,
      imapClient: {
        fetchHeaders: vi.fn(),
        fetchFullBody: vi.fn().mockResolvedValue(SAMPLE_FULL),
      } as any,
      imapAccounts: new Map<string, ImapAccount>([['acc-1', SAMPLE_ACCOUNT]]),
      ...overrides,
    });
  }

  it('valid id → defers then editReply with subject + body', async () => {
    const deps = fullTextDeps();
    const ixn = makeButton({ customId: 'email_digest:fulltext:7' });

    await routeInteraction(ixn, deps);

    expect(ixn.deferReply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    expect((deps.imapClient as any).fetchFullBody).toHaveBeenCalledWith(
      SAMPLE_ACCOUNT,
      42,
    );
    const arg = ixn.editReply.mock.calls[0]![0];
    expect(arg.content).toContain('Large transaction notice');
    expect(arg.content).toContain('Hello, world');
  });

  it('email-controlled @everyone body → editReply suppresses mentions', async () => {
    const deps = fullTextDeps({
      imapClient: {
        fetchHeaders: vi.fn(),
        fetchFullBody: vi.fn().mockResolvedValue({
          ...SAMPLE_FULL,
          subject: 'alert @everyone',
          bodyText: 'Hey @here, your card was charged.',
        }),
      } as any,
    });
    const ixn = makeButton({ customId: 'email_digest:fulltext:7' });

    await routeInteraction(ixn, deps);

    const arg = ixn.editReply.mock.calls[0]![0];
    expect(arg.content).toContain('@everyone');
    expect(arg.allowedMentions).toEqual({ parse: [] });
  });

  it('missing row → editReply "пропало"', async () => {
    const deps = fullTextDeps({
      emailStore: {
        findByPendingId: vi.fn().mockReturnValue(null),
      } as unknown as EmailStore,
    });
    const ixn = makeButton({ customId: 'email_digest:fulltext:7' });

    await routeInteraction(ixn, deps);

    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('пропало') }),
    );
  });

  it('IMAP error → editReply error notice (no throw)', async () => {
    const deps = fullTextDeps({
      imapClient: {
        fetchHeaders: vi.fn(),
        fetchFullBody: vi.fn().mockRejectedValue(new Error('connection reset')),
      } as any,
    });
    const ixn = makeButton({ customId: 'email_digest:fulltext:7' });

    await routeInteraction(ixn, deps);

    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('connection reset') }),
    );
  });

  it('non-numeric id → "Некорректная" before defer/DB read', async () => {
    const deps = fullTextDeps();
    const ixn = makeButton({ customId: 'email_digest:fulltext:nope' });

    await routeInteraction(ixn, deps);

    expect(ixn.deferReply).not.toHaveBeenCalled();
    expect((deps.emailStore as any).findByPendingId).not.toHaveBeenCalled();
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Некорректная') }),
    );
  });

  it('fetchFullBody not wired → "not configured"', async () => {
    const deps = fullTextDeps({
      imapClient: { fetchHeaders: vi.fn() } as any,
    });
    const ixn = makeButton({ customId: 'email_digest:fulltext:7' });

    await routeInteraction(ixn, deps);

    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('not configured') }),
    );
  });
});
