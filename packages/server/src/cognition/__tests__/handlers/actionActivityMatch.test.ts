import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../../../db.js';
import { createTopicStore, type TopicStore } from '../../../topics/store.js';
import { createWindowHistoryStore } from '../../../observers/window-history-store.js';
import { createActionActivityMatchHandler } from '../../handlers/actionActivityMatch.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => closeDb());

function mkCtx(firedAt: number) {
  return { db: getDb(), firedAt, signal: new AbortController().signal };
}

// Finalized topic that still owes an external action (an open action). Starts
// well before it finalizes so visits arriving ~1h before NOW legitimately
// postdate the topic start.
function mkAction(
  store: TopicStore,
  opts: { label: string; action: string; url: string | null; finalizedAt: number },
): number {
  const t = store.createOpen(opts.finalizedAt - 7200_000, 'discord');
  store.finalize(t.id, opts.label, 'sum', 5, opts.finalizedAt, opts.action, opts.url);
  return t.id;
}

// Record a browser visit. `url` is host+path (the stripped shape the snapshot
// provider persists). A distinct title per call forces a new row.
function mkVisit(store: ReturnType<typeof createWindowHistoryStore>, url: string, sampledAt: number) {
  store.recordSample({ app_name: 'Google Chrome', window_title: url, sampled_at: sampledAt, url });
}

const NOW = 1_000_000_000_000;

describe('createActionActivityMatchHandler.trigger', () => {
  it('returns false when no open action carries a deep-enough target_url', () => {
    const topicStore = createTopicStore({ db: getDb() });
    const windowHistoryStore = createWindowHistoryStore({ db: getDb() });
    // No url, and a bare-domain/single-segment url — neither is eligible.
    mkAction(topicStore, { label: 'a', action: 'do a', url: null, finalizedAt: NOW });
    mkAction(topicStore, { label: 'b', action: 'do b', url: 'https://bank.test/pay', finalizedAt: NOW });
    const h = createActionActivityMatchHandler({ windowHistoryStore, topicStore });
    expect(h.trigger({ now: NOW, lastFiredAt: null, lastResult: null }, { db: getDb() })).toBe(false);
  });

  it('returns true when an open action has a deep target_url', () => {
    const topicStore = createTopicStore({ db: getDb() });
    const windowHistoryStore = createWindowHistoryStore({ db: getDb() });
    mkAction(topicStore, { label: 'pr', action: 'review PR', url: 'https://github.com/org/repo/pull/9', finalizedAt: NOW });
    const h = createActionActivityMatchHandler({ windowHistoryStore, topicStore });
    expect(h.trigger({ now: NOW, lastFiredAt: null, lastResult: null }, { db: getDb() })).toBe(true);
  });

  it('returns false right after a successful publish (cooldown)', () => {
    const topicStore = createTopicStore({ db: getDb() });
    const windowHistoryStore = createWindowHistoryStore({ db: getDb() });
    mkAction(topicStore, { label: 'pr', action: 'review PR', url: 'https://github.com/org/repo/pull/9', finalizedAt: NOW });
    const h = createActionActivityMatchHandler({ windowHistoryStore, topicStore, cooldownMs: 3600_000 });
    const state = { now: NOW + 1000, lastFiredAt: NOW, lastResult: { publish: true as const, content: 'x' } };
    expect(h.trigger(state, { db: getDb() })).toBe(false);
  });
});

describe('createActionActivityMatchHandler.run', () => {
  it('closes an action when its target page was visited (notice + reopen button)', async () => {
    const topicStore = createTopicStore({ db: getDb() });
    const windowHistoryStore = createWindowHistoryStore({ db: getDb() });
    const topicId = mkAction(topicStore, {
      label: 'pr',
      action: 'review PR',
      url: 'https://github.com/org/repo/pull/9',
      finalizedAt: NOW,
    });
    // Visited a deeper path under the target — host eq + segment-prefix match.
    mkVisit(windowHistoryStore, 'github.com/org/repo/pull/9/files', NOW - 3600_000);

    const h = createActionActivityMatchHandler({ windowHistoryStore, topicStore });
    const result = await h.run(mkCtx(NOW));
    expect('publish' in result && result.publish).toBe(true);
    if (!('publish' in result)) throw new Error('expected publish');
    expect(result.content).toContain('review PR');
    const ids = result.components?.flatMap((r) => r.buttons.map((b) => b.customId)) ?? [];
    expect(ids).toContain(`followup:reopen:${topicId}`);

    // Not dismissed until the publish lands.
    expect(topicStore.getOpenActions()).toHaveLength(1);
    await result.onPublished?.();
    expect(topicStore.getOpenActions()).toHaveLength(0);
  });

  it('does not close when the visit predates the action', async () => {
    const topicStore = createTopicStore({ db: getDb() });
    const windowHistoryStore = createWindowHistoryStore({ db: getDb() });
    // Topic starts 1h before NOW; the visit happened 2h before NOW — before the
    // task existed, so it can't have completed it.
    const t = topicStore.createOpen(NOW - 3600_000, 'discord');
    topicStore.finalize(t.id, 'pr', 'sum', 5, NOW, 'review PR', 'https://github.com/org/repo/pull/9');
    mkVisit(windowHistoryStore, 'github.com/org/repo/pull/9', NOW - 7200_000);

    const h = createActionActivityMatchHandler({ windowHistoryStore, topicStore });
    const result = await h.run(mkCtx(NOW));
    expect('skip' in result && result.skip).toBe(true);
    expect(topicStore.getOpenActions()).toHaveLength(1);
  });

  it('does not close when the host matches but the path is unrelated', async () => {
    const topicStore = createTopicStore({ db: getDb() });
    const windowHistoryStore = createWindowHistoryStore({ db: getDb() });
    mkAction(topicStore, {
      label: 'pr',
      action: 'review PR',
      url: 'https://github.com/org/repo/pull/9',
      finalizedAt: NOW,
    });
    // Same host, different repo — must not match (no bare-domain over-match).
    mkVisit(windowHistoryStore, 'github.com/other/thing', NOW - 3600_000);

    const h = createActionActivityMatchHandler({ windowHistoryStore, topicStore });
    const result = await h.run(mkCtx(NOW));
    expect('skip' in result && result.skip).toBe(true);
    expect(topicStore.getOpenActions()).toHaveLength(1);
  });

  it('does not let a sibling path prefix over-match (segment boundary)', async () => {
    const topicStore = createTopicStore({ db: getDb() });
    const windowHistoryStore = createWindowHistoryStore({ db: getDb() });
    mkAction(topicStore, {
      label: 'repo',
      action: 'open repo',
      url: 'https://github.com/org/repo',
      finalizedAt: NOW,
    });
    // `org/repo-other` shares the string prefix `org/repo` but not the segment.
    mkVisit(windowHistoryStore, 'github.com/org/repo-other', NOW - 3600_000);

    const h = createActionActivityMatchHandler({ windowHistoryStore, topicStore });
    const result = await h.run(mkCtx(NOW));
    expect('skip' in result && result.skip).toBe(true);
    expect(topicStore.getOpenActions()).toHaveLength(1);
  });

  it('never closes an action the user reopened after a wrong auto-close', async () => {
    const topicStore = createTopicStore({ db: getDb() });
    const windowHistoryStore = createWindowHistoryStore({ db: getDb() });
    const topicId = mkAction(topicStore, {
      label: 'pr',
      action: 'review PR',
      url: 'https://github.com/org/repo/pull/9',
      finalizedAt: NOW,
    });
    mkVisit(windowHistoryStore, 'github.com/org/repo/pull/9', NOW - 3600_000);
    topicStore.dismissAction(topicId, NOW - 1000);
    topicStore.reopenAction(topicId, NOW - 500);
    expect(topicStore.getOpenActions()[0]?.autoCloseBlocked).toBe(true);

    const h = createActionActivityMatchHandler({ windowHistoryStore, topicStore });
    const result = await h.run(mkCtx(NOW));
    expect('skip' in result && result.skip).toBe(true);
    expect(topicStore.getOpenActions()).toHaveLength(1);
  });

  it('ignores actions without a target_url', async () => {
    const topicStore = createTopicStore({ db: getDb() });
    const windowHistoryStore = createWindowHistoryStore({ db: getDb() });
    mkAction(topicStore, { label: 'x', action: 'do x', url: null, finalizedAt: NOW });
    mkVisit(windowHistoryStore, 'github.com/org/repo/pull/9', NOW - 3600_000);

    const h = createActionActivityMatchHandler({ windowHistoryStore, topicStore });
    const result = await h.run(mkCtx(NOW));
    expect('skip' in result && result.skip).toBe(true);
    expect(topicStore.getOpenActions()).toHaveLength(1);
  });

  it('does not close on a single-segment (too shallow) target path', async () => {
    const topicStore = createTopicStore({ db: getDb() });
    const windowHistoryStore = createWindowHistoryStore({ db: getDb() });
    mkAction(topicStore, {
      label: 'pay',
      action: 'pay bill',
      url: 'https://bank.test/pay',
      finalizedAt: NOW,
    });
    mkVisit(windowHistoryStore, 'bank.test/pay', NOW - 3600_000);

    const h = createActionActivityMatchHandler({ windowHistoryStore, topicStore });
    const result = await h.run(mkCtx(NOW));
    expect('skip' in result && result.skip).toBe(true);
    expect(topicStore.getOpenActions()).toHaveLength(1);
  });
});
