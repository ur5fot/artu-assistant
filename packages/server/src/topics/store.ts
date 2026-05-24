import type Database from 'better-sqlite3';

export type TopicStatus = 'open' | 'closed' | 'finalized';

export interface TopicRow {
  id: number;
  label: string | null;
  summary: string | null;
  importance: number | null;
  started_at: number;
  ended_at: number | null;
  status: TopicStatus;
  source: string | null;
  finalized_at: number | null;
  failure_count: number;
}

export interface ChatMessageRow {
  message_id: string;
  role: 'user' | 'assistant';
  content: string;
  tool_calls: string | null;
  pii_entities: string | null;
  timestamp: number;
  source: string | null;
}

export interface TopicStore {
  getOpenTopic(source: string | null): TopicRow | null;
  createOpen(now: number, source: string | null): TopicRow;
  closeOpen(topicId: number, endedAt: number): void;
  linkMessage(topicId: number, messageId: string): void;
  listClosedReadyForFinalize(cutoff: number, limit: number): TopicRow[];
  finalize(topicId: number, label: string, summary: string, importance: number, now: number): void;
  markFinalizationFailure(topicId: number): number;
  markFinalizationGiveUp(topicId: number, now: number): void;
  findStaleOpen(cutoff: number): TopicRow[];
  getTopicMessages(topicId: number): ChatMessageRow[];
  listFinalized(limit: number): TopicRow[];
}

interface StoreDeps {
  db: Database.Database;
}

function rowToTopic(raw: any): TopicRow {
  return {
    id: raw.id,
    label: raw.label ?? null,
    summary: raw.summary ?? null,
    importance: raw.importance ?? null,
    started_at: raw.started_at,
    ended_at: raw.ended_at ?? null,
    status: raw.status as TopicStatus,
    source: raw.source ?? null,
    finalized_at: raw.finalized_at ?? null,
    failure_count: raw.failure_count ?? 0,
  };
}

export function createTopicStore(deps: StoreDeps): TopicStore {
  const { db } = deps;

  return {
    getOpenTopic(source) {
      const rows = (
        source === null
          ? db.prepare(`SELECT * FROM chat_topics WHERE status = 'open' AND source IS NULL`).all()
          : db.prepare(`SELECT * FROM chat_topics WHERE status = 'open' AND source = ?`).all(source)
      ) as any[];
      if (rows.length === 0) return null;
      if (rows.length > 1) {
        throw new Error(
          `TopicStore invariant violated: ${rows.length} open topics for source=${source}`,
        );
      }
      return rowToTopic(rows[0]);
    },

    createOpen(now, source) {
      const stmt = db.prepare(`
        INSERT INTO chat_topics (started_at, status, source, failure_count)
        VALUES (?, 'open', ?, 0)
      `);
      const result = stmt.run(now, source);
      const id = Number(result.lastInsertRowid);
      const row = db.prepare('SELECT * FROM chat_topics WHERE id = ?').get(id);
      return rowToTopic(row);
    },

    closeOpen(topicId, endedAt) {
      db.prepare(`
        UPDATE chat_topics
        SET status = 'closed', ended_at = ?
        WHERE id = ? AND status = 'open'
      `).run(endedAt, topicId);
    },

    linkMessage(topicId, messageId) {
      db.prepare(`
        INSERT OR IGNORE INTO chat_topic_messages (topic_id, message_id)
        VALUES (?, ?)
      `).run(topicId, messageId);
    },

    listClosedReadyForFinalize(cutoff, limit) {
      const rows = db.prepare(`
        SELECT * FROM chat_topics
        WHERE status = 'closed' AND ended_at < ?
        ORDER BY ended_at ASC
        LIMIT ?
      `).all(cutoff, limit) as any[];
      return rows.map(rowToTopic);
    },

    finalize(topicId, label, summary, importance, now) {
      db.prepare(`
        UPDATE chat_topics
        SET status = 'finalized',
            label = ?,
            summary = ?,
            importance = ?,
            finalized_at = ?
        WHERE id = ?
      `).run(label, summary, importance, now, topicId);
    },

    markFinalizationFailure(topicId) {
      db.prepare(`
        UPDATE chat_topics
        SET failure_count = failure_count + 1
        WHERE id = ?
      `).run(topicId);
      const row = db
        .prepare('SELECT failure_count FROM chat_topics WHERE id = ?')
        .get(topicId) as { failure_count: number } | undefined;
      return row?.failure_count ?? 0;
    },

    markFinalizationGiveUp(topicId, now) {
      db.prepare(`
        UPDATE chat_topics
        SET status = 'finalized',
            label = '[finalization failed]',
            summary = NULL,
            importance = 0,
            finalized_at = ?
        WHERE id = ?
      `).run(now, topicId);
    },

    findStaleOpen(cutoff) {
      // An "open" topic is stale if its most recent linked message is older
      // than cutoff. Topics with no linked messages are considered stale
      // (defensive — they shouldn't accumulate, but if one does we close it).
      const rows = db.prepare(`
        SELECT t.*
        FROM chat_topics t
        LEFT JOIN (
          SELECT ctm.topic_id, MAX(cm.timestamp) AS last_ts
          FROM chat_topic_messages ctm
          JOIN chat_messages cm ON cm.message_id = ctm.message_id
          GROUP BY ctm.topic_id
        ) lm ON lm.topic_id = t.id
        WHERE t.status = 'open'
          AND (lm.last_ts IS NULL OR lm.last_ts < ?)
      `).all(cutoff) as any[];
      return rows.map(rowToTopic);
    },

    getTopicMessages(topicId) {
      const rows = db.prepare(`
        SELECT cm.message_id, cm.role, cm.content, cm.tool_calls, cm.pii_entities, cm.timestamp, cm.source
        FROM chat_topic_messages ctm
        JOIN chat_messages cm ON cm.message_id = ctm.message_id
        WHERE ctm.topic_id = ?
        ORDER BY cm.timestamp ASC, cm.id ASC
      `).all(topicId) as any[];
      return rows.map((r) => ({
        message_id: r.message_id,
        role: r.role as 'user' | 'assistant',
        content: r.content,
        tool_calls: r.tool_calls ?? null,
        pii_entities: r.pii_entities ?? null,
        timestamp: r.timestamp,
        source: r.source ?? null,
      }));
    },

    listFinalized(limit) {
      const rows = db.prepare(`
        SELECT * FROM chat_topics
        WHERE status = 'finalized' AND summary IS NOT NULL
        ORDER BY finalized_at DESC
        LIMIT ?
      `).all(limit) as any[];
      return rows.map(rowToTopic);
    },
  };
}
