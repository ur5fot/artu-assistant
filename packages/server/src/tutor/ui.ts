// Shared rendering constants/helpers for the two lesson-posting surfaces:
// the `/english` Discord flow (tutor-handlers.ts) and the daily proactive
// handler (cognition/handlers/englishLesson.ts).

import { PASS_THRESHOLD } from './session.js';

// Discord button labels are capped at 80 chars and must be non-empty.
export const BUTTON_LABEL_MAX = 80;

// Mastery below this counts a topic as "weak" — fed back to the generator so
// the next lesson reinforces it. Same cutoff as a lesson "pass".
export const WEAK_MASTERY_THRESHOLD = PASS_THRESHOLD;

// How many recent topics to steer the generator away from repeating.
export const RECENT_TOPICS_LIMIT = 5;

export function truncateLabel(s: string): string {
  const t = s.trim() || '—';
  return t.length > BUTTON_LABEL_MAX ? t.slice(0, BUTTON_LABEL_MAX - 1) + '…' : t;
}
