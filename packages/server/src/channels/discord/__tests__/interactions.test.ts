import { describe, it, expect, vi } from 'vitest';
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
    expect(ixn.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
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
