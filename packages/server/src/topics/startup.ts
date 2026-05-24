import type { TopicStore } from './store.js';

/**
 * Close any topics still marked 'open' whose most recent linked message is
 * older than `now - gapMs`. Called on server bootstrap so finalizer can pick
 * them up on its next tick.
 *
 * ended_at is set to the cutoff (now - gapMs) rather than `now`, so the topic
 * looks like it ended at the gap threshold — not at restart time. This keeps
 * the buffer window (closed → finalized) measured from when the conversation
 * actually fell silent, not from when we noticed.
 */
export function autocloseStaleOpenTopics(
  store: TopicStore,
  gapMs: number,
  now: number,
): number {
  const cutoff = now - gapMs;
  const stale = store.findStaleOpen(cutoff);
  for (const topic of stale) {
    store.closeOpen(topic.id, cutoff);
  }
  return stale.length;
}
