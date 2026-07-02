import type Anthropic from '@anthropic-ai/sdk';
import type { FreeExercise, McqExercise } from './lesson-generator.js';

/** Verdict the free-form grader may return for an answer. */
export type FreeVerdict = 'correct' | 'partial' | 'wrong';

export interface McqResult {
  correct: boolean;
}

export interface FreeResult {
  verdict: FreeVerdict;
  /** Short explanation in Russian of what was right/wrong. */
  feedback: string;
}

export interface GradeFreeDeps {
  anthropic: Anthropic;
  model: string;
  signal: AbortSignal;
}

/** Thrown when the LLM grader fails or returns an unusable reply. We never
 *  fabricate a verdict — the caller keeps `current_ex` put and can retry. */
export class GradeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GradeError';
  }
}

/**
 * Grade an MCQ answer deterministically: `true` iff `choiceIdx` equals the
 * exercise's stored answer index. Out-of-range choices are simply incorrect.
 */
export function gradeMcq(
  exercise: McqExercise,
  choiceIdx: number,
): McqResult {
  return { correct: choiceIdx === exercise.answer };
}

const SYSTEM = `Ты проверяешь ответ ученика на упражнение по английскому.
Верни ТОЛЬКО JSON-объект без текста вокруг:
{ "verdict": "correct" | "partial" | "wrong", "feedback": "<разбор на русском>" }
Правила:
- "correct" — ответ верный по смыслу и грамматике.
- "partial" — частично верно (есть суть, но с ошибками).
- "wrong" — неверно.
- feedback — короткий разбор на РУССКОМ: что верно, что исправить.`;

function buildPrompt(exercise: FreeExercise, userAnswer: string): string {
  return [
    `Задание: ${exercise.prompt}`,
    `Эталонный ответ: ${exercise.answer}`,
    exercise.rubric ? `Что проверять: ${exercise.rubric}` : null,
    `Ответ ученика: ${userAnswer}`,
    '',
    'Оцени ответ ученика в описанном JSON-формате.',
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

/** Pull a JSON object out of an LLM reply, tolerating ```json fences and prose. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const trimmed = candidate.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('no JSON object found');
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

const VERDICTS: readonly FreeVerdict[] = ['correct', 'partial', 'wrong'];

function toFreeResult(raw: unknown): FreeResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('grade is not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (!VERDICTS.includes(obj.verdict as FreeVerdict)) {
    throw new Error('invalid verdict');
  }
  if (typeof obj.feedback !== 'string' || obj.feedback.trim().length === 0) {
    throw new Error('missing feedback');
  }
  return { verdict: obj.verdict as FreeVerdict, feedback: obj.feedback };
}

async function callClaude(
  deps: GradeFreeDeps,
  userPrompt: string,
): Promise<string> {
  const msg = await deps.anthropic.messages.create(
    {
      model: deps.model,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    },
    { signal: deps.signal },
  );
  const block = (msg.content as Array<{ type: string; text?: string }>).find(
    (b) => b.type === 'text',
  );
  return block?.text ?? '';
}

/**
 * Grade a free-form answer via Claude. Returns a verdict + Russian feedback.
 * On any LLM/parse failure throws `GradeError` — we do not invent a verdict, so
 * the session can keep `current_ex` unchanged and let the user answer again.
 */
export async function gradeFree(
  exercise: FreeExercise,
  userAnswer: string,
  deps: GradeFreeDeps,
): Promise<FreeResult> {
  const prompt = buildPrompt(exercise, userAnswer);
  try {
    const raw = await callClaude(deps, prompt);
    return toFreeResult(extractJson(raw));
  } catch (err) {
    throw new GradeError('failed to grade free answer', { cause: err });
  }
}
