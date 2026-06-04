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
  action_required: string | null;
  action_dismissed_at: number | null;
  target_url: string | null;
}

export interface OpenAction {
  topicId: number;
  label: string;
  action: string;
  url: string | null;
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
  finalize(
    topicId: number,
    label: string,
    summary: string,
    importance: number,
    now: number,
    actionRequired?: string | null,
    targetUrl?: string | null,
  ): void;
  getOpenActions(): OpenAction[];
  dismissAction(topicId: number, now: number): void;
  reopenAction(topicId: number): void;
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
    action_required: raw.action_required ?? null,
    action_dismissed_at: raw.action_dismissed_at ?? null,
    target_url: raw.target_url ?? null,
  };
}

export function createTopicStore(deps: StoreDeps): TopicStore {
  const { db } = deps;

  return {
    getOpenTopic(source) {
      const rows = (
        source === null
          ? db.prepare(`SELECT * FROM chat_topics WHERE status = 'open' AND source IS NULL ORDER BY id DESC`).all()
          : db.prepare(`SELECT * FROM chat_topics WHERE status = 'open' AND source = ? ORDER BY id DESC`).all(source)
      ) as any[];
      if (rows.length === 0) return null;
      if (rows.length > 1) {
        // Recover instead of throwing: a thrown invariant bubbles through
        // saveMessage → Discord ingest and locks the user out with a generic
        // "something went wrong" message on every subsequent inbound DM. Close
        // the older rows (keeping the newest, by id) and log loudly so the
        // upstream cause can still be investigated from logs.
        console.warn(
          `[TopicStore] ${rows.length} open topics for source=${source}; closing older rows and keeping id=${rows[0].id}`,
        );
        const keepId = rows[0].id as number;
        const closeStmt = db.prepare(
          `UPDATE chat_topics SET status = 'closed', ended_at = COALESCE(ended_at, started_at) WHERE id = ?`,
        );
        for (let i = 1; i < rows.length; i++) {
          closeStmt.run(rows[i].id);
        }
        return rowToTopic({ ...rows[0], id: keepId });
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

    finalize(topicId, label, summary, importance, now, actionRequired = null, targetUrl = null) {
      db.prepare(`
        UPDATE chat_topics
        SET status = 'finalized',
            label = ?,
            summary = ?,
            importance = ?,
            finalized_at = ?,
            action_required = ?,
            target_url = ?
        WHERE id = ?
      `).run(label, summary, importance, now, actionRequired, targetUrl, topicId);
    },

    getOpenActions() {
      // An open action is a finalized topic the owner still has an external
      // task for (action_required set) that hasn't been closed (no dismiss
      // timestamp). Newest first so the brief surfaces the freshest first.
      const rows = db.prepare(`
        SELECT id, label, action_required, target_url
        FROM chat_topics
        WHERE status = 'finalized'
          AND action_required IS NOT NULL
          AND action_dismissed_at IS NULL
        ORDER BY finalized_at DESC
      `).all() as any[];
      return rows.map((r) => ({
        topicId: r.id as number,
        label: (r.label ?? '') as string,
        action: r.action_required as string,
        url: (r.target_url ?? null) as string | null,
      }));
    },

    dismissAction(topicId, now) {
      // Guard on action_dismissed_at IS NULL so a repeat tap (or a tap on an
      // old brief's button for an already-closed action) is a no-op and keeps
      // the original close timestamp — idempotent.
      db.prepare(`
        UPDATE chat_topics
        SET action_dismissed_at = ?
        WHERE id = ? AND action_dismissed_at IS NULL
      `).run(now, topicId);
    },

    reopenAction(topicId) {
      // Inverse of dismissAction: clear the dismiss timestamp so the action is
      // open again (resurfaces in getOpenActions / the next brief). Guard on
      // action_dismissed_at IS NOT NULL so a repeat tap (or a tap on an action
      // that was never dismissed) is a no-op — idempotent, stale-safe.
      db.prepare(`
        UPDATE chat_topics
        SET action_dismissed_at = NULL
        WHERE id = ? AND action_dismissed_at IS NOT NULL
      `).run(topicId);
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
