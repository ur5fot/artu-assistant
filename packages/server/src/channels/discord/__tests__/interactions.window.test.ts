import { describe, it, expect, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { routeInteraction, type InteractionDeps } from '../interactions.js';
import type { WindowHistoryStore, SessionTitle } from '../../../observers/window-history-store.js';

function makeStore(titles: SessionTitle[]): WindowHistoryStore {
  return {
    recordSample: vi.fn(),
    findCurrentSession: vi.fn(),
    findRecentRows: vi.fn(),
    listTitlesInSession: vi.fn().mockReturnValue(titles),
    purgeOlderThan: vi.fn(),
  } as unknown as WindowHistoryStore;
}

function makeDeps(store: WindowHistoryStore | undefined): InteractionDeps {
  return {
    whitelist: new Set(['user-1']),
    reminderService: {} as any,
    permissionService: {} as any,
    planReviewService: {} as any,
    commandService: {} as any,
    cognitionService: {} as any,
    windowHistoryStore: store,
  };
}

function makeButton(customId: string, overrides: Record<string, any> = {}) {
  return {
    isButton: () => true,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    user: { id: 'user-1' },
    customId,
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

const CID = 'window:show:Chrome:1700000000000:1700003600000';

describe('window:show interaction', () => {
  it('parses app + timestamps and queries the store', async () => {
    const store = makeStore([{ title: 'Inbox - Gmail', last_seen_at: 1700003600000 }]);
    const ixn = makeButton(CID);
    await routeInteraction(ixn, makeDeps(store));
    expect(store.listTitlesInSession).toHaveBeenCalledWith(
      'Chrome',
      1700000000000,
      1700003600000,
    );
  });

  it('replies ephemerally with the title list', async () => {
    const store = makeStore([
      { title: 'Inbox - Gmail', last_seen_at: 2 },
      { title: 'Docs', last_seen_at: 1 },
    ]);
    const ixn = makeButton(CID);
    await routeInteraction(ixn, makeDeps(store));
    expect(ixn.reply).toHaveBeenCalledTimes(1);
    const arg = ixn.reply.mock.calls[0][0];
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
    expect(arg.content).toContain('Inbox - Gmail');
    expect(arg.content).toContain('Docs');
  });

  it('truncates each title to 80 chars', async () => {
    const long = 'x'.repeat(200);
    const store = makeStore([{ title: long, last_seen_at: 1 }]);
    const ixn = makeButton(CID);
    await routeInteraction(ixn, makeDeps(store));
    const arg = ixn.reply.mock.calls[0][0];
    // 79 chars + ellipsis (the bullet/header excluded from this slice check).
    expect(arg.content).toContain('x'.repeat(79) + '…');
    expect(arg.content).not.toContain('x'.repeat(81));
  });

  it('caps the list at 15 titles', async () => {
    const titles: SessionTitle[] = Array.from({ length: 25 }, (_, i) => ({
      title: `title-${i}`,
      last_seen_at: i,
    }));
    const store = makeStore(titles);
    const ixn = makeButton(CID);
    await routeInteraction(ixn, makeDeps(store));
    const arg = ixn.reply.mock.calls[0][0];
    const bullets = arg.content.split('\n').filter((l: string) => l.startsWith('•'));
    expect(bullets).toHaveLength(15);
  });

  it('shows a friendly empty-state when there are no titles', async () => {
    const store = makeStore([]);
    const ixn = makeButton(CID);
    await routeInteraction(ixn, makeDeps(store));
    const arg = ixn.reply.mock.calls[0][0];
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
    expect(arg.content).toContain('No window titles');
  });

  it('handles app names containing colons', async () => {
    const store = makeStore([{ title: 't', last_seen_at: 1 }]);
    const ixn = makeButton('window:show:App:With:Colons:111:222');
    await routeInteraction(ixn, makeDeps(store));
    expect(store.listTitlesInSession).toHaveBeenCalledWith('App:With:Colons', 111, 222);
  });

  it('replies with a config error when the store is missing', async () => {
    const ixn = makeButton(CID);
    await routeInteraction(ixn, makeDeps(undefined));
    const arg = ixn.reply.mock.calls[0][0];
    expect(arg.content).toContain('not configured');
  });
});
