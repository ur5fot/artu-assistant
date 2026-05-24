import type { TopicStore } from './store.js';

/**
 * Splits the incoming chat stream into topics by idle-gap heuristic.
 *
 * Rule: if the elapsed time since the last message on a given source is
 * greater than `gapMs`, close the current open topic and start a new one;
 * otherwise link the message to the open topic. State is kept per-source
 * (Discord vs. web vs. null) so independent channels do not collide.
 *
 * Why a heuristic and not an LLM classifier: topic boundaries get re-decided
 * on every saveMessage call (hot path, sub-ms budget) and the cost of a
 * wrong split is small — the finalizer summarizes each side independently
 * and 4A vector recall still surfaces older context. An LLM call here would
 * add latency and spend tokens on a decision that, empirically, idle-gap
 * already gets right for personal-assistant traffic.
 */
export const TOPIC_GAP_MS = 2 * 60 * 60 * 1000;

export interface IncomingMessage {
  messageId: string;
  timestamp: number;
  source: string | null;
}

export interface TopicDetector {
  assign(message: IncomingMessage): void;
  reset(source?: string): void;
}

interface DetectorDeps {
  store: TopicStore;
  gapMs: number;
}

interface SourceState {
  topicId: number;
  lastTimestamp: number;
}

const NULL_SOURCE_KEY = '\x00';

function keyOf(source: string | null): string {
  return source === null ? NULL_SOURCE_KEY : source;
}

export function createTopicDetector(deps: DetectorDeps): TopicDetector {
  const { store, gapMs } = deps;
  const state = new Map<string, SourceState>();
  const hydrated = new Set<string>();

  function hydrate(source: string | null): void {
    const k = keyOf(source);
    if (hydrated.has(k)) return;
    hydrated.add(k);
    const open = store.getOpenTopic(source);
    if (!open) return;
    const msgs = store.getTopicMessages(open.id);
    const lastTimestamp = msgs.length > 0 ? msgs[msgs.length - 1].timestamp : open.started_at;
    state.set(k, { topicId: open.id, lastTimestamp });
  }

  return {
    assign(message) {
      const { messageId, timestamp, source } = message;
      const k = keyOf(source);
      hydrate(source);

      const current = state.get(k);
      const shouldSplit = !current || timestamp - current.lastTimestamp > gapMs;

      if (shouldSplit) {
        if (current) {
          store.closeOpen(current.topicId, current.lastTimestamp);
        }
        const next = store.createOpen(timestamp, source);
        state.set(k, { topicId: next.id, lastTimestamp: timestamp });
        store.linkMessage(next.id, messageId);
        return;
      }

      store.linkMessage(current.topicId, messageId);
      // Out-of-order timestamps (replay, clock skew) must not rewind the
      // per-source cursor — otherwise a later real-time message could falsely
      // trigger a split because the gap is measured from a backdated value.
      state.set(k, {
        topicId: current.topicId,
        lastTimestamp: Math.max(current.lastTimestamp, timestamp),
      });
    },
    reset(source) {
      // clearMessages() deletes chat_topics rows. Without dropping the cached
      // {topicId,lastTimestamp} the next saveMessage within gapMs would try to
      // linkMessage to a vanished topic_id and trip the FK constraint.
      if (source === undefined) {
        state.clear();
        hydrated.clear();
        return;
      }
      const k = keyOf(source);
      state.delete(k);
      hydrated.delete(k);
    },
  };
}
