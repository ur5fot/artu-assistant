import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  closeDb,
  getDb,
  initDb,
  saveMessage,
  setTopicDetector,
} from '../../db.js';
import { createMemoryService } from '../../memory/service.js';
import { buildCompactedPrompt } from '../../routes/chat-prompt.js';
import { createTopicDetector, TOPIC_GAP_MS } from '../detector.js';
import { createTopicFinalizerHandler } from '../finalizer.js';
import { autocloseStaleOpenTopics } from '../startup.js';
import { createTopicStore } from '../store.js';

/**
 * End-to-end integration: drives a full chat session through the topic
 * pipeline using the real DB layer, real TopicStore + detector, real
 * MemoryService (with mocked embedder + text provider), and verifies the
 * prompt builder serves a summary prefix referencing the finalized topic.
 *
 * Mocks: only Anthropic Haiku, embedder, and text provider — every other
 * component runs the same code path it would in production.
 */

function makeHashEmbedder() {
  const impl = async (text: string): Promise<number[]> => {
    const vec = new Array(1024).fill(0);
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    vec[0] = ((h >>> 0) % 1000) / 1000;
    vec[1] = 1 - vec[0];
    return vec;
  };
  return {
    dimension: 1024,
    identity: 'test-embedder',
    embedDocument: vi.fn().mockImplementation(impl),
    embedQuery: vi.fn().mockImplementation(impl),
  };
}

function makeAnthropicMock(payload: { label: string; summary: string; importance: number }) {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  });
  return { anthropic: { messages: { create } } as any, create };
}

function mkCtx(now: number) {
  return {
    db: getDb(),
    firedAt: now,
    signal: new AbortController().signal,
  };
}

describe('Topic clustering — end-to-end integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-topics-int-'));
    initDb(path.join(tmpDir, 'test.db'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    setTopicDetector(null);
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('drives 50-message two-burst chat through detector → finalizer → prompt builder', async () => {
    const store = createTopicStore({ db: getDb() });
    const detector = createTopicDetector({ store, gapMs: TOPIC_GAP_MS });
    setTopicDetector(detector);

    // Two bursts: 25 messages around T0, 25 messages around T0 + 5h
    // (well past TOPIC_GAP_MS = 2h, so detector splits them).
    const T0 = Date.UTC(2026, 4, 23, 10, 0, 0);
    const burst1Start = T0;
    const burst2Start = T0 + 5 * 60 * 60 * 1000;
    const stepMs = 30_000;

    for (let i = 0; i < 25; i++) {
      saveMessage({
        messageId: `b1-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: i % 2 === 0 ? `user msg about MIME decoding ${i}` : `assistant reply ${i}`,
        timestamp: burst1Start + i * stepMs,
        source: 'discord',
      });
    }
    for (let i = 0; i < 25; i++) {
      saveMessage({
        messageId: `b2-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: i % 2 === 0 ? `user msg about deploy ${i}` : `assistant reply ${i}`,
        timestamp: burst2Start + i * stepMs,
        source: 'discord',
      });
    }

    // After streaming both bursts, detector should have created exactly 2
    // topics — one closed (split when burst2's first message arrived past
    // the gap) and one still open.
    const allTopics = getDb()
      .prepare('SELECT * FROM chat_topics ORDER BY id ASC')
      .all() as any[];
    expect(allTopics).toHaveLength(2);
    expect(allTopics[0].status).toBe('closed');
    expect(allTopics[1].status).toBe('open');

    // Burst-1 topic should have linked all 25 burst-1 messages
    const linkedToFirst = getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM chat_topic_messages WHERE topic_id = ?`,
      )
      .get(allTopics[0].id) as { c: number };
    expect(linkedToFirst.c).toBe(25);

    // Step 2: simulate server restart well after burst-2 ended — autoclose
    // sweeps the still-open burst-2 topic. Use `now = burst2End + 3h`, which
    // puts cutoff = now - TOPIC_GAP_MS = burst2End + 1h, still after the last
    // message, so burst-2's topic also gets closed.
    const burst2End = burst2Start + 24 * stepMs;
    const restartNow = burst2End + 3 * 60 * 60 * 1000;
    const closedCount = autocloseStaleOpenTopics(store, TOPIC_GAP_MS, restartNow);
    expect(closedCount).toBe(1);
    const topicsAfterRestart = getDb()
      .prepare('SELECT status FROM chat_topics ORDER BY id ASC')
      .all() as Array<{ status: string }>;
    expect(topicsAfterRestart.map((t) => t.status)).toEqual(['closed', 'closed']);

    // Step 3: run the finalizer with a mocked Haiku. bufferMs = 1ms so both
    // closed topics qualify on the next tick.
    const embedder = makeHashEmbedder();
    const textProvider = {
      chat: vi.fn().mockResolvedValue({ text: '[]' }),
    };
    const memoryService = createMemoryService({
      db: getDb(),
      embeddings: embedder as any,
      textProvider: textProvider as any,
      extractorModel: 'qwen2.5:7b',
    });
    const { anthropic, create } = makeAnthropicMock({
      label: 'MIME decoding fix',
      summary: 'investigated and patched MIME decoding in emails watcher',
      importance: 8,
    });
    const handler = createTopicFinalizerHandler({
      store,
      memoryService,
      anthropic,
      extractorModel: 'claude-haiku-4-5',
      bufferMs: 1,
      finalizeBatch: 10,
      maxFailures: 5,
    });

    const finalizeNow = restartNow + 60_000;
    const fire = await handler.trigger(
      { now: finalizeNow, lastFiredAt: null, lastResult: null },
      { db: getDb() },
    );
    expect(fire).toBe(true);
    await handler.run(mkCtx(finalizeNow));

    // Both topics finalized
    expect(create).toHaveBeenCalledTimes(2);
    const finalized = getDb()
      .prepare(`SELECT * FROM chat_topics WHERE status = 'finalized'`)
      .all() as any[];
    expect(finalized).toHaveLength(2);
    expect(finalized.every((t) => t.label === 'MIME decoding fix')).toBe(true);

    // memory_entries got a topic_summary row per topic
    const summaryEntries = getDb()
      .prepare(`SELECT * FROM memory_entries WHERE kind = ?`)
      .all('topic_summary') as Array<{ source_id: string; content: string }>;
    expect(summaryEntries).toHaveLength(2);
    expect(summaryEntries[0].content).toContain('MIME decoding fix');

    // Step 4: prompt builder — budget tight enough that not all 50 messages
    // fit verbatim, so older context must come back through summaryPrefix.
    // Char content is roughly 35 chars per message × 50 = 1750; we cap at
    // budget=800 so summaryShare=0.4*800=320 covers one finalized topic.
    const recentMessages = Array.from({ length: 50 }, (_, i) => {
      const burst = i < 25 ? 'b1' : 'b2';
      const idx = i < 25 ? i : i - 25;
      return {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: i % 2 === 0
          ? `user msg about ${burst === 'b1' ? 'MIME decoding' : 'deploy'} ${idx}`
          : `assistant reply ${idx}`,
      };
    });

    const built = buildCompactedPrompt({
      messages: recentMessages,
      budget: 800,
      store,
      now: finalizeNow + 60_000,
    });

    expect(built.summaryPrefix).not.toBeNull();
    expect(built.summaryPrefix).toContain('=== Recent topics (older context, summarized) ===');
    expect(built.summaryPrefix).toContain('MIME decoding fix');
    expect(built.summaryPrefix).toContain('=== End topics ===');
    // Sanity: tight budget really did drop messages
    expect(built.messages.length).toBeLessThan(recentMessages.length);

    // Step 5: 4A vector recall — buildContextPrefix should surface the
    // topic_summary embedding when its content is similar to the query.
    // Our hash embedder maps identical strings to identical vectors, so
    // querying with the topic summary text guarantees a perfect cosine hit.
    const ctxQuery = 'MIME decoding fix\ninvestigated and patched MIME decoding in emails watcher';
    const recall = await memoryService.buildContextPrefix(ctxQuery);
    // buildContextPrefix's vectorSearch filters by kind='entry' — topic_summary
    // is part of the entry-family, so it should be searchable via vector
    // recall. We assert the recall went through (prefix non-empty) rather
    // than dig for specific text, since the prefix template wraps content.
    expect(recall.prefix.length).toBeGreaterThan(0);
    // The embedder was called with the topic summary text as a document
    // when we indexed it, and as a query just now. The vector table must
    // contain at least one row for kind=topic_summary so the recall can
    // find it.
    const vecRows = getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM memory_vec_entries vec
         JOIN memory_entries e ON e.id = vec.entity_id
         WHERE e.kind = 'topic_summary'`,
      )
      .get() as { c: number };
    expect(vecRows.c).toBe(2);
  });
});
