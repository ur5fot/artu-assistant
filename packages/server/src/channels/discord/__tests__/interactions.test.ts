import { describe, it, expect, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { routeInteraction } from '../interactions.js';
import type { ReminderService } from '../../../services/reminder-service.js';
import type { PermissionService } from '../../../services/permission-service.js';
import type { PlanReviewService } from '../../../services/plan-review-service.js';
import type { CommandService } from '../../../services/command-service.js';

function makeDeps(overrides: Partial<Parameters<typeof routeInteraction>[1]> = {}) {
  return {
    whitelist: new Set(['user-1']),
    reminderService: {
      dismiss: vi.fn().mockReturnValue({ ok: true }),
      snooze: vi.fn().mockReturnValue({ ok: true, snoozedId: 42 }),
      list: vi.fn().mockReturnValue([]),
    } as unknown as ReminderService,
    permissionService: {
      hasPending: vi.fn().mockReturnValue(true),
      resolveConfirm: vi.fn().mockReturnValue({ ok: true }),
    } as unknown as PermissionService,
    planReviewService: {
      hasPending: vi.fn().mockReturnValue(true),
      resolveReview: vi.fn().mockReturnValue({ ok: true }),
    } as unknown as PlanReviewService,
    commandService: {
      clearHistory: vi.fn().mockReturnValue({ deleted: 0 }),
      status: vi.fn().mockReturnValue({
        model: 'm', uptimeSeconds: 0, activeReminders: 0, pendingPermissions: 0,
      }),
      listReminders: vi.fn().mockReturnValue([]),
      listMemory: vi.fn().mockResolvedValue({ available: false, entries: [] }),
    } as unknown as CommandService,
    ...overrides,
  };
}

function makeButtonInteraction(overrides: Record<string, any> = {}) {
  return {
    isButton: () => true,
    isChatInputCommand: () => false,
    user: { id: 'user-1' },
    customId: 'reminder:dismiss:7',
    update: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('routeInteraction — reminder buttons', () => {
  it('rejects non-whitelisted user with ephemeral reply', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({ user: { id: 'evil' } });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
    expect(deps.reminderService.dismiss).not.toHaveBeenCalled();
  });

  it('reminder:dismiss calls service, updates message', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({ customId: 'reminder:dismiss:7' });
    await routeInteraction(ixn, deps);
    expect(deps.reminderService.dismiss).toHaveBeenCalledWith(7);
    expect(ixn.update).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it('reminder:snooze calls service, updates message', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({ customId: 'reminder:snooze:7' });
    await routeInteraction(ixn, deps);
    expect(deps.reminderService.snooze).toHaveBeenCalledWith(7);
    expect(ixn.update).toHaveBeenCalled();
  });

  it('reminder:dismiss not_found: update to expired footer', async () => {
    const deps = makeDeps({
      reminderService: {
        dismiss: vi.fn().mockReturnValue({ ok: false, reason: 'not_found' }),
        snooze: vi.fn(),
        list: vi.fn(),
      } as unknown as ReminderService,
    });
    const ixn = makeButtonInteraction({ customId: 'reminder:dismiss:7' });
    await routeInteraction(ixn, deps);
    expect(ixn.update).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });
});

describe('routeInteraction — permission buttons', () => {
  it('perm:allow_once resolves with allowed=true, remember=false', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({
      customId: 'perm:allow_once:call-42',
      message: { embeds: [{ title: '🔐 Permission request', description: 'Tool: x' }] },
    });
    await routeInteraction(ixn, deps);
    expect(deps.permissionService.resolveConfirm).toHaveBeenCalledWith('call-42', true, false);
    expect(ixn.update).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it('perm:allow_always resolves with allowed=true, remember=true', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({
      customId: 'perm:allow_always:call-42',
      message: { embeds: [{}] },
    });
    await routeInteraction(ixn, deps);
    expect(deps.permissionService.resolveConfirm).toHaveBeenCalledWith('call-42', true, true);
  });

  it('perm:deny resolves with allowed=false', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({
      customId: 'perm:deny:call-42',
      message: { embeds: [{}] },
    });
    await routeInteraction(ixn, deps);
    expect(deps.permissionService.resolveConfirm).toHaveBeenCalledWith('call-42', false, false);
  });

  it('perm:* — expired when service has no pending entry', async () => {
    const deps = makeDeps({
      permissionService: {
        hasPending: vi.fn().mockReturnValue(false),
        resolveConfirm: vi.fn(),
      } as unknown as PermissionService,
    });
    const ixn = makeButtonInteraction({
      customId: 'perm:allow_once:gone',
      message: { embeds: [{}] },
    });
    await routeInteraction(ixn, deps);
    expect(deps.permissionService.resolveConfirm).not.toHaveBeenCalled();
    expect(ixn.update).toHaveBeenCalled();
  });
});

describe('routeInteraction — plan review buttons', () => {
  it('plan:approve resolves', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({ customId: 'plan:approve:pp-1', message: { embeds: [{}] } });
    await routeInteraction(ixn, deps);
    expect(deps.planReviewService.resolveReview).toHaveBeenCalledWith('pp-1', true);
  });
  it('plan:reject resolves', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({ customId: 'plan:reject:pp-1', message: { embeds: [{}] } });
    await routeInteraction(ixn, deps);
    expect(deps.planReviewService.resolveReview).toHaveBeenCalledWith('pp-1', false);
  });
});

function makeSlashInteraction(overrides: Record<string, any> = {}) {
  return {
    isButton: () => false,
    isChatInputCommand: () => true,
    user: { id: 'user-1' },
    commandName: 'status',
    options: { getString: vi.fn().mockReturnValue(null) },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('routeInteraction — slash commands', () => {
  it('/status: ephemeral reply with status info', async () => {
    const deps = makeDeps();
    const ixn = makeSlashInteraction({ commandName: 'status' });
    await routeInteraction(ixn, deps);
    expect(deps.commandService.status).toHaveBeenCalled();
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });

  it('/reminders: ephemeral list', async () => {
    const deps = makeDeps({
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(),
        listReminders: vi.fn().mockReturnValue([
          { id: 1, text: 'a', next_fire_at_ms: 1000 },
        ]),
        listMemory: vi.fn().mockResolvedValue({ available: false, entries: [] }),
      } as any,
    });
    const ixn = makeSlashInteraction({ commandName: 'reminders' });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral, content: expect.stringContaining('a') }),
    );
  });

  it('/memory with query: calls listMemory with query', async () => {
    const deps = makeDeps();
    const ixn = makeSlashInteraction({
      commandName: 'memory',
      options: { getString: vi.fn().mockReturnValue('hello') },
    });
    await routeInteraction(ixn, deps);
    expect(deps.commandService.listMemory).toHaveBeenCalledWith('hello');
  });

  it('/clear: ephemeral confirm with Yes/No buttons', async () => {
    const deps = makeDeps();
    const ixn = makeSlashInteraction({ commandName: 'clear' });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('Clear'),
        components: expect.any(Array),
      }),
    );
    expect(deps.commandService.clearHistory).not.toHaveBeenCalled();
  });

  it('button clear:yes: calls clearHistory, edits reply', async () => {
    const deps = makeDeps();
    const ixn = makeButtonInteraction({
      customId: 'clear:yes',
      update: vi.fn().mockResolvedValue(undefined),
    });
    await routeInteraction(ixn, deps);
    expect(deps.commandService.clearHistory).toHaveBeenCalled();
    expect(ixn.update).toHaveBeenCalled();
  });
});
