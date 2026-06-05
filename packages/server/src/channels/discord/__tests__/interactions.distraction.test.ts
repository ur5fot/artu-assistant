import { describe, it, expect, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { routeInteraction, type InteractionDeps } from '../interactions.js';
import type { DistractionEvalStore } from '../../../observers/distraction-eval-store.js';

const RUN_START = 1_700_000_000_000;

function makeEvalStore(): DistractionEvalStore {
  return {
    findLatestEvalForDwell: vi.fn(),
    findRecentPing: vi.fn(),
    countEvalsSince: vi.fn(),
    activeSnoozeUntil: vi.fn(),
    recordEval: vi.fn(),
    recordFeedback: vi.fn(),
  } as unknown as DistractionEvalStore;
}

function makeDeps(
  evalStore: DistractionEvalStore | undefined,
  snoozeMin?: number,
): InteractionDeps {
  return {
    whitelist: new Set(['user-1']),
    reminderService: {} as any,
    permissionService: {} as any,
    planReviewService: {} as any,
    commandService: {} as any,
    cognitionService: {} as any,
    distractionEvalStore: evalStore,
    distractionSnoozeMin: snoozeMin,
  };
}

function makeButton(customId: string) {
  return {
    isButton: () => true,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    user: { id: 'user-1' },
    customId,
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('distract:* interactions', () => {
  it('back acks ephemerally without writing feedback', async () => {
    const store = makeEvalStore();
    const ixn = makeButton(`distract:back:${RUN_START}`);
    await routeInteraction(ixn, makeDeps(store));
    expect(store.recordFeedback).not.toHaveBeenCalled();
    const arg = ixn.reply.mock.calls[0][0];
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
  });

  it('work records "work" feedback for the dwell key', async () => {
    const store = makeEvalStore();
    const ixn = makeButton(`distract:work:Chrome:${RUN_START}`);
    await routeInteraction(ixn, makeDeps(store));
    expect(store.recordFeedback).toHaveBeenCalledWith('Chrome', RUN_START, 'work');
    const arg = ixn.reply.mock.calls[0][0];
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
  });

  it('done records "done" feedback once and acks ephemerally', async () => {
    const store = makeEvalStore();
    const ixn = makeButton(`distract:done:Chrome:${RUN_START}`);
    await routeInteraction(ixn, makeDeps(store));
    expect(store.recordFeedback).toHaveBeenCalledTimes(1);
    expect(store.recordFeedback).toHaveBeenCalledWith('Chrome', RUN_START, 'done');
    const arg = ixn.reply.mock.calls[0][0];
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
    expect(arg.content).toBe('✓ Понял, задача закрыта — по этому переходу не дёргаю.');
  });

  it('done still acks when the eval store is not wired', async () => {
    const ixn = makeButton(`distract:done:Chrome:${RUN_START}`);
    await routeInteraction(ixn, makeDeps(undefined));
    expect(ixn.reply).toHaveBeenCalledTimes(1);
  });

  it('done with malformed id does not throw, writes nothing, and silently drops', async () => {
    const store = makeEvalStore();
    const ixn = makeButton('distract:done:NoRunStart');
    await routeInteraction(ixn, makeDeps(store));
    expect(store.recordFeedback).not.toHaveBeenCalled();
    expect(ixn.reply).not.toHaveBeenCalled();
  });

  it('snooze writes a future snooze_until using the configured window', async () => {
    const store = makeEvalStore();
    const ixn = makeButton(`distract:snooze:Chrome:${RUN_START}`);
    const before = Date.now();
    await routeInteraction(ixn, makeDeps(store, 30));
    const after = Date.now();
    expect(store.recordFeedback).toHaveBeenCalledTimes(1);
    const [app, runStart, feedback, snoozeUntil] = (store.recordFeedback as any).mock.calls[0];
    expect(app).toBe('Chrome');
    expect(runStart).toBe(RUN_START);
    expect(feedback).toBe('snooze');
    expect(snoozeUntil).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(snoozeUntil).toBeLessThanOrEqual(after + 30 * 60_000);
  });

  it('snooze falls back to a 60-minute window when none is configured', async () => {
    const store = makeEvalStore();
    const ixn = makeButton(`distract:snooze:Chrome:${RUN_START}`);
    const before = Date.now();
    await routeInteraction(ixn, makeDeps(store));
    const snoozeUntil = (store.recordFeedback as any).mock.calls[0][3];
    expect(snoozeUntil).toBeGreaterThanOrEqual(before + 60 * 60_000);
  });

  it('handles app names containing colons in the work id', async () => {
    const store = makeEvalStore();
    const ixn = makeButton(`distract:work:App:With:Colons:${RUN_START}`);
    await routeInteraction(ixn, makeDeps(store));
    expect(store.recordFeedback).toHaveBeenCalledWith('App:With:Colons', RUN_START, 'work');
  });

  it('still acks when the eval store is not wired', async () => {
    const ixn = makeButton(`distract:work:Chrome:${RUN_START}`);
    await routeInteraction(ixn, makeDeps(undefined));
    expect(ixn.reply).toHaveBeenCalledTimes(1);
  });
});
