import type Anthropic from '@anthropic-ai/sdk';
import type { Handler, ComponentData } from '../types.js';
import type { TutorStore, TutorLesson } from '../../tutor/store.js';
import { generateLesson } from '../../tutor/lesson-generator.js';
import type { Lesson } from '../../tutor/lesson-generator.js';
import { statusForExercise } from '../../tutor/session.js';
import { isSameLocalDate } from './morningBrief.helpers.js';

const TZ = 'Europe/Kyiv';
// Mastery below this counts a topic as "weak" — reinforced next lesson. Mirrors
// session.ts PASS_THRESHOLD and tutor-handlers.ts.
const WEAK_MASTERY_THRESHOLD = 0.5;
// How many recent topics to steer the generator away from repeating.
const RECENT_TOPICS_LIMIT = 5;
// Discord button labels are capped at 80 chars and must be non-empty.
const BUTTON_LABEL_MAX = 80;

export interface EnglishLessonDeps {
  // Flag gate. When false the handler is inert (trigger never fires); Task 9
  // registers it only when ENGLISH_TUTOR_ENABLED, so this is a belt-and-braces
  // guard that also keeps the trigger unit-testable.
  enabled: boolean;
  store: TutorStore;
  anthropic: Anthropic;
  model: string;
  // Local hour (in TZ) at/after which the daily lesson may post.
  hour: number;
  tz?: string;
  // Quiet window: no lesson when local hour >= quietStart or < quietEnd.
  quietStart?: number;
  quietEnd?: number;
}

function localHour(epochMs: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  });
  return Number(fmt.format(new Date(epochMs)));
}

function inQuietHours(
  hour: number,
  quietStart: number,
  quietEnd: number,
): boolean {
  return hour >= quietStart || hour < quietEnd;
}

function truncateLabel(s: string): string {
  const t = s.trim() || '—';
  return t.length > BUTTON_LABEL_MAX ? t.slice(0, BUTTON_LABEL_MAX - 1) + '…' : t;
}

/** Render the lesson's first exercise as publishable content + components:
 *  MCQ → option-button row (`tutor:mcq:<lessonId>:<exIdx>:<choice>`); free →
 *  no components, prompt to answer in chat (Task 7's hook routes that reply). */
function firstExerciseMessage(
  lesson: TutorLesson,
  parsed: Lesson,
): { content: string; components?: ComponentData[] } {
  const ex = parsed.exercises[0];
  const total = parsed.exercises.length;
  const header = `📘 **${parsed.topic}**\n${parsed.explanation}\n\nУпражнение 1/${total}`;
  if (ex.kind === 'mcq') {
    const buttons = ex.options.map((opt, i) => ({
      customId: `tutor:mcq:${lesson.id}:0:${i}`,
      label: truncateLabel(opt),
      style: 'secondary' as const,
    }));
    return {
      content: `${header}\n${ex.prompt}`,
      components: [{ type: 'row', buttons }],
    };
  }
  return {
    content: `${header}\n${ex.prompt}\n\n✍️ Ответь сообщением в чат.`,
  };
}

/**
 * Daily proactive English lesson. Fires once per local day at/after the target
 * hour when: flag on, placement done, not paused, outside quiet hours, and no
 * unfinished lesson. `run` generates a lesson, persists it, and posts the
 * explanation + first exercise. A generation failure skips without creating
 * any state, so the next tick can retry cleanly.
 */
export function createEnglishLessonHandler(deps: EnglishLessonDeps): Handler {
  const {
    enabled,
    store,
    anthropic,
    model,
    hour,
    tz = TZ,
    quietStart = 22,
    quietEnd = 8,
  } = deps;

  return {
    name: 'englishLesson',
    trigger(state) {
      if (!enabled) return false;

      // Self-gate: a successful publish today blocks re-firing across the rest
      // of the day. Errors and skips fall through to retry on the next tick.
      const publishedToday =
        state.lastResult !== null &&
        'publish' in state.lastResult &&
        state.lastResult.publish === true &&
        state.lastFiredAt !== null &&
        isSameLocalDate(state.lastFiredAt, state.now, tz);
      if (publishedToday) return false;

      const profile = store.getProfile();
      if (!profile || profile.placementState !== 'done') return false;
      if (profile.paused) return false;

      const h = localHour(state.now, tz);
      if (h < hour) return false;
      if (inQuietHours(h, quietStart, quietEnd)) return false;

      // Never overlap an unfinished lesson.
      if (store.getActiveLesson()) return false;

      return true;
    },
    async run(ctx) {
      const profile = store.getProfile();
      if (!profile || !profile.level) {
        return { skip: true, reason: 'no level' };
      }

      const progress = store.listProgress();
      const recentTopics = progress
        .slice(0, RECENT_TOPICS_LIMIT)
        .map((p) => p.topic);
      const weakTopics = progress
        .filter((p) => p.mastery < WEAK_MASTERY_THRESHOLD)
        .map((p) => p.topic);

      let lesson: Lesson;
      try {
        lesson = await generateLesson(
          { level: profile.level, recentTopics, weakTopics },
          { anthropic, model, signal: ctx.signal },
        );
      } catch (err) {
        return {
          skip: true,
          reason: `lesson generation failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }

      // generateLesson awaited an LLM call; re-check no lesson was created in
      // the meantime (e.g. a concurrent /english) before inserting a second one.
      if (store.getActiveLesson()) {
        return { skip: true, reason: 'lesson created concurrently' };
      }

      const created = store.createLesson({
        topic: lesson.topic,
        payload: lesson,
      });
      const withStatus = store.updateLesson(created.id, {
        status: statusForExercise(lesson.exercises[0]),
      });
      const msg = firstExerciseMessage(withStatus, lesson);
      return msg.components
        ? { publish: true, content: msg.content, components: msg.components }
        : { publish: true, content: msg.content };
    },
  };
}
