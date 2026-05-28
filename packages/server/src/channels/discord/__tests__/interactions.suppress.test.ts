import { describe, it, expect, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { routeInteraction, type InteractionDeps } from '../interactions.js';
import type { EmailStore } from '../../../emails/store.js';
import type { EmailSuppressionStore } from '../../../emails/suppression-store.js';
import type { EmailPendingRow } from '../../../emails/types.js';

const SAMPLE_ROW: EmailPendingRow = {
  id: 7,
  account_id: 'acc-1',
  message_uid: 42,
  from_addr: 'alerts@bank.com',
  subject: 'Large transaction notice',
  snippet: 'snip',
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

  // Default fake: echo back ttl_days as expires_at offset; ttl_days=null → null.
  const insertRule = vi.fn().mockImplementation(
    ({ ttl_days }: { ttl_days: number | null }) => ({
      id: 1,
      expires_at: ttl_days === null ? null : 1_700_000_500_000 + ttl_days * 86_400_000,
    }),
  );
  const emailSuppressionStore = {
    insertRule,
    findActiveMatch: vi.fn(),
    listActive: vi.fn(),
    deleteRule: vi.fn(),
  } as unknown as EmailSuppressionStore;

  return {
    whitelist: new Set(['user-1']),
    reminderService: {} as any,
    permissionService: {} as any,
    planReviewService: {} as any,
    commandService: {} as any,
    cognitionService: {} as any,
    emailStore,
    emailSuppressionStore,
    ...overrides,
  };
}

function makeButton(overrides: Record<string, any> = {}) {
  return {
    isButton: () => true,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    user: { id: 'user-1' },
    customId: 'email_suppress:sender_start:7',
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('email_suppress:sender_start', () => {
  it('missing row → ephemeral "недоступно" message, no insertRule call', async () => {
    const deps = makeDeps({
      emailStore: {
        findByPendingId: vi.fn().mockReturnValue(null),
      } as unknown as EmailStore,
    });
    const ixn = makeButton({ customId: 'email_suppress:sender_start:7' });

    await routeInteraction(ixn, deps);

    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('недоступно'),
      }),
    );
    expect((deps.emailSuppressionStore as any).insertRule).not.toHaveBeenCalled();
  });

  it('invalid rowId → ephemeral "Некорректная" message, no DB read', async () => {
    const deps = makeDeps();
    const ixn = makeButton({ customId: 'email_suppress:sender_start:not-a-number' });

    await routeInteraction(ixn, deps);

    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('Некорректная'),
      }),
    );
    expect((deps.emailStore as any).findByPendingId).not.toHaveBeenCalled();
  });

  it('valid row → ephemeral with 4 TTL buttons (1d / 7d / 30d / forever)', async () => {
    const deps = makeDeps();
    const ixn = makeButton({ customId: 'email_suppress:sender_start:7' });

    await routeInteraction(ixn, deps);

    expect(ixn.reply).toHaveBeenCalledTimes(1);
    const arg = ixn.reply.mock.calls[0]![0];
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
    expect(arg.content).toContain('alerts@bank.com');
    expect(arg.components).toHaveLength(1);
    const buttons = arg.components[0].toJSON().components as any[];
    expect(buttons).toHaveLength(4);
    expect(buttons.map((b) => b.custom_id)).toEqual([
      'email_suppress:sender_set_ttl:7:1',
      'email_suppress:sender_set_ttl:7:7',
      'email_suppress:sender_set_ttl:7:30',
      'email_suppress:sender_set_ttl:7:0',
    ]);
    expect(buttons.map((b) => b.label)).toEqual(['1d', '7d', '30d', 'forever']);
  });

  it('emailStore not configured → ephemeral "not configured"', async () => {
    const deps = makeDeps({ emailStore: undefined });
    const ixn = makeButton({ customId: 'email_suppress:sender_start:7' });

    await routeInteraction(ixn, deps);

    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('not configured'),
      }),
    );
  });

  it('non-whitelisted user is rejected', async () => {
    const deps = makeDeps();
    const ixn = makeButton({
      customId: 'email_suppress:sender_start:7',
      user: { id: 'evil' },
    });

    await routeInteraction(ixn, deps);

    // Whitelist guard short-circuits before touching the store.
    expect((deps.emailStore as any).findByPendingId).not.toHaveBeenCalled();
    expect((deps.emailSuppressionStore as any).insertRule).not.toHaveBeenCalled();
  });
});

describe('email_suppress:sender_set_ttl', () => {
  it('ttl=7 → insertRule called with ttl_days=7 + sender pattern, ephemeral confirmation', async () => {
    const deps = makeDeps();
    const ixn = makeButton({ customId: 'email_suppress:sender_set_ttl:7:7' });

    await routeInteraction(ixn, deps);

    expect((deps.emailSuppressionStore as any).insertRule).toHaveBeenCalledTimes(1);
    expect((deps.emailSuppressionStore as any).insertRule).toHaveBeenCalledWith({
      rule_type: 'sender',
      pattern: 'alerts@bank.com',
      ttl_days: 7,
    });
    expect(ixn.update).toHaveBeenCalledTimes(1);
    const arg = ixn.update.mock.calls[0]![0];
    expect(arg.content).toContain('alerts@bank.com');
    expect(arg.content).toContain('Заглушён');
    expect(arg.content).not.toContain('навсегда');
    expect(arg.components).toEqual([]);
  });

  it('ttl=1 → insertRule called with ttl_days=1', async () => {
    const deps = makeDeps();
    const ixn = makeButton({ customId: 'email_suppress:sender_set_ttl:7:1' });

    await routeInteraction(ixn, deps);

    expect((deps.emailSuppressionStore as any).insertRule).toHaveBeenCalledWith({
      rule_type: 'sender',
      pattern: 'alerts@bank.com',
      ttl_days: 1,
    });
  });

  it('ttl=0 (forever) → insertRule called with ttl_days=null, ephemeral shows "навсегда"', async () => {
    const deps = makeDeps();
    const ixn = makeButton({ customId: 'email_suppress:sender_set_ttl:7:0' });

    await routeInteraction(ixn, deps);

    expect((deps.emailSuppressionStore as any).insertRule).toHaveBeenCalledWith({
      rule_type: 'sender',
      pattern: 'alerts@bank.com',
      ttl_days: null,
    });
    const arg = ixn.update.mock.calls[0]![0];
    expect(arg.content).toContain('навсегда');
    expect(arg.components).toEqual([]);
  });

  it('missing row → ephemeral "недоступно", no insertRule call', async () => {
    const deps = makeDeps({
      emailStore: {
        findByPendingId: vi.fn().mockReturnValue(null),
      } as unknown as EmailStore,
    });
    const ixn = makeButton({ customId: 'email_suppress:sender_set_ttl:7:7' });

    await routeInteraction(ixn, deps);

    expect((deps.emailSuppressionStore as any).insertRule).not.toHaveBeenCalled();
    const arg = ixn.update.mock.calls[0]![0];
    expect(arg.content).toContain('недоступно');
    expect(arg.components).toEqual([]);
  });

  it('malformed rawId (no colon) → "Некорректная", no DB call', async () => {
    const deps = makeDeps();
    const ixn = makeButton({ customId: 'email_suppress:sender_set_ttl:7' });

    await routeInteraction(ixn, deps);

    expect((deps.emailStore as any).findByPendingId).not.toHaveBeenCalled();
    expect((deps.emailSuppressionStore as any).insertRule).not.toHaveBeenCalled();
    const arg = ixn.update.mock.calls[0]![0];
    expect(arg.content).toContain('Некорректная');
  });

  it('suppressionStore not configured → ephemeral "not configured"', async () => {
    const deps = makeDeps({ emailSuppressionStore: undefined });
    const ixn = makeButton({ customId: 'email_suppress:sender_set_ttl:7:7' });

    await routeInteraction(ixn, deps);

    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('not configured'),
      }),
    );
  });
});

describe('embed renders email_suppress buttons', () => {
  it('buildUrgentEmailEmbed includes sender_start and subject_start buttons', async () => {
    // The embed-level test lives here (rather than embeds.test.ts) to keep the
    // Task 4 deliverable cohesive: the buttons + their interaction wiring are
    // verified together.
    const { buildUrgentEmailEmbed } = await import('../embeds.js');
    const { components } = buildUrgentEmailEmbed({
      id: 42,
      account_id: 'a',
      message_uid: 1,
      from_addr: 'boss@acme.com',
      subject: 'Server down',
      snippet: '',
      importance: 5,
      received_at: 1000,
      added_at: 1000,
      delivered_at: null,
      urgent_pinged_at: null,
    });
    const ids = components[0]!.buttons.map((b) => b.customId);
    expect(ids).toContain('email_suppress:sender_start:42');
    expect(ids).toContain('email_suppress:subject_start:42');
  });
});
