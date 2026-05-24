import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { createTopicFinalizerHandler } from '../finalizer.js';
import type { TopicRow, ChatMessageRow, TopicStore } from '../store.js';

function topic(overrides: Partial<TopicRow> = {}): TopicRow {
  return {
    id: 1,
    label: null,
    summary: null,
    importance: null,
    started_at: 1000,
    ended_at: 2000,
    status: 'closed',
    source: 'discord',
    finalized_at: null,
    failure_count: 0,
    ...overrides,
  };
}

function msg(overrides: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return {
    message_id: 'm1',
    role: 'user',
    content: 'hello',
    tool_calls: null,
    pii_entities: null,
    timestamp: 1000,
    source: 'discord',
    ...overrides,
  };
}

function mkStore(): TopicStore & {
  listClosedReadyForFinalize: Mock;
  finalize: Mock;
  markFinalizationFailure: Mock;
  markFinalizationGiveUp: Mock;
  getTopicMessages: Mock;
} {
  return {
    getOpenTopic: vi.fn(),
    createOpen: vi.fn(),
    closeOpen: vi.fn(),
    linkMessage: vi.fn(),
    listClosedReadyForFinalize: vi.fn(),
    finalize: vi.fn(),
    markFinalizationFailure: vi.fn(),
    markFinalizationGiveUp: vi.fn(),
    findStaleOpen: vi.fn(),
    getTopicMessages: vi.fn(),
    listFinalized: vi.fn(),
  } as any;
}

function mkMemoryService() {
  return {
    indexTopicSummary: vi.fn().mockResolvedValue(undefined),
    extractFactsFromConversation: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function mkAnthropic(text: string | Error) {
  const create = vi.fn();
  if (text instanceof Error) {
    create.mockRejectedValue(text);
  } else {
    create.mockResolvedValue({ content: [{ type: 'text', text }] });
  }
  return { anthropic: { messages: { create } } as any, create };
}

function mkCtx(now: number) {
  return {
    db: {} as any,
    firedAt: now,
    signal: new AbortController().signal,
  };
}

const DEFAULT_DEPS = {
  extractorModel: 'claude-haiku-4-5',
  bufferMs: 10 * 60_000,
  finalizeBatch: 5,
  maxFailures: 5,
};

describe('createTopicFinalizerHandler.trigger', () => {
  it('returns true when listClosedReadyForFinalize finds topics', async () => {
    const store = mkStore();
    store.listClosedReadyForFinalize.mockReturnValue([topic()]);
    const { anthropic } = mkAnthropic('{}');
    const h = createTopicFinalizerHandler({
      store,
      memoryService: mkMemoryService(),
      anthropic,
      ...DEFAULT_DEPS,
    });
    const now = 100_000_000;
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: {} as any });
    expect(fire).toBe(true);
    expect(store.listClosedReadyForFinalize).toHaveBeenCalledWith(
      now - DEFAULT_DEPS.bufferMs,
      DEFAULT_DEPS.finalizeBatch,
    );
  });

  it('returns false when no closed topics are ready', async () => {
    const store = mkStore();
    store.listClosedReadyForFinalize.mockReturnValue([]);
    const { anthropic } = mkAnthropic('{}');
    const h = createTopicFinalizerHandler({
      store,
      memoryService: mkMemoryService(),
      anthropic,
      ...DEFAULT_DEPS,
    });
    const fire = await h.trigger({ now: 100, lastFiredAt: null, lastResult: null }, { db: {} as any });
    expect(fire).toBe(false);
  });
});

describe('createTopicFinalizerHandler.run', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('finalizes one topic on valid Haiku JSON', async () => {
    const store = mkStore();
    store.listClosedReadyForFinalize.mockReturnValue([topic({ id: 42 })]);
    store.getTopicMessages.mockReturnValue([
      msg({ message_id: 'u1', role: 'user', content: 'fix bug X', timestamp: 1000 }),
      msg({ message_id: 'a1', role: 'assistant', content: 'fixed', timestamp: 1500 }),
    ]);
    const memoryService = mkMemoryService();
    const { anthropic, create } = mkAnthropic(
      JSON.stringify({ label: 'fixed bug X', summary: 'fixed bug X by patching foo.ts', importance: 8 }),
    );
    const h = createTopicFinalizerHandler({ store, memoryService, anthropic, ...DEFAULT_DEPS });
    const now = 9_000_000;
    const result = await h.run(mkCtx(now));

    expect(create).toHaveBeenCalledOnce();
    expect(store.finalize).toHaveBeenCalledWith(42, 'fixed bug X', 'fixed bug X by patching foo.ts', 8, now);
    expect(memoryService.indexTopicSummary).toHaveBeenCalledWith({
      topicId: 42,
      label: 'fixed bug X',
      summary: 'fixed bug X by patching foo.ts',
      finalizedAt: now,
    });
    expect(memoryService.extractFactsFromConversation).toHaveBeenCalledOnce();
    expect((result as any).skip).toBe(true);
  });

  it('finalizes multiple topics in one tick up to finalizeBatch', async () => {
    const store = mkStore();
    store.listClosedReadyForFinalize.mockReturnValue([
      topic({ id: 1 }),
      topic({ id: 2 }),
      topic({ id: 3 }),
    ]);
    store.getTopicMessages.mockReturnValue([msg()]);
    const { anthropic } = mkAnthropic(
      JSON.stringify({ label: 'a', summary: 'b', importance: 5 }),
    );
    const h = createTopicFinalizerHandler({
      store,
      memoryService: mkMemoryService(),
      anthropic,
      ...DEFAULT_DEPS,
    });
    await h.run(mkCtx(9_000_000));
    expect(store.finalize).toHaveBeenCalledTimes(3);
  });

  it('markFinalizationFailure on malformed JSON; topic stays closed', async () => {
    const store = mkStore();
    store.listClosedReadyForFinalize.mockReturnValue([topic({ id: 7 })]);
    store.getTopicMessages.mockReturnValue([msg()]);
    store.markFinalizationFailure.mockReturnValue(2);
    const { anthropic } = mkAnthropic('definitely not json');
    const h = createTopicFinalizerHandler({
      store,
      memoryService: mkMemoryService(),
      anthropic,
      ...DEFAULT_DEPS,
    });
    await h.run(mkCtx(9_000_000));
    expect(store.markFinalizationFailure).toHaveBeenCalledWith(7);
    expect(store.markFinalizationGiveUp).not.toHaveBeenCalled();
    expect(store.finalize).not.toHaveBeenCalled();
  });

  it('Haiku throw → markFinalizationFailure path', async () => {
    const store = mkStore();
    store.listClosedReadyForFinalize.mockReturnValue([topic({ id: 9 })]);
    store.getTopicMessages.mockReturnValue([msg()]);
    store.markFinalizationFailure.mockReturnValue(1);
    const { anthropic } = mkAnthropic(new Error('Haiku unreachable'));
    const h = createTopicFinalizerHandler({
      store,
      memoryService: mkMemoryService(),
      anthropic,
      ...DEFAULT_DEPS,
    });
    await h.run(mkCtx(9_000_000));
    expect(store.markFinalizationFailure).toHaveBeenCalledWith(9);
    expect(store.markFinalizationGiveUp).not.toHaveBeenCalled();
    expect(store.finalize).not.toHaveBeenCalled();
  });

  it('5th consecutive failure flips to markFinalizationGiveUp', async () => {
    const store = mkStore();
    store.listClosedReadyForFinalize.mockReturnValue([topic({ id: 11, failure_count: 4 })]);
    store.getTopicMessages.mockReturnValue([msg()]);
    store.markFinalizationFailure.mockReturnValue(5);
    const { anthropic } = mkAnthropic('not json');
    const h = createTopicFinalizerHandler({
      store,
      memoryService: mkMemoryService(),
      anthropic,
      ...DEFAULT_DEPS,
    });
    const now = 9_000_000;
    await h.run(mkCtx(now));
    expect(store.markFinalizationFailure).toHaveBeenCalledWith(11);
    expect(store.markFinalizationGiveUp).toHaveBeenCalledWith(11, now);
  });

  it('replaces tool_calls JSON with placeholder before sending prompt', async () => {
    const store = mkStore();
    store.listClosedReadyForFinalize.mockReturnValue([topic({ id: 3 })]);
    store.getTopicMessages.mockReturnValue([
      msg({ message_id: 'u', role: 'user', content: 'look up weather', timestamp: 1 }),
      msg({
        message_id: 'a',
        role: 'assistant',
        content: '',
        tool_calls: JSON.stringify([{ name: 'web_search', input: { q: 'weather' } }]),
        timestamp: 2,
      }),
    ]);
    const { anthropic, create } = mkAnthropic(
      JSON.stringify({ label: 'weather', summary: 'looked up weather', importance: 3 }),
    );
    const h = createTopicFinalizerHandler({
      store,
      memoryService: mkMemoryService(),
      anthropic,
      ...DEFAULT_DEPS,
    });
    await h.run(mkCtx(9_000_000));
    const prompt = create.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('<tool: web_search — invoked>');
    expect(prompt).not.toContain('"input"');
  });

  it('topic with zero messages is given up immediately', async () => {
    const store = mkStore();
    store.listClosedReadyForFinalize.mockReturnValue([topic({ id: 100 })]);
    store.getTopicMessages.mockReturnValue([]);
    const { anthropic, create } = mkAnthropic('{}');
    const h = createTopicFinalizerHandler({
      store,
      memoryService: mkMemoryService(),
      anthropic,
      ...DEFAULT_DEPS,
    });
    const now = 9_000_000;
    await h.run(mkCtx(now));
    expect(store.markFinalizationGiveUp).toHaveBeenCalledWith(100, now);
    expect(create).not.toHaveBeenCalled();
  });

  it('importance clamped into [1, 10]', async () => {
    const store = mkStore();
    store.listClosedReadyForFinalize.mockReturnValue([topic({ id: 5 })]);
    store.getTopicMessages.mockReturnValue([msg()]);
    const { anthropic } = mkAnthropic(
      JSON.stringify({ label: 'x', summary: 'y', importance: 42 }),
    );
    const h = createTopicFinalizerHandler({
      store,
      memoryService: mkMemoryService(),
      anthropic,
      ...DEFAULT_DEPS,
    });
    await h.run(mkCtx(9_000_000));
    expect(store.finalize).toHaveBeenCalledWith(5, 'x', 'y', 10, expect.any(Number));
  });
});
