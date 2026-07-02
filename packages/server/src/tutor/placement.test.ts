import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initDb, getDb } from '../db.js';
import { createTutorStore } from './store.js';
import {
  startPlacement,
  assessPlacement,
  beginPlacement,
  recordPlacementAnswer,
  finishPlacement,
  placementInProgress,
  PlacementError,
  type PlacementQuestion,
} from './placement.js';

beforeEach(() => initDb(':memory:'));

function store() {
  return createTutorStore({ db: getDb() });
}

/** Six MCQ questions of ascending difficulty (valid placement set). */
function sixQuestions(): PlacementQuestion[] {
  return Array.from({ length: 6 }, (_, i) => ({
    prompt: `Question ${i + 1}`,
    options: ['a', 'b', 'c'],
    answer: i % 3,
  }));
}

/** Stub Anthropic client whose reply text comes from `replies`, one per call. */
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
    placementDeps: {
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

describe('startPlacement', () => {
  it('parses a valid ascending-difficulty question set', async () => {
    const { placementDeps } = deps([
      JSON.stringify({ questions: sixQuestions() }),
    ]);
    const questions = await startPlacement(placementDeps);
    expect(questions).toHaveLength(6);
    expect(questions[0].prompt).toBe('Question 1');
    expect(questions[0].answer).toBe(0);
  });

  it('tolerates ```json fences around the payload', async () => {
    const wrapped =
      'Тест:\n```json\n' +
      JSON.stringify({ questions: sixQuestions() }) +
      '\n```';
    const { placementDeps } = deps([wrapped]);
    const questions = await startPlacement(placementDeps);
    expect(questions).toHaveLength(6);
  });

  it('retries once on malformed JSON, then succeeds', async () => {
    const { placementDeps, calls } = deps([
      'не json',
      JSON.stringify({ questions: sixQuestions() }),
    ]);
    const questions = await startPlacement(placementDeps);
    expect(questions).toHaveLength(6);
    expect(calls).toHaveLength(2);
  });

  it('throws PlacementError when too few questions are returned', async () => {
    const { placementDeps } = deps([
      JSON.stringify({ questions: sixQuestions().slice(0, 3) }),
    ]);
    await expect(startPlacement(placementDeps)).rejects.toBeInstanceOf(
      PlacementError,
    );
  });

  it('throws PlacementError when the answer index is out of range', async () => {
    const bad = sixQuestions();
    bad[0].answer = 9;
    const { placementDeps } = deps([JSON.stringify({ questions: bad })]);
    await expect(startPlacement(placementDeps)).rejects.toBeInstanceOf(
      PlacementError,
    );
  });

  it('throws PlacementError after two failed attempts', async () => {
    await expect(startPlacement(throwingDeps())).rejects.toBeInstanceOf(
      PlacementError,
    );
  });
});

describe('assessPlacement', () => {
  const qa = sixQuestions().map((question, i) => ({
    question,
    choice: i % 3,
  }));

  it('returns a valid CEFR level', async () => {
    const { placementDeps } = deps([JSON.stringify({ level: 'B1' })]);
    const res = await assessPlacement(qa, placementDeps);
    expect(res).toEqual({ level: 'B1' });
  });

  it('includes each question and correctness in the prompt', async () => {
    const { placementDeps, calls } = deps([JSON.stringify({ level: 'A2' })]);
    await assessPlacement(qa, placementDeps);
    const prompt = calls[0].userPrompt;
    expect(prompt).toContain('Question 1');
    expect(prompt).toContain('верно');
  });

  it('throws PlacementError on an invalid level value', async () => {
    const { placementDeps } = deps([JSON.stringify({ level: 'Z9' })]);
    await expect(assessPlacement(qa, placementDeps)).rejects.toBeInstanceOf(
      PlacementError,
    );
  });

  it('throws PlacementError on an empty question set', async () => {
    const { placementDeps } = deps([JSON.stringify({ level: 'B1' })]);
    await expect(assessPlacement([], placementDeps)).rejects.toBeInstanceOf(
      PlacementError,
    );
  });

  it('throws PlacementError when the LLM call fails', async () => {
    await expect(assessPlacement(qa, throwingDeps())).rejects.toBeInstanceOf(
      PlacementError,
    );
  });
});

describe('placement store flow', () => {
  it('begins placement, persisting in_progress state and the first question', async () => {
    const s = store();
    const { placementDeps } = deps([
      JSON.stringify({ questions: sixQuestions() }),
    ]);
    const step = await beginPlacement(s, placementDeps);
    expect(step).toEqual({
      done: false,
      question: expect.objectContaining({ prompt: 'Question 1' }),
      index: 0,
      total: 6,
    });
    const profile = s.getProfile();
    expect(profile?.placementState).toBe('in_progress');
    expect(placementInProgress(s)).toBe(true);
  });

  it('collects answers step by step, then completes with a CEFR level', async () => {
    const s = store();
    const { placementDeps } = deps([
      JSON.stringify({ questions: sixQuestions() }),
      JSON.stringify({ level: 'B2' }),
    ]);
    await beginPlacement(s, placementDeps);

    // Answer the first five — each returns the next question.
    for (let i = 0; i < 5; i++) {
      const step = await recordPlacementAnswer(s, 0, placementDeps);
      expect(step.done).toBe(false);
      if (!step.done) expect(step.index).toBe(i + 1);
    }

    // Sixth answer triggers assessment + completion.
    const last = await recordPlacementAnswer(s, 0, placementDeps);
    expect(last).toEqual({ done: true, level: 'B2' });

    const profile = s.getProfile();
    expect(profile?.placementState).toBe('done');
    expect(profile?.level).toBe('B2');
    expect(profile?.placementPayload).toBeNull();
    expect(placementInProgress(s)).toBe(false);
  });

  it('throws when answering with no placement in progress', async () => {
    const s = store();
    const { placementDeps } = deps([JSON.stringify({ level: 'B1' })]);
    await expect(
      recordPlacementAnswer(s, 0, placementDeps),
    ).rejects.toBeInstanceOf(PlacementError);
  });

  it('keeps answered state intact when final assessment fails (resumable)', async () => {
    const s = store();
    // Questions generate fine; assessment always errors.
    let generated = false;
    const failing = {
      anthropic: {
        messages: {
          create: vi.fn(async (params: any) => {
            if (!generated) {
              generated = true;
              return {
                content: [
                  { type: 'text', text: JSON.stringify({ questions: sixQuestions() }) },
                ],
              };
            }
            throw new Error('assessment down');
          }),
        },
      } as any,
      model: 'claude-test',
      signal: new AbortController().signal,
    };

    await beginPlacement(s, failing);
    for (let i = 0; i < 5; i++) {
      await recordPlacementAnswer(s, 0, failing);
    }
    await expect(
      recordPlacementAnswer(s, 0, failing),
    ).rejects.toBeInstanceOf(PlacementError);

    // State preserved: still in_progress with all six answers collected.
    const profile = s.getProfile();
    expect(profile?.placementState).toBe('in_progress');
    const payload = profile?.placementPayload as { answers: number[] };
    expect(payload.answers).toHaveLength(6);

    // A retry via finishPlacement can now succeed.
    const { placementDeps: okDeps } = deps([JSON.stringify({ level: 'C1' })]);
    const res = await finishPlacement(s, okDeps);
    expect(res).toEqual({ level: 'C1' });
    expect(s.getProfile()?.level).toBe('C1');
  });
});
