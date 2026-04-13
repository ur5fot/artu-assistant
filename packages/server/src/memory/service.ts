import type Database from 'better-sqlite3';
import type { OllamaClient } from '../ai/ollama.js';
import type { EmbeddingsClient } from './embeddings.js';
import {
  insertEntry,
  insertOrSupersedeFact,
  getActiveFacts,
  vectorSearch,
} from './db.js';
import { extractFacts } from './extractor.js';

export interface MemoryHit {
  text: string;
  kind: 'fact' | 'user_msg' | 'assistant_msg' | 'tool_result';
  score: number;
  timestamp: number;
}

export interface MemoryService {
  indexTurn(params: {
    userMessage: string;
    assistantMessage: string;
    toolResults: Array<{ id: string; name: string; content: string }>;
    timestamp: number;
  }): Promise<void>;

  search(params: {
    query: string;
    kind?: 'fact' | 'entry' | 'all';
    limit?: number;
  }): Promise<MemoryHit[]>;

  getActiveFacts(): Promise<Array<{ key: string; value: string; lastMentionedAt: number }>>;

  buildContextPrefix(userMessage: string): Promise<string>;
}

interface MemoryServiceDeps {
  db: Database.Database;
  embeddings: EmbeddingsClient;
  ollama: OllamaClient;
  extractorModel: string;
  maxContextTokens?: number;
}

const TOOL_RESULT_MAX_CHARS = 2000;
const ENTRY_PREVIEW_MAX_CHARS = 300;

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const { db, embeddings, ollama } = deps;
  const contextBudget = (deps.maxContextTokens ?? 2000) * 4;

  async function safeEmbed(text: string): Promise<number[] | null> {
    try {
      return await embeddings.embed(text);
    } catch (err) {
      console.warn('[memory] embed failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  async function indexOne(
    kind: 'user_msg' | 'assistant_msg' | 'tool_result',
    content: string,
    sourceId: string | null,
    createdAt: number,
  ): Promise<void> {
    const vec = await safeEmbed(content);
    if (!vec) return;
    try {
      insertEntry(db, { kind, sourceId, content, createdAt, embedding: vec });
    } catch (err) {
      console.warn('[memory] insertEntry failed:', err instanceof Error ? err.message : err);
    }
  }

  return {
    async indexTurn(params) {
      const { userMessage, assistantMessage, toolResults, timestamp } = params;

      await Promise.all([
        indexOne('user_msg', userMessage, null, timestamp),
        indexOne('assistant_msg', assistantMessage, null, timestamp),
        ...toolResults.map((tr) =>
          indexOne(
            'tool_result',
            tr.content.length > TOOL_RESULT_MAX_CHARS
              ? tr.content.slice(0, TOOL_RESULT_MAX_CHARS)
              : tr.content,
            tr.id,
            timestamp,
          ),
        ),
      ]);

      let facts: Array<{ key: string; value: string }> = [];
      try {
        facts = await extractFacts(ollama, {
          userMessage,
          assistantMessage,
          model: deps.extractorModel,
        });
      } catch (err) {
        console.warn('[memory] extractFacts failed:', err instanceof Error ? err.message : err);
      }

      for (const fact of facts) {
        const factText = `${fact.key}: ${fact.value}`;
        const vec = await safeEmbed(factText);
        if (!vec) continue;
        try {
          insertOrSupersedeFact(db, {
            key: fact.key,
            value: fact.value,
            createdAt: timestamp,
            embedding: vec,
          });
        } catch (err) {
          console.warn('[memory] insertFact failed:', err instanceof Error ? err.message : err);
        }
      }
    },

    async search(params) {
      const { query, kind = 'all', limit = 10 } = params;
      const vec = await safeEmbed(query);
      if (!vec) return [];

      const hits = vectorSearch(db, { embedding: vec, limit: limit * 2 });
      return hits
        .filter((h) => {
          if (kind === 'fact') return h.entityType === 'fact';
          if (kind === 'entry') return h.entityType === 'entry';
          return true;
        })
        .slice(0, limit)
        .map((h): MemoryHit => ({
          text: h.content,
          kind: h.entityType === 'fact' ? 'fact' : (h.kind as 'user_msg' | 'assistant_msg' | 'tool_result'),
          score: h.score,
          timestamp: h.createdAt,
        }));
    },

    async getActiveFacts() {
      return getActiveFacts(db).map((f) => ({
        key: f.key,
        value: f.value,
        lastMentionedAt: f.lastMentionedAt,
      }));
    },

    async buildContextPrefix(userMessage) {
      const vec = await safeEmbed(userMessage);
      if (!vec) return '';

      const facts = getActiveFacts(db);
      const hits = vectorSearch(db, { embedding: vec, limit: 10 });
      const entryHits = hits.filter((h) => h.entityType === 'entry' && h.score >= 0.6).slice(0, 10);

      if (facts.length === 0 && entryHits.length === 0) return '';

      const lines: string[] = ['=== ПАМ\'ЯТЬ R2 ==='];
      if (facts.length > 0) {
        lines.push('Активні факти про юзера:');
        for (const f of facts.slice(0, 20)) {
          const date = new Date(f.lastMentionedAt).toISOString().slice(0, 10);
          lines.push(`- ${f.key}: ${f.value} (оновлено ${date})`);
        }
        lines.push('');
      }
      if (entryHits.length > 0) {
        lines.push('Релевантні попередні розмови:');
        for (const h of entryHits) {
          const date = new Date(h.createdAt).toISOString().slice(0, 10);
          const preview = h.content.length > ENTRY_PREVIEW_MAX_CHARS
            ? h.content.slice(0, ENTRY_PREVIEW_MAX_CHARS) + '...'
            : h.content;
          const label = h.kind === 'user_msg' ? 'Юзер' : h.kind === 'assistant_msg' ? 'R2' : h.kind;
          lines.push(`[${date}] ${label}: ${preview}`);
        }
      }
      lines.push('=== КОНЕЦ ПАМ\'ЯТІ ===');

      let prefix = lines.join('\n');
      if (prefix.length > contextBudget) {
        prefix = prefix.slice(0, contextBudget) + '\n...';
      }
      return prefix;
    },
  };
}
