import type Anthropic from '@anthropic-ai/sdk';
import type { TutorLevel } from './store.js';

/** Exercise kinds the generator (and grader) understand. */
export type ExerciseKind = 'mcq' | 'free';

/** MCQ: `options` list + `answer` = index of the correct option. */
export interface McqExercise {
  kind: 'mcq';
  prompt: string;
  options: string[];
  answer: number;
}

/** Free-form: `answer` = reference solution, `rubric` = what to check. */
export interface FreeExercise {
  kind: 'free';
  prompt: string;
  answer: string;
  rubric?: string;
}

export type Exercise = McqExercise | FreeExercise;

/** A generated lesson: topic slug, explanation (EN + RU notes), exercises. */
export interface Lesson {
  topic: string;
  explanation: string;
  exercises: Exercise[];
}

export interface GenerateLessonInput {
  level: TutorLevel;
  /** Recently seen topics — steer the LLM away from repeating them. */
  recentTopics: string[];
  /** Weak topics (low mastery) — steer the LLM toward reinforcing them. */
  weakTopics: string[];
}

export interface LessonGenDeps {
  anthropic: Anthropic;
  model: string;
  signal: AbortSignal;
}

/** Thrown when the LLM cannot produce a valid lesson after one retry. */
export class LessonGenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LessonGenError';
  }
}

const SYSTEM = `Ты персональный учитель английского. Сгенерируй ОДИН короткий адаптивный урок.
Формат ответа — ТОЛЬКО JSON-объект, без текста вокруг:
{
  "topic": "<короткий slug темы>",
  "explanation": "<краткое объяснение темы: английский + заметки на русском>",
  "exercises": [
    { "kind": "mcq",  "prompt": "...", "options": ["a","b","c","d"], "answer": <индекс правильного варианта, 0-based> },
    { "kind": "free", "prompt": "...", "answer": "<эталонный ответ>", "rubric": "<что проверять>" }
  ]
}
Требования:
- 3–5 упражнений, микс mcq и free.
- Сложность соответствует уровню CEFR ученика.
- mcq: 3–4 варианта, "answer" — валидный индекс в "options".
- Тема НЕ должна повторять недавние; при наличии слабых тем — закрепляй их.`;

function buildPrompt(input: GenerateLessonInput): string {
  const recent = input.recentTopics.length
    ? input.recentTopics.join(', ')
    : '(нет)';
  const weak = input.weakTopics.length ? input.weakTopics.join(', ') : '(нет)';
  return [
    `Уровень ученика (CEFR): ${input.level}`,
    `Недавние темы (избегай их): ${recent}`,
    `Слабые темы (закрепляй в приоритете): ${weak}`,
    '',
    'Сгенерируй урок в описанном JSON-формате.',
  ].join('\n');
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

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Validate + narrow raw parsed JSON into a Lesson, or throw on bad shape. */
function toLesson(raw: unknown): Lesson {
  if (!raw || typeof raw !== 'object') {
    throw new Error('lesson is not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (!isNonEmptyString(obj.topic)) throw new Error('missing topic');
  if (!isNonEmptyString(obj.explanation)) throw new Error('missing explanation');
  if (!Array.isArray(obj.exercises) || obj.exercises.length === 0) {
    throw new Error('exercises must be a non-empty array');
  }

  const exercises: Exercise[] = obj.exercises.map((rawEx, i) => {
    if (!rawEx || typeof rawEx !== 'object') {
      throw new Error(`exercise ${i} is not an object`);
    }
    const ex = rawEx as Record<string, unknown>;
    if (!isNonEmptyString(ex.prompt)) {
      throw new Error(`exercise ${i} missing prompt`);
    }
    if (ex.kind === 'mcq') {
      if (
        !Array.isArray(ex.options) ||
        ex.options.length < 2 ||
        !ex.options.every(isNonEmptyString)
      ) {
        throw new Error(`exercise ${i} (mcq) needs ≥2 string options`);
      }
      if (
        typeof ex.answer !== 'number' ||
        !Number.isInteger(ex.answer) ||
        ex.answer < 0 ||
        ex.answer >= ex.options.length
      ) {
        throw new Error(`exercise ${i} (mcq) answer index out of range`);
      }
      return {
        kind: 'mcq',
        prompt: ex.prompt,
        options: ex.options as string[],
        answer: ex.answer,
      };
    }
    if (ex.kind === 'free') {
      if (!isNonEmptyString(ex.answer)) {
        throw new Error(`exercise ${i} (free) missing answer`);
      }
      return {
        kind: 'free',
        prompt: ex.prompt,
        answer: ex.answer,
        rubric: isNonEmptyString(ex.rubric) ? ex.rubric : undefined,
      };
    }
    throw new Error(`exercise ${i} has invalid kind`);
  });

  return { topic: obj.topic, explanation: obj.explanation, exercises };
}

async function callClaude(
  deps: LessonGenDeps,
  userPrompt: string,
): Promise<string> {
  const msg = await deps.anthropic.messages.create(
    {
      model: deps.model,
      max_tokens: 2048,
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
 * Generate one adaptive lesson via Claude. Parses + validates the JSON reply;
 * on a malformed/invalid response retries once, then throws `LessonGenError`.
 */
export async function generateLesson(
  input: GenerateLessonInput,
  deps: LessonGenDeps,
): Promise<Lesson> {
  const prompt = buildPrompt(input);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callClaude(deps, prompt);
      return toLesson(extractJson(raw));
    } catch (err) {
      lastErr = err;
      console.warn(
        `[tutor.lesson-generator] attempt ${attempt + 1} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  throw new LessonGenError('failed to generate a valid lesson', {
    cause: lastErr,
  });
}
