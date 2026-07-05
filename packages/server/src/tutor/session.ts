import type { Exercise, Lesson } from './lesson-generator.js';
import { placementInProgress } from './placement.js';
import type {
  LessonStatus,
  TutorLesson,
  TutorStore,
} from './store.js';

/** Per-exercise outcome accumulated as the learner works through a lesson. */
export interface ExerciseResult {
  correct: boolean;
}

/** Lesson payload as stored: the generated lesson plus accumulated results. */
export interface LessonPayload extends Lesson {
  results?: ExerciseResult[];
}

/** Result of applying one answer via {@link advance}. */
export type AdvanceResult =
  | {
      done: false;
      lesson: TutorLesson;
      nextIndex: number;
      nextExercise: Exercise;
    }
  | {
      done: true;
      lesson: TutorLesson;
      /** Final lesson score in [0, 1] = correct answers / total exercises. */
      score: number;
    };

/** What the free-text chat hook should route the next message to. */
export type Routing =
  | { kind: 'none' }
  | { kind: 'placement' }
  | { kind: 'free'; lesson: TutorLesson };

/** Correctness threshold above which a completed lesson counts as "passed". */
export const PASS_THRESHOLD = 0.5;

/** Map an exercise to the lesson status that awaits its answer. */
export function statusForExercise(exercise: Exercise): LessonStatus {
  return exercise.kind === 'mcq' ? 'awaiting_mcq' : 'awaiting_free';
}

function payloadOf(lesson: TutorLesson): LessonPayload {
  const p = lesson.payload as LessonPayload | null;
  if (!p || !Array.isArray(p.exercises) || p.exercises.length === 0) {
    throw new Error(`lesson ${lesson.id} has no exercises`);
  }
  return p;
}

/** The exercise the lesson is currently waiting on, or null when out of range. */
export function currentExercise(lesson: TutorLesson): Exercise | null {
  const { exercises } = payloadOf(lesson);
  return exercises[lesson.currentEx] ?? null;
}

/**
 * Apply one graded answer to a lesson's current exercise, advance the state
 * machine, and persist. While exercises remain, moves `current_ex` forward and
 * updates `status` to await the next exercise (`awaiting_mcq`/`awaiting_free`).
 * On the final exercise, marks the lesson `done`, stores the aggregate score,
 * and folds it into the topic's `tutor_progress` mastery.
 */
export function advance(
  store: TutorStore,
  lesson: TutorLesson,
  outcome: ExerciseResult,
): AdvanceResult {
  if (lesson.status === 'done') {
    throw new Error(`lesson ${lesson.id} is already done`);
  }
  const payload = payloadOf(lesson);
  const { exercises } = payload;
  const index = lesson.currentEx;
  if (index < 0 || index >= exercises.length) {
    throw new Error(`lesson ${lesson.id} current_ex ${index} out of range`);
  }

  const results = [...(payload.results ?? [])];
  results[index] = { correct: outcome.correct };
  const nextPayload: LessonPayload = { ...payload, results };

  const isLast = index === exercises.length - 1;
  if (!isLast) {
    const nextIndex = index + 1;
    const nextExercise = exercises[nextIndex];
    const updated = store.updateLesson(lesson.id, {
      payload: nextPayload,
      currentEx: nextIndex,
      status: statusForExercise(nextExercise),
    });
    return { done: false, lesson: updated, nextIndex, nextExercise };
  }

  const correctCount = results.filter((r) => r?.correct).length;
  const score = correctCount / exercises.length;
  store.updateLesson(lesson.id, { payload: nextPayload });
  const completed = store.completeLesson(lesson.id, score);
  store.recordAttempt({
    topic: lesson.topic,
    correct: score >= PASS_THRESHOLD,
    outcome: score,
  });
  return { done: true, lesson: completed, score };
}

/**
 * Decide where the free-text chat hook should send the next message: to an
 * in-progress placement, to the grader for an `awaiting_free` lesson, or
 * nowhere (normal assistant). Placement onboarding takes precedence.
 */
export function routingState(store: TutorStore): Routing {
  if (placementInProgress(store)) return { kind: 'placement' };
  const lesson = store.getActiveLesson();
  if (lesson && lesson.status === 'awaiting_free') {
    return { kind: 'free', lesson };
  }
  return { kind: 'none' };
}
