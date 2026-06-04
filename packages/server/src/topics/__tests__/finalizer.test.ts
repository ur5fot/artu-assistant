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
    action_required: null,
    action_dismissed_at: null,
    target_url: null,
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
    getOpenActions: vi.fn(),
    dismissAction: vi.fn(),
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
    expect(store.finalize).toHaveBeenCalledWith(42, 'fixed bug X', 'fixed bug X by patching foo.ts', 8, now, null, null);
    expect(memoryService.indexTopicSummary).toHaveBeenCalledWith({
      topicId: 42,
      label: 'fixed bug X',
      summary: 'fixed bug X by patching foo.ts',
      finalizedAt: now,
    });
    expect(memoryService.extractFactsFromConversation).toHaveBeenCalledOnce();
    expect((result as any).skip).toBe(true);
  });

  it('extracts action_required and target_url and threads them into finalize', async () => {
    const store = mkStore();
    store.listClosedReadyForFinalize.mockReturnValue([topic({ id: 14 })]);
    store.getTopicMessages.mockReturnValue([msg()]);
    const { anthropic } = mkAnthropic(
      JSON.stringify({
        label: 'github perms',
        summary: 'need to confirm github permissions',
        importance: 7,
        action_required: 'confirm github permissions',
        target_url: 'https://github.com/settings/installations',
      }),
    );
    const h = createTopicFinalizerHandler({ store, memoryService: mkMemoryService(), anthropic, ...DEFAULT_DEPS });
    const now = 9_000_000;
    await h.run(mkCtx(now));
    expect(store.finalize).toHaveBeenCalledWith(
      14,
      'github perms',
      'need to confirm github permissions',
      7,
      now,
      'confirm github permissions',
      'https://github.com/settings/installations',
    );
  });

  it('treats literal "null" / missing action fields as null', async () => {
    const store = mkStore();
    store.listClosedReadyForFinalize.mockReturnValue([topic({ id: 15 })]);
    store.getTopicMessages.mockReturnValue([msg()]);
    const { anthropic } = mkAnthropic(
      JSON.stringify({ label: 'chat', summary: 'just chatting', importance: 2, action_required: 'null' }),
    );
    const h = createTopicFinalizerHandler({ store, memoryService: mkMemoryService(), anthropic, ...DEFAULT_DEPS });
    const now = 9_000_000;
    await h.run(mkCtx(now));
    expect(store.finalize).toHaveBeenCalledWith(15, 'chat', 'just chatting', 2, now, null, null);
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

  it('caps prompt size by dropping oldest messages first', async () => {
    const store = mkStore();
    store.listClosedReadyForFinalize.mockReturnValue([topic({ id: 99 })]);
    // 5 messages of ~20K chars each = 100K total, well above the 60K cap.
    const big = 'x'.repeat(20_000);
    store.getTopicMessages.mockReturnValue([
      msg({ message_id: 'm1', role: 'user', content: `oldest ${big}`, timestamp: 1 }),
      msg({ message_id: 'm2', role: 'assistant', content: big, timestamp: 2 }),
      msg({ message_id: 'm3', role: 'user', content: big, timestamp: 3 }),
      msg({ message_id: 'm4', role: 'assistant', content: big, timestamp: 4 }),
      msg({ message_id: 'm5', role: 'user', content: `newest decisive answer`, timestamp: 5 }),
    ]);
    const { anthropic, create } = mkAnthropic(
      JSON.stringify({ label: 'x', summary: 'y', importance: 5 }),
    );
    const h = createTopicFinalizerHandler({
      store,
      memoryService: mkMemoryService(),
      anthropic,
      ...DEFAULT_DEPS,
    });
    await h.run(mkCtx(9_000_000));
    const prompt: string = create.mock.calls[0][0].messages[0].content;
    expect(prompt.length).toBeLessThan(80_000);
    expect(prompt).toContain('newest decisive answer');
    expect(prompt).not.toContain('oldest ');
    expect(prompt).toContain('earlier message(s) truncated');
  });

  it('filters slash-command dispatcher turns before Haiku + facts', async () => {
    const store = mkStore();
    store.listClosedReadyForFinalize.mockReturnValue([topic({ id: 50 })]);
    store.getTopicMessages.mockReturnValue([
      msg({ message_id: 'u1', role: 'user', content: '/читати foo.txt', timestamp: 1 }),
      msg({ message_id: 'a1', role: 'assistant', content: 'file content here', timestamp: 2 }),
      msg({ message_id: 'u2', role: 'user', content: 'thanks, lets plan the rewrite', timestamp: 3 }),
      msg({ message_id: 'a2', role: 'assistant', content: 'sure, here is the plan', timestamp: 4 }),
    ]);
    const memoryService = mkMemoryService();
    const { anthropic, create } = mkAnthropic(
      JSON.stringify({ label: 'rewrite plan', summary: 'planned the rewrite', importance: 6 }),
    );
    const h = createTopicFinalizerHandler({ store, memoryService, anthropic, ...DEFAULT_DEPS });
    await h.run(mkCtx(9_000_000));
    const prompt: string = create.mock.calls[0][0].messages[0].content;
    expect(prompt).not.toContain('/читати');
    expect(prompt).not.toContain('file content here');
    expect(prompt).toContain('lets plan the rewrite');
    const factsArg = memoryService.extractFactsFromConversation.mock.calls[0][0];
    expect(factsArg.messages.map((m: any) => m.messageId)).toEqual(['u2', 'a2']);
  });

  it('pure slash-command topic is given up without calling Haiku', async () => {
    const store = mkStore();
    store.listClosedReadyForFinalize.mockReturnValue([topic({ id: 51 })]);
    store.getTopicMessages.mockReturnValue([
      msg({ message_id: 'u1', role: 'user', content: '/help', timestamp: 1 }),
      msg({ message_id: 'a1', role: 'assistant', content: 'help text', timestamp: 2 }),
      msg({ message_id: 'u2', role: 'user', content: '/перемістити old new', timestamp: 3 }),
      msg({ message_id: 'a2', role: 'assistant', content: 'done', timestamp: 4 }),
    ]);
    const memoryService = mkMemoryService();
    const { anthropic, create } = mkAnthropic('{}');
    const h = createTopicFinalizerHandler({ store, memoryService, anthropic, ...DEFAULT_DEPS });
    const now = 9_000_000;
    await h.run(mkCtx(now));
    expect(create).not.toHaveBeenCalled();
    expect(store.markFinalizationGiveUp).toHaveBeenCalledWith(51, now);
    expect(memoryService.extractFactsFromConversation).not.toHaveBeenCalled();
  });

  it('truncates a single oversized message rather than sending it whole', async () => {
    const store = mkStore();
    store.listClosedReadyForFinalize.mockReturnValue([topic({ id: 77 })]);
    // One ~100K user message — well above the 60K body cap.
    const huge = 'a'.repeat(100_000);
    store.getTopicMessages.mockReturnValue([
      msg({ message_id: 'lone', role: 'user', content: huge, timestamp: 1 }),
    ]);
    const { anthropic, create } = mkAnthropic(
      JSON.stringify({ label: 'x', summary: 'y', importance: 5 }),
    );
    const h = createTopicFinalizerHandler({
      store,
      memoryService: mkMemoryService(),
      anthropic,
      ...DEFAULT_DEPS,
    });
    await h.run(mkCtx(9_000_000));
    const prompt: string = create.mock.calls[0][0].messages[0].content;
    // Header (~470 chars) + capped body (~60K) should still be well below 70K.
    expect(prompt.length).toBeLessThan(70_000);
    expect(prompt).toContain('[...message truncated]');
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
    expect(store.finalize).toHaveBeenCalledWith(5, 'x', 'y', 10, expect.any(Number), null, null);
  });
});
