import { describe, it, expect, vi } from 'vitest';
import { gradeMcq, gradeFree, GradeError } from './grader.js';
import type { FreeExercise, McqExercise } from './lesson-generator.js';

const MCQ: McqExercise = {
  kind: 'mcq',
  prompt: 'She ___ to school yesterday.',
  options: ['go', 'went', 'gone'],
  answer: 1,
};

const FREE: FreeExercise = {
  kind: 'free',
  prompt: 'Напиши предложение в Past Simple.',
  answer: 'I visited my grandma.',
  rubric: 'Проверь корректную форму глагола в прошедшем.',
};

/** Build a stub Anthropic client whose reply text comes from `replies`, one per
 *  call. Records the last user prompt for assertions. */
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
    gradeDeps: {
      anthropic: anthropic as any,
      model: 'claude-test',
      signal: new AbortController().signal,
    },
  };
}

/** An Anthropic stub whose `create` rejects — simulates an LLM/network error. */
function throwingDeps() {
  const anthropic = {
    messages: {
      create: vi.fn(async () => {
        throw new Error('network down');
      }),
    },
  };
  return {
    anthropic: anthropic as any,
    model: 'claude-test',
    signal: new AbortController().signal,
  };
}

describe('gradeMcq', () => {
  it('returns correct when the chosen index matches the answer', () => {
    expect(gradeMcq(MCQ, 1)).toEqual({ correct: true });
  });

  it('returns incorrect when the chosen index differs', () => {
    expect(gradeMcq(MCQ, 0)).toEqual({ correct: false });
  });

  it('treats an out-of-range choice as incorrect', () => {
    expect(gradeMcq(MCQ, 5)).toEqual({ correct: false });
    expect(gradeMcq(MCQ, -1)).toEqual({ correct: false });
  });
});

describe('gradeFree', () => {
  it('parses a correct verdict with feedback', async () => {
    const { gradeDeps } = deps([
      JSON.stringify({ verdict: 'correct', feedback: 'Отлично, всё верно.' }),
    ]);
    const res = await gradeFree(FREE, 'I visited my grandma.', gradeDeps);
    expect(res).toEqual({ verdict: 'correct', feedback: 'Отлично, всё верно.' });
  });

  it('parses a partial verdict', async () => {
    const { gradeDeps } = deps([
      JSON.stringify({ verdict: 'partial', feedback: 'Почти, но артикль лишний.' }),
    ]);
    const res = await gradeFree(FREE, 'I visit the grandma.', gradeDeps);
    expect(res.verdict).toBe('partial');
  });

  it('parses a wrong verdict', async () => {
    const { gradeDeps } = deps([
      JSON.stringify({ verdict: 'wrong', feedback: 'Нужно прошедшее время.' }),
    ]);
    const res = await gradeFree(FREE, 'I go to grandma.', gradeDeps);
    expect(res.verdict).toBe('wrong');
  });

  it('tolerates ```json fences and surrounding prose', async () => {
    const wrapped =
      'Оценка:\n```json\n' +
      JSON.stringify({ verdict: 'correct', feedback: 'Верно.' }) +
      '\n```\nГотово.';
    const { gradeDeps } = deps([wrapped]);
    const res = await gradeFree(FREE, 'I visited my grandma.', gradeDeps);
    expect(res.verdict).toBe('correct');
  });

  it('includes prompt, reference answer, rubric and user answer in the request', async () => {
    const { gradeDeps, calls } = deps([
      JSON.stringify({ verdict: 'correct', feedback: 'Верно.' }),
    ]);
    await gradeFree(FREE, 'I visited my grandma.', gradeDeps);
    const prompt = calls[0].userPrompt;
    expect(prompt).toContain('Past Simple');
    expect(prompt).toContain('I visited my grandma.');
    expect(prompt).toContain('корректную форму');
    expect(calls[0].model).toBe('claude-test');
  });

  it('throws GradeError when the LLM call fails', async () => {
    await expect(
      gradeFree(FREE, 'answer', throwingDeps()),
    ).rejects.toBeInstanceOf(GradeError);
  });

  it('throws GradeError on malformed JSON (no fabricated verdict)', async () => {
    const { gradeDeps } = deps(['полная ерунда без json']);
    await expect(gradeFree(FREE, 'answer', gradeDeps)).rejects.toBeInstanceOf(
      GradeError,
    );
  });

  it('throws GradeError on an invalid verdict value', async () => {
    const { gradeDeps } = deps([
      JSON.stringify({ verdict: 'maybe', feedback: 'hmm' }),
    ]);
    await expect(gradeFree(FREE, 'answer', gradeDeps)).rejects.toBeInstanceOf(
      GradeError,
    );
  });

  it('throws GradeError when feedback is missing', async () => {
    const { gradeDeps } = deps([JSON.stringify({ verdict: 'correct' })]);
    await expect(gradeFree(FREE, 'answer', gradeDeps)).rejects.toBeInstanceOf(
      GradeError,
    );
  });
});
