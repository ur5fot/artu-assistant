import { describe, it, expect, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { routeInteraction, type InteractionDeps } from '../interactions.js';
import type { TopicStore } from '../../../topics/store.js';

function makeTopicStore(): TopicStore {
  return {
    getOpenTopic: vi.fn(),
    createOpen: vi.fn(),
    closeOpen: vi.fn(),
    linkMessage: vi.fn(),
    listClosedReadyForFinalize: vi.fn(),
    finalize: vi.fn(),
    getOpenActions: vi.fn(),
    dismissAction: vi.fn(),
    reopenAction: vi.fn(),
    markFinalizationFailure: vi.fn(),
    markFinalizationGiveUp: vi.fn(),
    findStaleOpen: vi.fn(),
    getTopicMessages: vi.fn(),
    listFinalized: vi.fn(),
  } as unknown as TopicStore;
}

function makeDeps(topicStore: TopicStore | null | undefined): InteractionDeps {
  return {
    whitelist: new Set(['user-1']),
    reminderService: {} as any,
    permissionService: {} as any,
    planReviewService: {} as any,
    commandService: {} as any,
    cognitionService: {} as any,
    topicStore,
  };
}

// A morning-brief-style button row in API/received shape: each button exposes a
// `customId` getter (as discord.js does for received components) plus the API
// fields ButtonBuilder.from needs to clone it.
function button(customId: string, label: string) {
  return { type: 2, style: 3, label, custom_id: customId, customId };
}

function makeButton(customId: string, rows: any[] = []) {
  return {
    isButton: () => true,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    user: { id: 'user-1' },
    customId,
    message: { components: rows },
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('followup:done interactions', () => {
  it('dismisses the action and updates the message', async () => {
    const store = makeTopicStore();
    const ixn = makeButton('followup:done:5', [
      { type: 1, components: [button('followup:done:5', '✓ pay invoice')] },
    ]);
    const before = Date.now();
    await routeInteraction(ixn, makeDeps(store));
    const after = Date.now();
    expect(store.dismissAction).toHaveBeenCalledTimes(1);
    const [topicId, now] = (store.dismissAction as any).mock.calls[0];
    expect(topicId).toBe(5);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
    expect(ixn.update).toHaveBeenCalledTimes(1);
  });

  it('drops only the tapped button, keeping the others', async () => {
    const store = makeTopicStore();
    const ixn = makeButton('followup:done:5', [
      {
        type: 1,
        components: [
          button('followup:done:5', '✓ pay invoice'),
          button('followup:done:7', '✓ confirm perms'),
        ],
      },
    ]);
    await routeInteraction(ixn, makeDeps(store));
    const arg = ixn.update.mock.calls[0][0];
    const remainingIds = arg.components
      .flatMap((row: any) => row.components)
      .map((b: any) => b.data.custom_id);
    expect(remainingIds).toEqual(['followup:done:7']);
  });

  it('drops the row entirely when the last button is removed', async () => {
    const store = makeTopicStore();
    const ixn = makeButton('followup:done:5', [
      { type: 1, components: [button('followup:done:5', '✓ pay invoice')] },
    ]);
    await routeInteraction(ixn, makeDeps(store));
    const arg = ixn.update.mock.calls[0][0];
    expect(arg.components).toEqual([]);
  });

  it('still dismisses (idempotent) for a stale already-dismissed button', async () => {
    const store = makeTopicStore();
    // dismissAction is a no-op the second time; the handler must not throw and
    // should still update the message to reflect the close.
    const ixn = makeButton('followup:done:5', [
      { type: 1, components: [button('followup:done:5', '✓ pay invoice')] },
    ]);
    await routeInteraction(ixn, makeDeps(store));
    expect(store.dismissAction).toHaveBeenCalledWith(5, expect.any(Number));
    expect(ixn.update).toHaveBeenCalledTimes(1);
  });

  it('ignores a malformed topicId without touching the store', async () => {
    const store = makeTopicStore();
    const ixn = makeButton('followup:done:not-a-number');
    await routeInteraction(ixn, makeDeps(store));
    expect(store.dismissAction).not.toHaveBeenCalled();
    expect(ixn.update).not.toHaveBeenCalled();
  });

  it('replies ephemerally when the topic store is not wired', async () => {
    const ixn = makeButton('followup:done:5', [
      { type: 1, components: [button('followup:done:5', '✓ pay invoice')] },
    ]);
    await routeInteraction(ixn, makeDeps(undefined));
    expect(ixn.reply).toHaveBeenCalledTimes(1);
    expect(ixn.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
    expect(ixn.update).not.toHaveBeenCalled();
  });
});

describe('followup:reopen interactions', () => {
  it('reopens the action and updates the message', async () => {
    const store = makeTopicStore();
    const ixn = makeButton('followup:reopen:5', [
      { type: 1, components: [button('followup:reopen:5', '↩ Вернуть')] },
    ]);
    await routeInteraction(ixn, makeDeps(store));
    expect(store.reopenAction).toHaveBeenCalledTimes(1);
    expect(store.reopenAction).toHaveBeenCalledWith(5);
    expect(ixn.update).toHaveBeenCalledTimes(1);
  });

  it('drops only the tapped reopen button, keeping the others', async () => {
    const store = makeTopicStore();
    const ixn = makeButton('followup:reopen:5', [
      {
        type: 1,
        components: [
          button('followup:reopen:5', '↩ Вернуть'),
          button('followup:reopen:7', '↩ Вернуть'),
        ],
      },
    ]);
    await routeInteraction(ixn, makeDeps(store));
    const arg = ixn.update.mock.calls[0][0];
    const remainingIds = arg.components
      .flatMap((row: any) => row.components)
      .map((b: any) => b.data.custom_id);
    expect(remainingIds).toEqual(['followup:reopen:7']);
  });

  it('still reopens (idempotent) for a stale already-reopened button', async () => {
    const store = makeTopicStore();
    const ixn = makeButton('followup:reopen:5', [
      { type: 1, components: [button('followup:reopen:5', '↩ Вернуть')] },
    ]);
    await routeInteraction(ixn, makeDeps(store));
    expect(store.reopenAction).toHaveBeenCalledWith(5);
    expect(ixn.update).toHaveBeenCalledTimes(1);
  });

  it('ignores a malformed topicId without touching the store', async () => {
    const store = makeTopicStore();
    const ixn = makeButton('followup:reopen:not-a-number');
    await routeInteraction(ixn, makeDeps(store));
    expect(store.reopenAction).not.toHaveBeenCalled();
    expect(ixn.update).not.toHaveBeenCalled();
  });

  it('replies ephemerally when the topic store is not wired', async () => {
    const ixn = makeButton('followup:reopen:5', [
      { type: 1, components: [button('followup:reopen:5', '↩ Вернуть')] },
    ]);
    await routeInteraction(ixn, makeDeps(undefined));
    expect(ixn.reply).toHaveBeenCalledTimes(1);
    expect(ixn.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
    expect(ixn.update).not.toHaveBeenCalled();
  });
});
