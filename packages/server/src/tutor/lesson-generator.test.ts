import { describe, it, expect, vi } from 'vitest';
import {
  generateLesson,
  LessonGenError,
  type GenerateLessonInput,
} from './lesson-generator.js';

const VALID_LESSON = {
  topic: 'past-simple',
  explanation: 'Past Simple описывает завершённые действия. RU: прошедшее время.',
  exercises: [
    {
      kind: 'mcq',
      prompt: 'She ___ to school yesterday.',
      options: ['go', 'went', 'gone'],
      answer: 1,
    },
    {
      kind: 'free',
      prompt: 'Напиши предложение в Past Simple.',
      answer: 'I visited my grandma.',
      rubric: 'Проверь корректную форму глагола в прошедшем.',
    },
  ],
};

/** Build a stub Anthropic client whose reply text comes from `replies`, one per
 *  call. Records the last user prompt/model for assertions. */
function stubAnthropic(replies: string[]) {
  const calls: Array<{ model: string; system: string; userPrompt: string }> = [];
  let i = 0;
  const anthropic = {
    messages: {
      create: vi.fn(async (params: any) => {
        calls.push({
          model: params.model,
          system: params.system,
          userPrompt: params.messages[0].content,
        });
        const text = replies[Math.min(i, replies.length - 1)];
        i++;
        return { content: [{ type: 'text', text }] };
      }),
    },
  };
  return { anthropic, calls };
}

function deps(replies: string[]) {
  const { anthropic, calls } = stubAnthropic(replies);
  return {
    calls,
    createDeps: {
      anthropic: anthropic as any,
      model: 'claude-test',
      signal: new AbortController().signal,
    },
  };
}

const INPUT: GenerateLessonInput = {
  level: 'B1',
  recentTopics: ['present-perfect', 'articles'],
  weakTopics: ['conditionals'],
};

describe('generateLesson', () => {
  it('parses a valid JSON object into a Lesson', async () => {
    const { createDeps } = deps([JSON.stringify(VALID_LESSON)]);
    const lesson = await generateLesson(INPUT, createDeps);
    expect(lesson.topic).toBe('past-simple');
    expect(lesson.exercises).toHaveLength(2);
    expect(lesson.exercises[0]).toMatchObject({ kind: 'mcq', answer: 1 });
    expect(lesson.exercises[1]).toMatchObject({ kind: 'free' });
  });

  it('tolerates ```json fences and surrounding prose', async () => {
    const wrapped = 'Вот урок:\n```json\n' + JSON.stringify(VALID_LESSON) + '\n```\nГотово.';
    const { createDeps } = deps([wrapped]);
    const lesson = await generateLesson(INPUT, createDeps);
    expect(lesson.topic).toBe('past-simple');
  });

  it('includes level, recent and weak topics in the prompt', async () => {
    const { createDeps, calls } = deps([JSON.stringify(VALID_LESSON)]);
    await generateLesson(INPUT, createDeps);
    const prompt = calls[0].userPrompt;
    expect(prompt).toContain('B1');
    expect(prompt).toContain('present-perfect');
    expect(prompt).toContain('conditionals');
    expect(calls[0].model).toBe('claude-test');
  });

  it('handles empty recent/weak topic lists', async () => {
    const { createDeps, calls } = deps([JSON.stringify(VALID_LESSON)]);
    await generateLesson(
      { level: 'A1', recentTopics: [], weakTopics: [] },
      createDeps,
    );
    expect(calls[0].userPrompt).toContain('(нет)');
  });

  it('retries once on malformed JSON, then succeeds', async () => {
    const { createDeps, calls } = deps([
      'полная ерунда без json',
      JSON.stringify(VALID_LESSON),
    ]);
    const lesson = await generateLesson(INPUT, createDeps);
    expect(lesson.topic).toBe('past-simple');
    expect(calls).toHaveLength(2);
  });

  it('throws LessonGenError after a second failure', async () => {
    const { createDeps, calls } = deps(['nope', 'still nope']);
    await expect(generateLesson(INPUT, createDeps)).rejects.toBeInstanceOf(
      LessonGenError,
    );
    expect(calls).toHaveLength(2);
  });

  it('rejects a lesson with no exercises', async () => {
    const bad = JSON.stringify({ ...VALID_LESSON, exercises: [] });
    const { createDeps } = deps([bad, bad]);
    await expect(generateLesson(INPUT, createDeps)).rejects.toBeInstanceOf(
      LessonGenError,
    );
  });

  it('rejects an mcq whose answer index is out of range', async () => {
    const bad = JSON.stringify({
      topic: 't',
      explanation: 'e',
      exercises: [
        { kind: 'mcq', prompt: 'p', options: ['a', 'b'], answer: 5 },
      ],
    });
    const { createDeps } = deps([bad, bad]);
    await expect(generateLesson(INPUT, createDeps)).rejects.toBeInstanceOf(
      LessonGenError,
    );
  });

  it('rejects an exercise with an invalid kind', async () => {
    const bad = JSON.stringify({
      topic: 't',
      explanation: 'e',
      exercises: [{ kind: 'essay', prompt: 'p' }],
    });
    const { createDeps } = deps([bad, bad]);
    await expect(generateLesson(INPUT, createDeps)).rejects.toBeInstanceOf(
      LessonGenError,
    );
  });

  it('rejects a free exercise missing its reference answer', async () => {
    const bad = JSON.stringify({
      topic: 't',
      explanation: 'e',
      exercises: [{ kind: 'free', prompt: 'p' }],
    });
    const { createDeps } = deps([bad, bad]);
    await expect(generateLesson(INPUT, createDeps)).rejects.toBeInstanceOf(
      LessonGenError,
    );
  });
});
