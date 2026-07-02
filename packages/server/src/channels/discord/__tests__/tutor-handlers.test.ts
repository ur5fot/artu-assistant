import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initDb, getDb } from '../../../db.js';
import { createTutorStore } from '../../../tutor/store.js';
import type { TutorStore } from '../../../tutor/store.js';
import {
  handleEnglishSlash,
  handleTutorMcqButton,
  type TutorInteractionDeps,
} from '../tutor-handlers.js';

beforeEach(() => initDb(':memory:'));

const LESSON = {
  topic: 'past-simple',
  explanation: 'Past Simple описывает завершённые действия.',
  exercises: [
    {
      kind: 'mcq' as const,
      prompt: 'She ___ to school yesterday.',
      options: ['go', 'went', 'gone'],
      answer: 1,
    },
    {
      kind: 'mcq' as const,
      prompt: 'They ___ football.',
      options: ['play', 'played', 'playing'],
      answer: 1,
    },
  ],
};

const PLACEMENT_QUESTIONS = {
  questions: Array.from({ length: 5 }, (_, i) => ({
    prompt: `Q${i + 1}?`,
    options: ['a', 'b', 'c'],
    answer: 0,
  })),
};

/** Stub Anthropic whose reply text comes from `replies`, one per call. */
function stubAnthropic(replies: string[]) {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        const text = replies[Math.min(i, replies.length - 1)];
        i++;
        return { content: [{ type: 'text', text }] };
      }),
    },
  };
}

function makeDeps(opts?: {
  enabled?: boolean;
  replies?: string[];
}): TutorInteractionDeps & { store: TutorStore } {
  return {
    enabled: opts?.enabled ?? true,
    store: createTutorStore({ db: getDb() }),
    anthropic: stubAnthropic(opts?.replies ?? []) as any,
    model: 'claude-test',
  };
}

/** Fake slash interaction recording every reply-family call. */
function fakeSlash(action?: string) {
  const calls: Array<{ method: string; payload: any }> = [];
  const rec = (method: string) => async (payload?: any) => {
    calls.push({ method, payload });
  };
  return {
    calls,
    options: { getString: (name: string) => (name === 'action' ? action ?? null : null) },
    reply: rec('reply'),
    editReply: rec('editReply'),
    deferReply: rec('deferReply'),
  };
}

function fakeButton() {
  const calls: Array<{ method: string; payload: any }> = [];
  const rec = (method: string) => async (payload?: any) => {
    calls.push({ method, payload });
  };
  return { calls, reply: rec('reply'), followUp: rec('followUp') };
}

describe('/english slash — flag gating', () => {
  it('replies "выключено" when tutor is undefined', async () => {
    const ixn = fakeSlash();
    await handleEnglishSlash(ixn as any, undefined);
    expect(ixn.calls).toHaveLength(1);
    expect(ixn.calls[0].method).toBe('reply');
    expect(ixn.calls[0].payload.content).toContain('выключен');
  });

  it('replies "выключено" when enabled=false and touches no state', async () => {
    const deps = makeDeps({ enabled: false });
    const ixn = fakeSlash();
    await handleEnglishSlash(ixn as any, deps);
    expect(ixn.calls[0].payload.content).toContain('выключен');
    expect(deps.store.getProfile()).toBeNull();
  });
});

describe('/english slash — placement flow', () => {
  it('starts placement when no profile exists', async () => {
    const deps = makeDeps({ replies: [JSON.stringify(PLACEMENT_QUESTIONS)] });
    const ixn = fakeSlash();
    await handleEnglishSlash(ixn as any, deps);

    // deferred, then the first placement question via editReply
    expect(ixn.calls[0].method).toBe('deferReply');
    const edit = ixn.calls.find((c) => c.method === 'editReply');
    expect(edit?.payload.content).toContain('Вопрос 1/5');
    expect(deps.store.getProfile()?.placementState).toBe('in_progress');
  });

  it('resumes an in-progress placement without a new LLM call', async () => {
    const deps = makeDeps();
    deps.store.updateProfile({
      placementState: 'in_progress',
      placementPayload: { questions: PLACEMENT_QUESTIONS.questions, answers: [0, 0] },
    });
    const ixn = fakeSlash();
    await handleEnglishSlash(ixn as any, deps);

    const edit = ixn.calls.find((c) => c.method === 'editReply');
    expect(edit?.payload.content).toContain('Продолжаем placement');
    expect(edit?.payload.content).toContain('Вопрос 3/5');
    expect((deps.anthropic.messages.create as any)).not.toHaveBeenCalled();
  });

  it('reports gracefully when placement generation fails', async () => {
    const deps = makeDeps({ replies: ['not json', 'still not json'] });
    const ixn = fakeSlash();
    await handleEnglishSlash(ixn as any, deps);
    const edit = ixn.calls.find((c) => c.method === 'editReply');
    expect(edit?.payload.content).toContain('Не смог собрать placement');
  });
});

describe('/english slash — lessons', () => {
  it('continues the active lesson by re-showing the current exercise', async () => {
    const deps = makeDeps();
    deps.store.updateProfile({ level: 'B1', placementState: 'done' });
    const created = deps.store.createLesson({ topic: LESSON.topic, payload: LESSON });
    const ixn = fakeSlash();
    await handleEnglishSlash(ixn as any, deps);

    const edit = ixn.calls.find((c) => c.method === 'editReply');
    expect(edit?.payload.content).toContain('Продолжаем');
    expect(edit?.payload.content).toContain('She ___ to school');
    // MCQ row present
    expect(edit?.payload.components).toHaveLength(1);
    expect(deps.store.getActiveLesson()?.id).toBe(created.id);
  });

  it('generates a new lesson when placement done and none active', async () => {
    const deps = makeDeps({ replies: [JSON.stringify(LESSON)] });
    deps.store.updateProfile({ level: 'B1', placementState: 'done' });
    const ixn = fakeSlash();
    await handleEnglishSlash(ixn as any, deps);

    const edit = ixn.calls.find((c) => c.method === 'editReply');
    expect(edit?.payload.content).toContain('past-simple');
    expect(edit?.payload.content).toContain('Past Simple');
    const active = deps.store.getActiveLesson();
    expect(active?.topic).toBe('past-simple');
    expect(active?.status).toBe('awaiting_mcq');
  });

  it('reports gracefully when lesson generation fails', async () => {
    const deps = makeDeps({ replies: ['nope', 'nope'] });
    deps.store.updateProfile({ level: 'B1', placementState: 'done' });
    const ixn = fakeSlash();
    await handleEnglishSlash(ixn as any, deps);
    const edit = ixn.calls.find((c) => c.method === 'editReply');
    expect(edit?.payload.content).toContain('Не смог собрать урок');
    expect(deps.store.getActiveLesson()).toBeNull();
  });
});

describe('/english stop', () => {
  it('closes the active lesson with a partial score', async () => {
    const deps = makeDeps();
    deps.store.updateProfile({ level: 'B1', placementState: 'done' });
    const created = deps.store.createLesson({ topic: LESSON.topic, payload: LESSON });
    const ixn = fakeSlash('stop');
    await handleEnglishSlash(ixn as any, deps);

    expect(ixn.calls[0].method).toBe('reply');
    expect(ixn.calls[0].payload.content).toContain('остановлен');
    expect(deps.store.getLesson(created.id)?.status).toBe('done');
    expect(deps.store.getActiveLesson()).toBeNull();
  });

  it('cancels an in-progress placement', async () => {
    const deps = makeDeps();
    deps.store.updateProfile({
      placementState: 'in_progress',
      placementPayload: { questions: PLACEMENT_QUESTIONS.questions, answers: [] },
    });
    const ixn = fakeSlash('stop');
    await handleEnglishSlash(ixn as any, deps);
    expect(ixn.calls[0].payload.content).toContain('остановлен');
    expect(deps.store.getProfile()?.placementState).toBe('none');
  });

  it('says there is nothing to stop when idle', async () => {
    const deps = makeDeps();
    deps.store.updateProfile({ level: 'B1', placementState: 'done' });
    const ixn = fakeSlash('stop');
    await handleEnglishSlash(ixn as any, deps);
    expect(ixn.calls[0].payload.content).toContain('Активного урока нет');
  });
});

describe('tutor:mcq button', () => {
  function seededLesson(deps: TutorInteractionDeps & { store: TutorStore }) {
    deps.store.updateProfile({ level: 'B1', placementState: 'done' });
    return deps.store.createLesson({ topic: LESSON.topic, payload: LESSON });
  }

  it('grades a correct answer and advances to the next exercise', async () => {
    const deps = makeDeps();
    const lesson = seededLesson(deps);
    const ixn = fakeButton();
    await handleTutorMcqButton(ixn as any, deps, `${lesson.id}:0:1`);

    // ephemeral feedback + next exercise
    expect(ixn.calls[0].method).toBe('reply');
    expect(ixn.calls[0].payload.content).toContain('Верно');
    expect(ixn.calls[1].method).toBe('followUp');
    expect(ixn.calls[1].payload.content).toContain('They ___ football');

    const updated = deps.store.getLesson(lesson.id);
    expect(updated?.currentEx).toBe(1);
    expect(updated?.status).toBe('awaiting_mcq');
  });

  it('grades a wrong answer, shows the correct option, and advances', async () => {
    const deps = makeDeps();
    const lesson = seededLesson(deps);
    const ixn = fakeButton();
    await handleTutorMcqButton(ixn as any, deps, `${lesson.id}:0:0`);
    expect(ixn.calls[0].payload.content).toContain('Неверно');
    expect(ixn.calls[0].payload.content).toContain('went');
  });

  it('completes the lesson on the last exercise and records mastery', async () => {
    const deps = makeDeps();
    const lesson = seededLesson(deps);
    const b1 = fakeButton();
    await handleTutorMcqButton(b1 as any, deps, `${lesson.id}:0:1`);
    const b2 = fakeButton();
    await handleTutorMcqButton(b2 as any, deps, `${lesson.id}:1:1`);

    const summary = b2.calls.find((c) => c.method === 'followUp');
    expect(summary?.payload.content).toContain('завершён');
    expect(summary?.payload.content).toContain('100%');
    expect(deps.store.getLesson(lesson.id)?.status).toBe('done');
    expect(deps.store.getProgress('past-simple')?.mastery).toBeGreaterThan(0);
  });

  it('rejects a stale button pointing at a past exercise', async () => {
    const deps = makeDeps();
    const lesson = seededLesson(deps);
    // Move the lesson to exercise 1 first.
    await handleTutorMcqButton(fakeButton() as any, deps, `${lesson.id}:0:1`);
    const stale = fakeButton();
    await handleTutorMcqButton(stale as any, deps, `${lesson.id}:0:1`);
    expect(stale.calls).toHaveLength(1);
    expect(stale.calls[0].payload.content).toContain('уже пройдено');
  });

  it('rejects a button for an unknown lesson', async () => {
    const deps = makeDeps();
    const ixn = fakeButton();
    await handleTutorMcqButton(ixn as any, deps, `999:0:0`);
    expect(ixn.calls[0].payload.content).toContain('больше недоступен');
  });

  it('rejects a malformed customId', async () => {
    const deps = makeDeps();
    const ixn = fakeButton();
    await handleTutorMcqButton(ixn as any, deps, `abc:def`);
    expect(ixn.calls[0].payload.content).toContain('Некорректная кнопка');
  });

  it('replies "выключено" when the flag is off', async () => {
    const deps = makeDeps({ enabled: false });
    const ixn = fakeButton();
    await handleTutorMcqButton(ixn as any, deps, `1:0:0`);
    expect(ixn.calls[0].payload.content).toContain('выключен');
  });
});
