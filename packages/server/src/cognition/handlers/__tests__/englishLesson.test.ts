import { describe, it, expect } from 'vitest';
import {
  createEnglishLessonHandler,
  type EnglishLessonDeps,
} from '../englishLesson.js';
import type { Lesson } from '../../../tutor/lesson-generator.js';
import type {
  TutorLesson,
  TutorProfile,
  TutorProgress,
  TutorStore,
} from '../../../tutor/store.js';

// 2026-07-03, Europe/Kyiv is UTC+3 (EEST) → Kyiv local = UTC + 3.
const NINE_AM = Date.UTC(2026, 6, 3, 6, 0, 0); // 09:00 Kyiv
const NIGHT = Date.UTC(2026, 6, 3, 20, 0, 0); // 23:00 Kyiv (quiet)
const EARLY = Date.UTC(2026, 6, 3, 3, 0, 0); // 06:00 Kyiv (before hour=9)

const MCQ_LESSON: Lesson = {
  topic: 'past-simple',
  explanation: 'Past simple объясняет завершённые действия.',
  exercises: [
    { kind: 'mcq', prompt: 'Choose the past form.', options: ['go', 'went', 'gone'], answer: 1 },
    { kind: 'free', prompt: 'Write a sentence.', answer: 'I went home.' },
  ],
};

const FREE_FIRST_LESSON: Lesson = {
  topic: 'articles',
  explanation: 'Артикли a/an/the.',
  exercises: [{ kind: 'free', prompt: 'Use "the".', answer: 'the sun' }],
};

function makeProfile(over: Partial<TutorProfile> = {}): TutorProfile {
  return {
    level: 'B1',
    placementState: 'done',
    placementPayload: null,
    dailyHour: null,
    paused: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

interface FakeStore extends TutorStore {
  lessons: TutorLesson[];
}

function fakeStore(opts: {
  profile?: TutorProfile | null;
  active?: TutorLesson | null;
  progress?: TutorProgress[];
} = {}): FakeStore {
  const lessons: TutorLesson[] = [];
  let nextId = 1;
  const profile = opts.profile === undefined ? makeProfile() : opts.profile;
  return {
    lessons,
    getProfile: () => profile,
    updateProfile: () => makeProfile(),
    createLesson: ({ topic, payload }) => {
      const lesson: TutorLesson = {
        id: nextId++,
        topic,
        payload,
        status: 'awaiting_mcq',
        currentEx: 0,
        score: null,
        createdAt: 0,
        completedAt: null,
      };
      lessons.push(lesson);
      return lesson;
    },
    getLesson: (id) => lessons.find((l) => l.id === id) ?? null,
    getActiveLesson: () => opts.active ?? null,
    updateLesson: (id, patch) => {
      const l = lessons.find((x) => x.id === id)!;
      Object.assign(l, patch);
      return l;
    },
    completeLesson: (id, score) => {
      const l = lessons.find((x) => x.id === id)!;
      l.status = 'done';
      l.score = score;
      return l;
    },
    getProgress: () => null,
    listProgress: () => opts.progress ?? [],
    recordAttempt: () => ({ topic: '', attempts: 1, correct: 1, mastery: 1, lastAt: 0 }),
  };
}

function baseDeps(over: Partial<EnglishLessonDeps> = {}): EnglishLessonDeps {
  return {
    enabled: true,
    store: fakeStore(),
    anthropic: {} as never,
    model: 'claude-sonnet-4-6',
    hour: 9,
    tz: 'Europe/Kyiv',
    quietStart: 22,
    quietEnd: 8,
    ...over,
  };
}

const state = (now: number) => ({ now, lastFiredAt: null, lastResult: null });
const ctx = () => ({ signal: new AbortController().signal }) as never;

describe('createEnglishLessonHandler', () => {
  describe('trigger', () => {
    it('fires at the target hour when all gates pass', async () => {
      const h = createEnglishLessonHandler(baseDeps());
      expect(await h.trigger(state(NINE_AM), {} as never)).toBe(true);
    });

    it('is inert when the flag is off', async () => {
      const h = createEnglishLessonHandler(baseDeps({ enabled: false }));
      expect(await h.trigger(state(NINE_AM), {} as never)).toBe(false);
    });

    it('holds before the target hour', async () => {
      const h = createEnglishLessonHandler(baseDeps());
      expect(await h.trigger(state(EARLY), {} as never)).toBe(false);
    });

    it('holds during quiet hours', async () => {
      // hour=9 but quietStart low enough that NIGHT is quiet
      const h = createEnglishLessonHandler(baseDeps());
      expect(await h.trigger(state(NIGHT), {} as never)).toBe(false);
    });

    it('holds when paused', async () => {
      const h = createEnglishLessonHandler(
        baseDeps({ store: fakeStore({ profile: makeProfile({ paused: true }) }) }),
      );
      expect(await h.trigger(state(NINE_AM), {} as never)).toBe(false);
    });

    it('holds when placement is not done', async () => {
      const h = createEnglishLessonHandler(
        baseDeps({
          store: fakeStore({ profile: makeProfile({ placementState: 'in_progress' }) }),
        }),
      );
      expect(await h.trigger(state(NINE_AM), {} as never)).toBe(false);
    });

    it('holds when there is no profile', async () => {
      const h = createEnglishLessonHandler(baseDeps({ store: fakeStore({ profile: null }) }));
      expect(await h.trigger(state(NINE_AM), {} as never)).toBe(false);
    });

    it('holds when an unfinished lesson exists', async () => {
      const active: TutorLesson = {
        id: 1,
        topic: 't',
        payload: MCQ_LESSON,
        status: 'awaiting_mcq',
        currentEx: 0,
        score: null,
        createdAt: 0,
        completedAt: null,
      };
      const h = createEnglishLessonHandler(baseDeps({ store: fakeStore({ active }) }));
      expect(await h.trigger(state(NINE_AM), {} as never)).toBe(false);
    });

    it('self-gates after a publish today', async () => {
      const h = createEnglishLessonHandler(baseDeps());
      const gated = {
        now: NINE_AM + 3_600_000,
        lastFiredAt: NINE_AM,
        lastResult: { publish: true, content: 'x' } as never,
      };
      expect(await h.trigger(gated, {} as never)).toBe(false);
    });
  });

  describe('run', () => {
    it('generates a lesson and posts explanation + first MCQ exercise', async () => {
      const store = fakeStore();
      const h = createEnglishLessonHandler(
        baseDeps({
          store,
          anthropic: { messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(MCQ_LESSON) }] }) } } as never,
        }),
      );
      const res = await h.run(ctx());
      expect(res).toMatchObject({ publish: true });
      if (!('publish' in res)) throw new Error('expected publish');
      expect(res.content).toContain('past-simple');
      expect(res.content).toContain('Упражнение 1/2');
      expect(res.components?.[0]).toMatchObject({ type: 'row' });
      expect(store.lessons).toHaveLength(1);
      expect(store.lessons[0].status).toBe('awaiting_mcq');
      const row = res.components?.[0];
      if (row && row.type === 'row') {
        expect(row.buttons.map((b) => b.customId)).toEqual([
          'tutor:mcq:1:0:0',
          'tutor:mcq:1:0:1',
          'tutor:mcq:1:0:2',
        ]);
      }
    });

    it('posts a free first exercise without components', async () => {
      const store = fakeStore();
      const h = createEnglishLessonHandler(
        baseDeps({
          store,
          anthropic: { messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(FREE_FIRST_LESSON) }] }) } } as never,
        }),
      );
      const res = await h.run(ctx());
      if (!('publish' in res)) throw new Error('expected publish');
      expect(res.components).toBeUndefined();
      expect(res.content).toContain('Ответь сообщением в чат');
      expect(store.lessons[0].status).toBe('awaiting_free');
    });

    it('skips creating a duplicate lesson when one was created concurrently during generation', async () => {
      const store = fakeStore();
      let concurrentLesson: TutorLesson | null = null;
      store.getActiveLesson = () => concurrentLesson;
      const h = createEnglishLessonHandler(
        baseDeps({
          store,
          anthropic: {
            messages: {
              create: async () => {
                // Simulate a concurrent /english creating a lesson while this
                // generateLesson call (the LLM await) is still in flight.
                concurrentLesson = store.createLesson({
                  topic: 'concurrent',
                  payload: MCQ_LESSON,
                });
                return {
                  content: [{ type: 'text', text: JSON.stringify(MCQ_LESSON) }],
                };
              },
            },
          } as never,
        }),
      );
      const res = await h.run(ctx());
      expect(res).toMatchObject({ skip: true });
      if ('skip' in res) expect(res.reason).toContain('concurrently');
      expect(store.lessons).toHaveLength(1);
    });

    it('skips without creating state when generation fails', async () => {
      const store = fakeStore();
      const h = createEnglishLessonHandler(
        baseDeps({
          store,
          anthropic: { messages: { create: async () => { throw new Error('boom'); } } } as never,
        }),
      );
      const res = await h.run(ctx());
      expect(res).toMatchObject({ skip: true });
      if ('skip' in res) expect(res.reason).toContain('lesson generation failed');
      expect(store.lessons).toHaveLength(0);
    });

    it('skips when the profile has no level', async () => {
      const store = fakeStore({ profile: makeProfile({ level: null }) });
      const h = createEnglishLessonHandler(baseDeps({ store }));
      const res = await h.run(ctx());
      expect(res).toMatchObject({ skip: true, reason: 'no level' });
    });
  });
});
