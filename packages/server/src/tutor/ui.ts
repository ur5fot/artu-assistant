// Shared rendering constants/helpers for the two lesson-posting surfaces:
// the `/english` Discord flow (tutor-handlers.ts) and the daily proactive
// handler (cognition/handlers/englishLesson.ts).

import { PASS_THRESHOLD } from './session.js';
import type { TutorProgress } from './store.js';

// Discord button labels are capped at 80 chars and must be non-empty.
export const BUTTON_LABEL_MAX = 80;

// Discord message bodies are capped at 2000 chars.
export const MESSAGE_MAX = 2000;

// Mastery below this counts a topic as "weak" — fed back to the generator so
// the next lesson reinforces it. Same cutoff as a lesson "pass".
export const WEAK_MASTERY_THRESHOLD = PASS_THRESHOLD;

// How many recent topics to steer the generator away from repeating.
export const RECENT_TOPICS_LIMIT = 5;

export function truncateLabel(s: string): string {
  const t = s.trim() || '—';
  return t.length > BUTTON_LABEL_MAX ? t.slice(0, BUTTON_LABEL_MAX - 1) + '…' : t;
}

/** Split text into ≤2000-char chunks on word boundaries (hard split when a
 *  chunk has no space). Rejoining non-space-split chunks restores the text. */
export function splitDiscordContent(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MESSAGE_MAX) {
    let splitAt = remaining.lastIndexOf(' ', MESSAGE_MAX);
    if (splitAt <= 0) splitAt = MESSAGE_MAX;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  chunks.push(remaining);
  return chunks;
}

/** Topic steering for the lesson generator: recent topics to avoid repeating
 *  and weak topics to reinforce. A topic that is both recent and weak goes only
 *  to the weak list — reinforcement wins, so the generation prompt never tells
 *  the LLM to simultaneously avoid and prioritize the same topic. */
export function topicSteering(progress: TutorProgress[]): {
  recentTopics: string[];
  weakTopics: string[];
} {
  const weakTopics = progress
    .filter((p) => p.mastery < WEAK_MASTERY_THRESHOLD)
    .map((p) => p.topic);
  const weak = new Set(weakTopics);
  const recentTopics = progress
    .slice(0, RECENT_TOPICS_LIMIT)
    .map((p) => p.topic)
    .filter((t) => !weak.has(t));
  return { recentTopics, weakTopics };
}
