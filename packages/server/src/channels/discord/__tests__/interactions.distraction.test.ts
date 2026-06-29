import { describe, it, expect, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { routeInteraction, type InteractionDeps } from '../interactions.js';
import type { DistractionEvalStore } from '../../../observers/distraction-eval-store.js';
import type {
  WindowHistoryStore,
  WorkSurface,
} from '../../../observers/window-history-store.js';
import type { RestoreResult } from '../../../observers/window-restore.js';

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

function makeWindowStore(surface: WorkSurface | null): WindowHistoryStore {
  return {
    recordSample: vi.fn(),
    findCurrentSession: vi.fn(),
    findRecentRows: vi.fn(),
    findRowsInWindow: vi.fn(),
    listTitlesInSession: vi.fn(),
    recentUrlsSince: vi.fn(),
    findDominantWorkSurfaceBefore: vi.fn().mockReturnValue(surface),
    purgeOlderThan: vi.fn(),
  } as unknown as WindowHistoryStore;
}

function makeRestoreDeps(opts: {
  windowStore?: WindowHistoryStore;
  restoreExecutor?: (target: WorkSurface) => Promise<RestoreResult>;
  lookbackMin?: number;
}): InteractionDeps {
  return {
    ...makeDeps(makeEvalStore()),
    windowHistoryStore: opts.windowStore,
    restoreExecutor: opts.restoreExecutor as any,
    distractionWorkLookbackMin: opts.lookbackMin,
  };
}

function makeButton(customId: string) {
  return {
    isButton: () => true,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
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

describe('distract:restore interaction', () => {
  it('re-derives the work surface and opens it via the executor', async () => {
    const windowStore = makeWindowStore({ app: 'Code' });
    const restoreExecutor = vi.fn().mockResolvedValue({ ok: true });
    const ixn = makeButton(`distract:restore:Chrome:${RUN_START}`);
    await routeInteraction(
      ixn,
      makeRestoreDeps({ windowStore, restoreExecutor, lookbackMin: 90 }),
    );
    expect(windowStore.findDominantWorkSurfaceBefore).toHaveBeenCalledWith(
      RUN_START,
      90 * 60_000,
      'Chrome',
    );
    expect(restoreExecutor).toHaveBeenCalledWith({ app: 'Code' });
    const arg = ixn.reply.mock.calls[0][0];
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
    expect(arg.content).toBe('↩️ Открыл Code');
    // Restore must ack ephemerally and leave the original nudge untouched.
    expect(ixn.update).not.toHaveBeenCalled();
  });

  it('falls back to a 120-min lookback when none is configured', async () => {
    const windowStore = makeWindowStore({ app: 'Code' });
    const restoreExecutor = vi.fn().mockResolvedValue({ ok: true });
    const ixn = makeButton(`distract:restore:Chrome:${RUN_START}`);
    await routeInteraction(ixn, makeRestoreDeps({ windowStore, restoreExecutor }));
    expect(windowStore.findDominantWorkSurfaceBefore).toHaveBeenCalledWith(
      RUN_START,
      120 * 60_000,
      'Chrome',
    );
  });

  it('reports the URL when the surface was a browser tab', async () => {
    const windowStore = makeWindowStore({ app: 'Safari', url: 'docs.foo/bar' });
    const restoreExecutor = vi.fn().mockResolvedValue({ ok: true });
    const ixn = makeButton(`distract:restore:Chrome:${RUN_START}`);
    await routeInteraction(ixn, makeRestoreDeps({ windowStore, restoreExecutor }));
    expect(restoreExecutor).toHaveBeenCalledWith({ app: 'Safari', url: 'docs.foo/bar' });
    expect(ixn.reply.mock.calls[0][0].content).toBe('↩️ Открыл Safari · docs.foo/bar');
  });

  it('surfaces a failure when the executor reports not-ok', async () => {
    const windowStore = makeWindowStore({ app: 'Code' });
    const restoreExecutor = vi.fn().mockResolvedValue({ ok: false, reason: 'boom' });
    const ixn = makeButton(`distract:restore:Chrome:${RUN_START}`);
    await routeInteraction(ixn, makeRestoreDeps({ windowStore, restoreExecutor }));
    const arg = ixn.reply.mock.calls[0][0];
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
    expect(arg.content).toBe('Не смог открыть Code.');
  });

  it('replies "no work context" when no surface qualifies', async () => {
    const windowStore = makeWindowStore(null);
    const restoreExecutor = vi.fn().mockResolvedValue({ ok: true });
    const ixn = makeButton(`distract:restore:Chrome:${RUN_START}`);
    await routeInteraction(ixn, makeRestoreDeps({ windowStore, restoreExecutor }));
    expect(restoreExecutor).not.toHaveBeenCalled();
    expect(ixn.reply.mock.calls[0][0].content).toBe(
      'Не нашёл рабочий контекст для восстановления.',
    );
  });

  it('replies gracefully when the window store / executor are not wired', async () => {
    const ixn = makeButton(`distract:restore:Chrome:${RUN_START}`);
    await routeInteraction(ixn, makeRestoreDeps({}));
    const arg = ixn.reply.mock.calls[0][0];
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
    expect(arg.content).toBe('Восстановление не настроено.');
  });
});
