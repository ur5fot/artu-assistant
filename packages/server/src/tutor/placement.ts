import type { TutorLevel, TutorStore } from './store.js';
import { callClaude, extractJson, isNonEmptyString } from './llm.js';
import type { ClaudeCallDeps } from './llm.js';

/** One placement question: MCQ so answers can be collected without the LLM. */
export interface PlacementQuestion {
  prompt: string;
  options: string[];
  /** Index of the correct option in `options`. */
  answer: number;
}

/** A question paired with the learner's chosen option index. */
export interface PlacementQA {
  question: PlacementQuestion;
  choice: number;
}

/** Intermediate placement state persisted in `placement_payload`. */
export interface PlacementState {
  questions: PlacementQuestion[];
  /** Chosen option indices so far; `answers.length` = questions answered. */
  answers: number[];
}

export type PlacementDeps = ClaudeCallDeps;

/** One step of the answer-by-answer placement flow (`recordPlacementAnswer`).
 *  `cancelled` means `/english stop` raced the final assessment call and won:
 *  there is no level and nothing to show, since the stop already replied. */
export type PlacementStep =
  | { done: false; question: PlacementQuestion; index: number; total: number }
  | { done: true; level: TutorLevel }
  | { done: true; cancelled: true };

/** Result of starting placement: always the first question (never `done`). */
export interface PlacementStart {
  done: false;
  question: PlacementQuestion;
  index: number;
  total: number;
}

/** Thrown when the LLM fails to produce valid questions or a valid level.
 *  Placement state is left intact so the flow can be resumed/retried. */
export class PlacementError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PlacementError';
  }
}

const MIN_QUESTIONS = 5;
const MAX_QUESTIONS = 10;
const CEFR_LEVELS: readonly TutorLevel[] = [
  'A1',
  'A2',
  'B1',
  'B2',
  'C1',
  'C2',
];

const START_SYSTEM = `Ты составляешь короткий placement-тест по английскому.
Верни ТОЛЬКО JSON-объект без текста вокруг:
{
  "questions": [
    { "prompt": "...", "options": ["a","b","c","d"], "answer": <индекс правильного варианта, 0-based> }
  ]
}
Требования:
- ${MIN_QUESTIONS}–${MAX_QUESTIONS} вопросов, строго по ВОЗРАСТАНИЮ сложности (от A1 к C2).
- Каждый вопрос — multiple choice, 3–4 варианта, ровно один верный.
- "answer" — валидный индекс в "options".
- Вопросы на грамматику/лексику, кратко.`;

const ASSESS_SYSTEM = `Ты оцениваешь уровень английского по результатам placement-теста.
Верни ТОЛЬКО JSON-объект без текста вокруг:
{ "level": "A1" | "A2" | "B1" | "B2" | "C1" | "C2" }
Правила:
- Учитывай, на какие вопросы (по возрастанию сложности) ученик ответил верно.
- "level" — итоговый CEFR-уровень.`;

function toQuestions(raw: unknown): PlacementQuestion[] {
  if (!raw || typeof raw !== 'object') {
    throw new Error('response is not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (
    !Array.isArray(obj.questions) ||
    obj.questions.length < MIN_QUESTIONS ||
    obj.questions.length > MAX_QUESTIONS
  ) {
    throw new Error(
      `questions must be an array of ${MIN_QUESTIONS}–${MAX_QUESTIONS} items`,
    );
  }
  return obj.questions.map((rawQ, i) => {
    if (!rawQ || typeof rawQ !== 'object') {
      throw new Error(`question ${i} is not an object`);
    }
    const q = rawQ as Record<string, unknown>;
    if (!isNonEmptyString(q.prompt)) {
      throw new Error(`question ${i} missing prompt`);
    }
    if (
      !Array.isArray(q.options) ||
      q.options.length < 2 ||
      q.options.length > 4 ||
      !q.options.every(isNonEmptyString)
    ) {
      throw new Error(`question ${i} needs 2–4 string options`);
    }
    if (
      typeof q.answer !== 'number' ||
      !Number.isInteger(q.answer) ||
      q.answer < 0 ||
      q.answer >= q.options.length
    ) {
      throw new Error(`question ${i} answer index out of range`);
    }
    return {
      prompt: q.prompt,
      options: q.options as string[],
      answer: q.answer,
    };
  });
}

function toLevel(raw: unknown): TutorLevel {
  if (!raw || typeof raw !== 'object') {
    throw new Error('response is not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (!CEFR_LEVELS.includes(obj.level as TutorLevel)) {
    throw new Error('invalid CEFR level');
  }
  return obj.level as TutorLevel;
}

/**
 * Generate the placement questions via Claude (5–10 MCQ, ascending difficulty).
 * Retries once on a malformed reply, then throws `PlacementError`.
 */
export async function startPlacement(
  deps: PlacementDeps,
): Promise<PlacementQuestion[]> {
  const prompt = `Сгенерируй placement-тест из ${MIN_QUESTIONS}–${MAX_QUESTIONS} вопросов в описанном JSON-формате.`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callClaude(deps, START_SYSTEM, prompt, 2048);
      return toQuestions(extractJson(raw));
    } catch (err) {
      lastErr = err;
      console.warn(
        `[tutor.placement] startPlacement attempt ${attempt + 1} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  throw new PlacementError('failed to generate placement questions', {
    cause: lastErr,
  });
}

function buildAssessPrompt(qa: PlacementQA[]): string {
  const lines = qa.map((item, i) => {
    const chosen = item.question.options[item.choice] ?? '(нет ответа)';
    const correct = item.question.options[item.question.answer];
    const ok = item.choice === item.question.answer ? 'верно' : 'неверно';
    return [
      `Вопрос ${i + 1}: ${item.question.prompt}`,
      `  Ответ ученика: ${chosen} (${ok})`,
      `  Правильный ответ: ${correct}`,
    ].join('\n');
  });
  return [
    'Результаты placement-теста (вопросы по возрастанию сложности):',
    ...lines,
    '',
    'Определи итоговый CEFR-уровень в описанном JSON-формате.',
  ].join('\n');
}

/**
 * Assess collected question/answer pairs into a CEFR level via Claude.
 * Retries once on a malformed reply, then throws `PlacementError`.
 */
export async function assessPlacement(
  qa: PlacementQA[],
  deps: PlacementDeps,
): Promise<{ level: TutorLevel }> {
  if (qa.length === 0) {
    throw new PlacementError('cannot assess an empty placement');
  }
  const prompt = buildAssessPrompt(qa);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callClaude(deps, ASSESS_SYSTEM, prompt, 2048);
      return { level: toLevel(extractJson(raw)) };
    } catch (err) {
      lastErr = err;
      console.warn(
        `[tutor.placement] assessPlacement attempt ${attempt + 1} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  throw new PlacementError('failed to assess placement', { cause: lastErr });
}

/** Read the in-progress placement state from the profile, if any. */
function readState(store: TutorStore): PlacementState | null {
  const profile = store.getProfile();
  if (!profile || profile.placementState !== 'in_progress') return null;
  const payload = profile.placementPayload as PlacementState | null;
  if (!payload || !Array.isArray(payload.questions)) return null;
  return { questions: payload.questions, answers: payload.answers ?? [] };
}

/** True when a placement is mid-flight (used for chat routing). */
export function placementInProgress(store: TutorStore): boolean {
  return readState(store) !== null;
}

/**
 * Begin (or restart) placement: generate questions, persist state as
 * `in_progress`, and return the first question.
 */
export async function beginPlacement(
  store: TutorStore,
  deps: PlacementDeps,
): Promise<PlacementStart> {
  const questions = await startPlacement(deps);
  store.updateProfile({
    placementState: 'in_progress',
    placementPayload: { questions, answers: [] } satisfies PlacementState,
  });
  return { done: false, question: questions[0], index: 0, total: questions.length };
}

/**
 * Finalize placement from the fully-answered state: assess → CEFR, then set
 * `level` + `placement_state = done`. On LLM failure throws `PlacementError`
 * with the answered state left intact for a retry.
 */
export async function finishPlacement(
  store: TutorStore,
  deps: PlacementDeps,
): Promise<{ level: TutorLevel } | { cancelled: true }> {
  const state = readState(store);
  if (!state) throw new PlacementError('no placement in progress');
  if (state.answers.length < state.questions.length) {
    throw new PlacementError('placement not fully answered');
  }
  const qa: PlacementQA[] = state.questions.map((question, i) => ({
    question,
    choice: state.answers[i],
  }));
  const { level } = await assessPlacement(qa, deps);
  // Re-check freshness: `/english stop` can cancel the placement (setting
  // `placementState` back to `none`) while this LLM call was in flight, since
  // interaction handling isn't serialized against it. Don't resurrect a
  // cancelled placement with a stale result, and tell the caller so it
  // doesn't announce a level that was never persisted.
  if (!readState(store)) return { cancelled: true };
  store.updateProfile({
    level,
    placementState: 'done',
    placementPayload: null,
  });
  return { level };
}

/**
 * Record one placement answer against the in-progress state. Persists the
 * choice, then either returns the next question or — on the last answer —
 * assesses and completes placement. LLM failure during assessment throws
 * `PlacementError`; the answers stay persisted so it can be retried.
 */
export async function recordPlacementAnswer(
  store: TutorStore,
  choice: number,
  deps: PlacementDeps,
): Promise<PlacementStep> {
  const state = readState(store);
  if (!state) throw new PlacementError('no placement in progress');
  if (state.answers.length >= state.questions.length) {
    throw new PlacementError('placement already fully answered');
  }
  const answers = [...state.answers, choice];
  store.updateProfile({
    placementPayload: {
      questions: state.questions,
      answers,
    } satisfies PlacementState,
  });
  if (answers.length < state.questions.length) {
    return {
      done: false,
      question: state.questions[answers.length],
      index: answers.length,
      total: state.questions.length,
    };
  }
  const outcome = await finishPlacement(store, deps);
  if ('cancelled' in outcome) return { done: true, cancelled: true };
  return { done: true, level: outcome.level };
}
