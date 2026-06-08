import { describe, it, expect, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { routeInteraction, type InteractionDeps } from '../interactions.js';
import type { EmailStore } from '../../../emails/store.js';
import type { EmailPendingRow } from '../../../emails/types.js';

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
