import type { TopicStore } from './store.js';

export const TOPIC_GAP_MS = 2 * 60 * 60 * 1000;

export interface IncomingMessage {
  messageId: string;
  timestamp: number;
  source: string | null;
}

export interface TopicDetector {
  assign(message: IncomingMessage): void;
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
      state.set(k, { topicId: current.topicId, lastTimestamp: timestamp });
    },
  };
}
