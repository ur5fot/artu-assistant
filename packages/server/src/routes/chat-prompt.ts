import type { TopicStore, TopicRow } from '../topics/store.js';
import { truncateMessages } from './chat.js';

export interface BuildCompactedPromptParams<T extends { role: string; content: string }> {
  messages: T[];
  budget: number;
  store: TopicStore | null;
  now: number;
  recentShare?: number;
  summaryShare?: number;
}

export interface BuildCompactedPromptResult<T> {
  messages: T[];
  summaryPrefix: string | null;
}

const DEFAULT_RECENT_SHARE = 0.5;
const DEFAULT_SUMMARY_SHARE = 0.4;

function formatTopicTimestamp(ts: number): string {
  // Stable, locale-independent format: matches the spec template
  // [YYYY-MM-DD HH:MM]. Built from UTC components so test snapshots
  // don't drift with the runner's timezone.
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Neutralize the label/summary that Haiku produced for a topic before they go
// into the prompt block. A user could have pasted text containing our header
// or footer sentinels in an earlier topic; Haiku's faithful summary can echo
// that verbatim, prematurely closing the block and smuggling text into the
// user-message position. Mirrors `sanitizeForMemoryBlock` in memory/service.ts.
function sanitizeTopicText(text: string): string {
  return text
    .replace(/=+\s*Recent\s+topics[^\n]*/gi, '[topic-header]')
    .replace(/=+\s*End\s+topics\s*=+/gi, '[topic-footer]')
    .replace(/[\r\n\u2028\u2029\u0085]+/g, ' ');
}

function buildSummaryPrefix(topics: TopicRow[], budget: number): string | null {
  if (topics.length === 0 || budget <= 0) return null;

  // Rank: importance DESC, finalized_at DESC. Topics not included are
  // silently dropped — they remain reachable via 4A vector recall.
  const ranked = [...topics].sort((a, b) => {
    const impA = a.importance ?? 0;
    const impB = b.importance ?? 0;
    if (impA !== impB) return impB - impA;
    const finA = a.finalized_at ?? 0;
    const finB = b.finalized_at ?? 0;
    return finB - finA;
  });

  const header = '=== Recent topics (older context, summarized) ===';
  const footer = '=== End topics ===';
  const lines: string[] = [];
  let total = header.length + 1 + footer.length;

  for (const topic of ranked) {
    if (!topic.summary || !topic.label) continue;
    const ts = topic.finalized_at ?? topic.ended_at ?? topic.started_at;
    const safeLabel = sanitizeTopicText(topic.label);
    const safeSummary = sanitizeTopicText(topic.summary);
    const line = `[${formatTopicTimestamp(ts)}] ${safeLabel}: ${safeSummary}`;
    const projected = total + line.length + 1;
    if (projected > budget && lines.length > 0) break;
    lines.push(line);
    total = projected;
  }

  if (lines.length === 0) return null;
  return [header, ...lines, footer].join('\n');
}

export function buildCompactedPrompt<T extends { role: string; content: string }>(
  params: BuildCompactedPromptParams<T>,
): BuildCompactedPromptResult<T> {
  const recentShare = params.recentShare ?? DEFAULT_RECENT_SHARE;
  const summaryShare = params.summaryShare ?? DEFAULT_SUMMARY_SHARE;
  const recentBudget = Math.floor(params.budget * recentShare);
  const summaryBudget = Math.floor(params.budget * summaryShare);

  const messages = truncateMessages(params.messages, recentBudget);

  if (!params.store) {
    return { messages, summaryPrefix: null };
  }

  const finalized = params.store.listFinalized(20);
  const summaryPrefix = buildSummaryPrefix(finalized, summaryBudget);

  return { messages, summaryPrefix };
}
