import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../db.js';
import { createTutorStore, type TutorStore } from './store.js';
import type { Exercise, Lesson } from './lesson-generator.js';
import {
  advance,
  currentExercise,
  routingState,
  statusForExercise,
  type LessonPayload,
} from './session.js';

beforeEach(() => initDb(':memory:'));

function store(): TutorStore {
  return createTutorStore({ db: getDb() });
}

const mcq: Exercise = {
  kind: 'mcq',
  prompt: 'pick',
  options: ['a', 'b'],
  answer: 0,
};
const free: Exercise = {
  kind: 'free',
  prompt: 'write',
  answer: 'ref',
};

function lessonPayload(exercises: Exercise[]): Lesson {
  return { topic: 'past-simple', explanation: 'x', exercises };
}

/** Create a lesson with the given exercises and a status matching exercise 0. */
function seed(s: TutorStore, exercises: Exercise[]) {
  const lesson = s.createLesson({
    topic: 'past-simple',
    payload: lessonPayload(exercises),
  });
  return s.updateLesson(lesson.id, {
    status: statusForExercise(exercises[0]),
  });
}

describe('tutor session — statusForExercise', () => {
  it('maps mcq → awaiting_mcq and free → awaiting_free', () => {
    expect(statusForExercise(mcq)).toBe('awaiting_mcq');
    expect(statusForExercise(free)).toBe('awaiting_free');
  });
});

describe('tutor session — advance', () => {
  it('walks awaiting_mcq → awaiting_free → done', () => {
    const s = store();
    let lesson = seed(s, [mcq, free]);
    expect(lesson.status).toBe('awaiting_mcq');

    const step1 = advance(s, lesson, { correct: true });
    expect(step1.done).toBe(false);
    if (step1.done) throw new Error('unreachable');
    expect(step1.nextIndex).toBe(1);
    expect(step1.nextExercise).toEqual(free);
    expect(step1.lesson.status).toBe('awaiting_free');
    expect(step1.lesson.currentEx).toBe(1);

    const step2 = advance(s, step1.lesson, { correct: false });
    expect(step2.done).toBe(true);
    if (!step2.done) throw new Error('unreachable');
    expect(step2.lesson.status).toBe('done');
    // 1 of 2 correct
    expect(step2.score).toBeCloseTo(0.5, 10);
    expect(step2.lesson.score).toBeCloseTo(0.5, 10);
    expect(step2.lesson.completedAt).not.toBeNull();
  });

  it('records per-exercise results into the payload', () => {
    const s = store();
    const lesson = seed(s, [mcq, free]);
    const step1 = advance(s, lesson, { correct: true });
    if (step1.done) throw new Error('unreachable');
    const payload = step1.lesson.payload as LessonPayload;
    expect(payload.results).toEqual([{ correct: true }]);
  });

  it('folds the final score into tutor_progress mastery on done', () => {
    const s = store();
    const lesson = seed(s, [mcq]); // single exercise → immediate done
    const step = advance(s, lesson, { correct: true });
    expect(step.done).toBe(true);
    if (!step.done) throw new Error('unreachable');
    expect(step.score).toBe(1);

    const progress = s.getProgress('past-simple');
    expect(progress).not.toBeNull();
    expect(progress!.attempts).toBe(1);
    expect(progress!.correct).toBe(1); // score 1 ≥ pass threshold
    expect(progress!.mastery).toBe(1); // first attempt seeds at outcome
  });

  it('a failed lesson records outcome below the pass threshold', () => {
    const s = store();
    const lesson = seed(s, [mcq]);
    const step = advance(s, lesson, { correct: false });
    if (!step.done) throw new Error('unreachable');
    expect(step.score).toBe(0);
    const progress = s.getProgress('past-simple')!;
    expect(progress.correct).toBe(0);
    expect(progress.mastery).toBe(0);
  });

  it('throws when the lesson is already done', () => {
    const s = store();
    const lesson = seed(s, [mcq]);
    const step = advance(s, lesson, { correct: true });
    if (!step.done) throw new Error('unreachable');
    expect(() => advance(s, step.lesson, { correct: true })).toThrow();
  });

  it('throws when current_ex is out of range', () => {
    const s = store();
    const lesson = seed(s, [mcq]);
    const bad = s.updateLesson(lesson.id, { currentEx: 5 });
    expect(() => advance(s, bad, { correct: true })).toThrow();
  });
});

describe('tutor session — currentExercise', () => {
  it('returns the exercise at current_ex', () => {
    const s = store();
    const lesson = seed(s, [mcq, free]);
    expect(currentExercise(lesson)).toEqual(mcq);
    const moved = s.updateLesson(lesson.id, { currentEx: 1 });
    expect(currentExercise(moved)).toEqual(free);
  });

  it('returns null past the last exercise', () => {
    const s = store();
    const lesson = seed(s, [mcq]);
    const moved = s.updateLesson(lesson.id, { currentEx: 1 });
    expect(currentExercise(moved)).toBeNull();
  });

  it('throws for a lesson whose payload has no exercises', () => {
    const s = store();
    const lesson = s.createLesson({
      topic: 'broken',
      payload: { ...lessonPayload([]), exercises: [] },
    });
    expect(() => currentExercise(lesson)).toThrow(/no exercises/);
    expect(() => advance(s, lesson, { correct: true })).toThrow(/no exercises/);
  });
});

describe('tutor session — routingState', () => {
  it('is none with no profile and no active lesson', () => {
    expect(routingState(store()).kind).toBe('none');
  });

  it('routes to placement while placement is in_progress', () => {
    const s = store();
    s.updateProfile({
      placementState: 'in_progress',
      placementPayload: { questions: [{ prompt: 'q', options: ['a'], answer: 0 }], answers: [] },
    });
    expect(routingState(s).kind).toBe('placement');
  });

  it('routes free text to an awaiting_free lesson', () => {
    const s = store();
    seed(s, [free]); // active lesson, status awaiting_free
    const routing = routingState(s);
    expect(routing.kind).toBe('free');
    if (routing.kind !== 'free') throw new Error('unreachable');
    expect(routing.lesson.status).toBe('awaiting_free');
  });

  it('does not route when the active lesson awaits an mcq', () => {
    const s = store();
    seed(s, [mcq]);
    expect(routingState(s).kind).toBe('none');
  });

  it('does not route when the lesson is done', () => {
    const s = store();
    const lesson = seed(s, [free]);
    s.completeLesson(lesson.id, 1);
    expect(routingState(s).kind).toBe('none');
  });

  it('placement takes precedence over an awaiting_free lesson', () => {
    const s = store();
    seed(s, [free]);
    s.updateProfile({
      placementState: 'in_progress',
      placementPayload: { questions: [{ prompt: 'q', options: ['a'], answer: 0 }], answers: [] },
    });
    expect(routingState(s).kind).toBe('placement');
  });
});
