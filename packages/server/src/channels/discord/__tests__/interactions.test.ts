import { describe, it, expect, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { routeInteraction } from '../interactions.js';
import type { ReminderService } from '../../../services/reminder-service.js';
import type { PermissionService } from '../../../services/permission-service.js';
import type { PlanReviewService } from '../../../services/plan-review-service.js';
import type { MemoryConfirmService } from '../../../services/memory-confirm-service.js';
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
      listPermissionRules: vi.fn().mockReturnValue([]),
      revokePermissionRule: vi.fn().mockReturnValue({ ok: true }),
    } as unknown as CommandService,
    cognitionService: {
      register: vi.fn(), start: vi.fn(), stop: vi.fn(),
      pause: vi.fn(), resume: vi.fn(),
      status: vi.fn().mockReturnValue({
        paused: false, lastTickAt: null, ticks24h: 0, queueSize: 0, handlers: [], recentRuns: [],
      }),
      markPublished: vi.fn(),
    } as any,
    ...overrides,
  };
}

function makeButtonInteraction(overrides: Record<string, any> = {}) {
  return {
    isButton: () => true,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    user: { id: 'user-1' },
    customId: 'reminder:dismiss:7',
    update: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
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

  it('perm:* — expired when resolveConfirm reports no pending entry', async () => {
    const deps = makeDeps({
      permissionService: {
        hasPending: vi.fn().mockReturnValue(false),
        resolveConfirm: vi.fn().mockReturnValue({ ok: false, reason: 'not_found' }),
      } as unknown as PermissionService,
    });
    const ixn = makeButtonInteraction({
      customId: 'perm:allow_once:gone',
      message: { embeds: [{}] },
    });
    await routeInteraction(ixn, deps);
    // We still call resolveConfirm — it's the single source of truth for
    // whether the entry is pending, avoiding a TOCTOU window between a
    // prior hasPending() check and the resolve call.
    expect(deps.permissionService.resolveConfirm).toHaveBeenCalled();
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

describe('routeInteraction — memory confirm buttons', () => {
  function makeMemoryConfirmService(
    overrides: Partial<MemoryConfirmService> = {},
  ): MemoryConfirmService {
    return {
      hasPending: vi.fn().mockReturnValue(true),
      isResolvedByUser: vi.fn().mockReturnValue(false),
      resolve: vi.fn().mockReturnValue({ ok: true }),
      ...overrides,
    } as MemoryConfirmService;
  }

  it('memconfirm:approve resolves with approved=true and updates message', async () => {
    const memoryConfirmService = makeMemoryConfirmService();
    const deps = makeDeps({ memoryConfirmService });
    const ixn = makeButtonInteraction({
      customId: 'memconfirm:approve:CALL-1',
      message: { content: '🧠 **Memory memory_forget**\nЗабути: "user.age"' },
    });
    await routeInteraction(ixn, deps);
    expect(memoryConfirmService.resolve).toHaveBeenCalledWith('CALL-1', true);
    expect(ixn.update).toHaveBeenCalledWith(
      expect.objectContaining({
        components: [],
        content: expect.stringContaining('✅ Approved'),
      }),
    );
  });

  it('memconfirm:deny resolves with approved=false and updates message', async () => {
    const memoryConfirmService = makeMemoryConfirmService();
    const deps = makeDeps({ memoryConfirmService });
    const ixn = makeButtonInteraction({
      customId: 'memconfirm:deny:CALL-1',
      message: { content: '🧠 **Memory memory_forget**' },
    });
    await routeInteraction(ixn, deps);
    expect(memoryConfirmService.resolve).toHaveBeenCalledWith('CALL-1', false);
    expect(ixn.update).toHaveBeenCalledWith(
      expect.objectContaining({
        components: [],
        content: expect.stringContaining('❌ Denied'),
      }),
    );
  });

  it('memconfirm:edit opens a modal prefilled from initialValues lookup', async () => {
    const memoryConfirmService = makeMemoryConfirmService();
    const initialValues = new Map<string, string>([['CALL-1', 'user.age']]);
    const deps = makeDeps({ memoryConfirmService, memoryConfirmInitialValues: initialValues });
    const showModal = vi.fn().mockResolvedValue(undefined);
    const ixn = makeButtonInteraction({
      customId: 'memconfirm:edit:CALL-1:query',
      message: { content: '🧠 **Memory memory_forget**' },
      showModal,
    });
    await routeInteraction(ixn, deps);
    expect(showModal).toHaveBeenCalled();
    const modal = showModal.mock.calls[0]![0];
    const json = modal.toJSON();
    expect(json.custom_id).toBe('memconfirm_modal:CALL-1:query');
    expect(json.components[0].components[0].value).toBe('user.age');
    expect(memoryConfirmService.resolve).not.toHaveBeenCalled();
  });

  it('memconfirm:* without memoryConfirmService replies with an ephemeral warning', async () => {
    const deps = makeDeps({ memoryConfirmService: undefined });
    const ixn = makeButtonInteraction({
      customId: 'memconfirm:approve:CALL-1',
      message: { content: '🧠 Memory' },
    });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });
});

describe('routeInteraction — memconfirm modal submit', () => {
  function makeModalInteraction(overrides: Record<string, any> = {}) {
    return {
      isButton: () => false,
      isModalSubmit: () => true,
      isChatInputCommand: () => false,
      user: { id: 'user-1' },
      customId: 'memconfirm_modal:CALL-2:query',
      fields: { getTextInputValue: vi.fn().mockReturnValue('user.age_group') },
      reply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as any;
  }

  it('resolves with edited params derived from the field name', async () => {
    const memoryConfirmService = {
      hasPending: vi.fn().mockReturnValue(true),
      isResolvedByUser: vi.fn().mockReturnValue(false),
      resolve: vi.fn().mockReturnValue({ ok: true }),
    } as unknown as MemoryConfirmService;
    const initialValues = new Map<string, string>([['CALL-2', 'user.age']]);
    const deps = makeDeps({ memoryConfirmService, memoryConfirmInitialValues: initialValues });
    const ixn = makeModalInteraction();
    await routeInteraction(ixn, deps);
    expect(memoryConfirmService.resolve).toHaveBeenCalledWith('CALL-2', true, {
      query: 'user.age_group',
    });
    expect(initialValues.has('CALL-2')).toBe(false);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('Approved with edit'),
      }),
    );
  });

  it('expired pending entry produces ephemeral expired reply', async () => {
    const memoryConfirmService = {
      hasPending: vi.fn().mockReturnValue(false),
      isResolvedByUser: vi.fn().mockReturnValue(false),
      resolve: vi.fn().mockReturnValue({ ok: false, reason: 'not_found' }),
    } as unknown as MemoryConfirmService;
    const deps = makeDeps({ memoryConfirmService });
    const ixn = makeModalInteraction({ customId: 'memconfirm_modal:gone:newValue' });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Expired') }),
    );
  });
});

function makeSlashInteraction(overrides: Record<string, any> = {}) {
  return {
    isButton: () => false,
    isModalSubmit: () => false,
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

  it('/memory: when listMemory throws, editReply with error instead of leaving defer stuck', async () => {
    const deps = makeDeps({
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(),
        listMemory: vi.fn().mockRejectedValue(new Error('ollama down')),
      } as any,
    });
    const ixn = makeSlashInteraction({
      commandName: 'memory',
      options: { getString: vi.fn().mockReturnValue('x') },
    });
    await routeInteraction(ixn, deps);
    expect(ixn.deferReply).toHaveBeenCalled();
    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('ollama down') }),
    );
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

describe('routeInteraction — /permissions', () => {
  it('empty rules: ephemeral "No saved permission rules."', async () => {
    const deps = makeDeps({
      commandService: {
        clearHistory: vi.fn(),
        status: vi.fn(),
        listReminders: vi.fn(),
        listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]),
        revokePermissionRule: vi.fn(),
      } as any,
    });
    const ixn = makeSlashInteraction({ commandName: 'permissions' });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: 'No saved permission rules.',
      }),
    );
  });

  it('non-empty rules: ephemeral embed + revoke buttons', async () => {
    const deps = makeDeps({
      commandService: {
        clearHistory: vi.fn(),
        status: vi.fn(),
        listReminders: vi.fn(),
        listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([
          { toolName: 'files_write', allowed: true },
        ]),
        revokePermissionRule: vi.fn(),
      } as any,
    });
    const ixn = makeSlashInteraction({ commandName: 'permissions' });
    await routeInteraction(ixn, deps);
    const call = (ixn.reply as any).mock.calls[0][0];
    expect(call.flags).toBe(MessageFlags.Ephemeral);
    expect(call.embeds).toBeDefined();
    expect(call.components?.length).toBeGreaterThan(0);
  });
});

describe('routeInteraction — perm_rule:revoke', () => {
  it('existing rule: calls service, updates message with refreshed list', async () => {
    const deps = makeDeps({
      commandService: {
        clearHistory: vi.fn(),
        status: vi.fn(),
        listReminders: vi.fn(),
        listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValueOnce([
          { toolName: 'a', allowed: true },
          { toolName: 'b', allowed: true },
        ]).mockReturnValueOnce([{ toolName: 'b', allowed: true }]),
        revokePermissionRule: vi.fn().mockReturnValue({ ok: true }),
      } as any,
    });
    const ixn = makeButtonInteraction({
      customId: 'perm_rule:revoke:a',
      message: { embeds: [{}] },
    });
    await routeInteraction(ixn, deps);
    expect(deps.commandService.revokePermissionRule).toHaveBeenCalledWith('a');
    expect(ixn.update).toHaveBeenCalled();
  });

  it('unknown rule: still refreshes list (no-op revoke)', async () => {
    const deps = makeDeps({
      commandService: {
        clearHistory: vi.fn(),
        status: vi.fn(),
        listReminders: vi.fn(),
        listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]),
        revokePermissionRule: vi
          .fn()
          .mockReturnValue({ ok: false, reason: 'not_found' }),
      } as any,
    });
    const ixn = makeButtonInteraction({
      customId: 'perm_rule:revoke:ghost',
      message: { embeds: [{}] },
    });
    await routeInteraction(ixn, deps);
    expect(ixn.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'No saved permission rules left.', components: [] }),
    );
  });
});

describe('routeInteraction — /heartbeat', () => {
  function makeCogService(overrides: Record<string, any> = {}) {
    return {
      register: vi.fn(), start: vi.fn(), stop: vi.fn(),
      pause: vi.fn(), resume: vi.fn(),
      status: vi.fn().mockReturnValue({
        paused: false,
        lastTickAt: 1700000000000,
        ticks24h: 1440,
        queueSize: 0,
        handlers: ['pulse'],
        recentRuns: [],
      }),
      markPublished: vi.fn(),
      ...overrides,
    } as any;
  }

  function makeSlash(overrides: Record<string, any> = {}) {
    return {
      isButton: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      user: { id: 'user-1' },
      commandName: 'heartbeat',
      options: { getSubcommand: vi.fn().mockReturnValue('status'), getString: vi.fn() },
      reply: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as any;
  }

  it('status: ephemeral reply with paused/last tick/handlers', async () => {
    const cognitionService = makeCogService();
    const deps = makeDeps({ cognitionService });
    const ixn = makeSlash();
    await routeInteraction(ixn, deps);
    expect(cognitionService.status).toHaveBeenCalled();
    const arg = (ixn.reply as any).mock.calls[0][0];
    expect(arg.flags).toBeDefined();
    expect(arg.content).toContain('alive');
    expect(arg.content).toContain('pulse');
  });

  it('pause: calls service.pause + ephemeral confirmation', async () => {
    const cognitionService = makeCogService();
    const deps = makeDeps({ cognitionService });
    const ixn = makeSlash({ options: { getSubcommand: vi.fn().mockReturnValue('pause'), getString: vi.fn() } });
    await routeInteraction(ixn, deps);
    expect(cognitionService.pause).toHaveBeenCalled();
    expect((ixn.reply as any).mock.calls[0][0].content).toContain('paused');
  });

  it('resume: calls service.resume + ephemeral confirmation', async () => {
    const cognitionService = makeCogService();
    const deps = makeDeps({ cognitionService });
    const ixn = makeSlash({ options: { getSubcommand: vi.fn().mockReturnValue('resume'), getString: vi.fn() } });
    await routeInteraction(ixn, deps);
    expect(cognitionService.resume).toHaveBeenCalled();
    expect((ixn.reply as any).mock.calls[0][0].content).toContain('resumed');
  });

  it('unknown subcommand: ephemeral reply so Discord does not show "did not respond"', async () => {
    const cognitionService = makeCogService();
    const deps = makeDeps({ cognitionService });
    const ixn = makeSlash({ options: { getSubcommand: vi.fn().mockReturnValue('bogus'), getString: vi.fn() } });
    await routeInteraction(ixn, deps);
    expect(cognitionService.pause).not.toHaveBeenCalled();
    expect(cognitionService.resume).not.toHaveBeenCalled();
    const arg = (ixn.reply as any).mock.calls[0][0];
    expect(arg.flags).toBeDefined();
    expect(arg.content).toContain('bogus');
  });
});
