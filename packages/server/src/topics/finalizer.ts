import type Anthropic from '@anthropic-ai/sdk';
import type { Handler } from '../cognition/types.js';
import type { MemoryService } from '../memory/service.js';
import type { ChatMessageRow, TopicStore } from './store.js';

/**
 * Background finalizer for closed chat topics.
 *
 * Picks topics that have been closed for at least `bufferMs` (so streaming
 * tool-loop turns can still settle) and asks Claude Haiku for a
 * {label, summary, importance} JSON object. Successes go to
 * `chat_topics.finalized` + `memory_vec` (kind=topic_summary) and feed the
 * 4A facts pipeline. Parse / API failures bump a per-topic counter; after
 * `maxFailures` we mark the topic finalized with a placeholder so it does
 * not get retried forever.
 */

interface Deps {
  store: TopicStore;
  memoryService: MemoryService;
  anthropic: Anthropic;
  extractorModel: string;
  bufferMs: number;
  finalizeBatch: number;
  maxFailures: number;
}

const HAIKU_MAX_TOKENS = 600;
// Claude SDK defaults to 10 min per request. Topic summarization is short and
// runs on a cognition tick — cap at 30s so a wedged Haiku call does not block
// the next handler in the queue for the full SDK window.
const HAIKU_TIMEOUT_MS = 30_000;
// A single 2-hour topic can accumulate tens of thousands of tokens (file
// pastes, tool output, web search results). Cap the transcript fed to Haiku
// so cost stays bounded; if the transcript exceeds the cap, drop oldest
// messages first (newest carry the decisions/outcomes the summary needs).
const PROMPT_BODY_MAX_CHARS = 60_000;
// Heuristic: matches "/cmd" or "/команда" optionally followed by args.
// chat.ts deliberately skips indexTurn for slash-command turns (the literal
// "/cmd …" text is a dispatcher, not user content; assistant replies carry
// tool results that bypass PII masking). The finalizer must mirror that skip
// so the Haiku summary and extracted facts don't reintroduce the same
// content via the topic_summary prefix and memory_facts table.
const SLASH_COMMAND_RE = /^\/[\p{L}\p{N}_-]+(?:\s|$)/u;

const PROMPT_HEADER = `You will receive a transcript of a conversation between a user and an AI assistant. Produce a concise summary capturing decisions, outcomes, and key facts. Skip pleasantries and verbose tool output.

Return ONLY valid JSON in this exact shape (no markdown fence, no prose):
{"label": "5-7 words", "summary": "300-500 characters", "importance": 1-10, "action_required": "≤7 words or null", "target_url": "url or null"}

Importance scale:
- 7-9: plans/decisions made, code shipped, bugs fixed
- 4-6: ongoing investigation, partial work
- 1-3: chitchat, one-off question, error retry

action_required: if the owner still has a manual EXTERNAL action to do that this assistant cannot do for them — confirm a permission, pay an invoice, reply somewhere — state it in ≤7 words. Otherwise null. Do NOT invent actions; null is the common case.
target_url: the URL that action points to, if one appears in the transcript; else null.

Transcript:`;

interface ParsedSummary {
  label: string;
  summary: string;
  importance: number;
  actionRequired: string | null;
  targetUrl: string | null;
}

function formatMessage(m: ChatMessageRow): string {
  const role = m.role === 'user' ? 'User' : 'R2';
  if (m.tool_calls) {
    let names: string[] = [];
    try {
      const calls = JSON.parse(m.tool_calls) as Array<{ name?: string }>;
      if (Array.isArray(calls)) names = calls.map((c) => c?.name ?? 'tool').filter(Boolean);
    } catch {
      names = ['tool'];
    }
    const placeholder = names.length === 0
      ? '<tool: unknown — invoked>'
      : names.map((n) => `<tool: ${n} — invoked>`).join(' ');
    const text = m.content?.trim() ? `${m.content}\n${placeholder}` : placeholder;
    return `${role}: ${text}`;
  }
  return `${role}: ${m.content ?? ''}`;
}

function filterDispatcherTurns(messages: ChatMessageRow[]): ChatMessageRow[] {
  // Drop user messages that are slash-command dispatchers, and the assistant
  // turn that immediately answers them (tool result + commentary). Mixed
  // topics keep their normal conversational turns intact.
  const result: ChatMessageRow[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && SLASH_COMMAND_RE.test(m.content.trim())) {
      if (i + 1 < messages.length && messages[i + 1].role === 'assistant') {
        i++;
      }
      continue;
    }
    result.push(m);
  }
  return result;
}

function buildPrompt(messages: ChatMessageRow[]): string {
  const formatted = messages.map(formatMessage);
  let total = formatted.reduce((sum, line) => sum + line.length + 1, 0);
  let dropped = 0;
  while (total > PROMPT_BODY_MAX_CHARS && formatted.length > 1) {
    const removed = formatted.shift()!;
    total -= removed.length + 1;
    dropped++;
  }
  // Single remaining message can still exceed the cap on its own (e.g. one
  // multi-megabyte web paste). Truncate it so the Haiku call stays bounded.
  if (formatted.length === 1 && formatted[0].length > PROMPT_BODY_MAX_CHARS) {
    const marker = '\n[...message truncated]';
    const room = PROMPT_BODY_MAX_CHARS - marker.length;
    formatted[0] = room > 0
      ? formatted[0].slice(0, room) + marker
      : formatted[0].slice(0, PROMPT_BODY_MAX_CHARS);
  }
  const body = formatted.join('\n');
  const prefix = dropped > 0 ? `[...${dropped} earlier message(s) truncated]\n` : '';
  return `${PROMPT_HEADER}\n${prefix}${body}`;
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseSummary(raw: string): ParsedSummary | null {
  const obj = extractJsonObject(raw);
  if (!obj) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(obj);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const label = typeof o.label === 'string' ? o.label.trim() : '';
  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  const importanceRaw = typeof o.importance === 'number' ? o.importance : Number(o.importance);
  if (!label || !summary || !Number.isFinite(importanceRaw)) return null;
  const importance = Math.min(10, Math.max(1, Math.round(importanceRaw)));
  return {
    label,
    summary,
    importance,
    actionRequired: parseNullableString(o.action_required),
    targetUrl: parseNullableString(o.target_url),
  };
}

// Haiku may emit a missing field, a real null, or the literal string "null".
// Normalize all of those to null; only a non-empty meaningful string survives.
function parseNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

export function createTopicFinalizerHandler(deps: Deps): Handler {
  const { store, memoryService, anthropic, extractorModel, bufferMs, finalizeBatch, maxFailures } = deps;

  return {
    name: 'topicFinalizer',
    async trigger(state) {
      const cutoff = state.now - bufferMs;
      const ready = store.listClosedReadyForFinalize(cutoff, finalizeBatch);
      return ready.length > 0;
    },
    async run(ctx) {
      const now = ctx.firedAt;
      const cutoff = now - bufferMs;
      const ready = store.listClosedReadyForFinalize(cutoff, finalizeBatch);
      if (ready.length === 0) return { skip: true, reason: 'no topics ready' };

      let finalized = 0;
      let failed = 0;
      for (const topic of ready) {
        if (ctx.signal.aborted) break;
        const rawMessages = store.getTopicMessages(topic.id);
        if (rawMessages.length === 0) {
          // Defensive: a closed topic with zero linked messages is a bug
          // upstream, but giving up immediately keeps the queue moving.
          store.markFinalizationGiveUp(topic.id, now);
          failed++;
          continue;
        }

        const messages = filterDispatcherTurns(rawMessages);
        if (messages.length === 0) {
          // Pure slash-command topic: every turn was a dispatcher we must not
          // summarize or extract facts from. Mark finalized with the same
          // placeholder used for irrecoverable failures so the topic is no
          // longer eligible for re-processing.
          store.markFinalizationGiveUp(topic.id, now);
          continue;
        }

        const prompt = buildPrompt(messages);
        let responseText = '';
        try {
          const msg = await anthropic.messages.create(
            {
              model: extractorModel,
              max_tokens: HAIKU_MAX_TOKENS,
              temperature: 0,
              messages: [{ role: 'user', content: prompt }],
            },
            { signal: ctx.signal, timeout: HAIKU_TIMEOUT_MS },
          );
          const block = (msg.content as Array<{ type: string; text?: string }>).find(
            (b) => b.type === 'text',
          );
          responseText = block?.text ?? '';
        } catch (err) {
          const count = store.markFinalizationFailure(topic.id);
          console.warn(
            `[topicFinalizer] Haiku call failed for topic ${topic.id} (attempt ${count}):`,
            err instanceof Error ? err.message : err,
          );
          if (count >= maxFailures) {
            store.markFinalizationGiveUp(topic.id, now);
            console.warn(
              `[topicFinalizer] topic ${topic.id} gave up after ${count} failures`,
            );
          }
          failed++;
          continue;
        }

        const parsed = parseSummary(responseText);
        if (!parsed) {
          const count = store.markFinalizationFailure(topic.id);
          console.warn(
            `[topicFinalizer] could not parse Haiku JSON for topic ${topic.id} (attempt ${count})`,
          );
          if (count >= maxFailures) {
            store.markFinalizationGiveUp(topic.id, now);
            console.warn(
              `[topicFinalizer] topic ${topic.id} gave up after ${count} failures`,
            );
          }
          failed++;
          continue;
        }

        store.finalize(
          topic.id,
          parsed.label,
          parsed.summary,
          parsed.importance,
          now,
          parsed.actionRequired,
          parsed.targetUrl,
        );

        // Embedding + facts run after finalize so a downstream failure does
        // not roll back the chat_topics row — the topic is summarized; only
        // the vector recall / facts side is best-effort.
        try {
          await memoryService.indexTopicSummary({
            topicId: topic.id,
            label: parsed.label,
            summary: parsed.summary,
            finalizedAt: now,
          });
        } catch (err) {
          console.warn(
            `[topicFinalizer] indexTopicSummary failed for topic ${topic.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
        try {
          await memoryService.extractFactsFromConversation({
            messages: messages.map((m) => ({
              role: m.role,
              content: m.content,
              messageId: m.message_id,
              timestamp: m.timestamp,
            })),
          });
        } catch (err) {
          console.warn(
            `[topicFinalizer] extractFactsFromConversation failed for topic ${topic.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
        console.log(`[topicFinalizer] finalized topic ${topic.id}: ${parsed.label}`);
        finalized++;
      }

      if (finalized === 0 && failed > 0) {
        return { skip: true, reason: `${failed} topic(s) failed finalization` };
      }
      return { skip: true, reason: `finalized ${finalized} topic(s)${failed ? `, ${failed} failed` : ''}` };
    },
  };
}
