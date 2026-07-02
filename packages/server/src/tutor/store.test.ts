import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../db.js';
import { createTutorStore, DEFAULT_MASTERY_ALPHA } from './store.js';

beforeEach(() => initDb(':memory:'));

function store(now?: () => number) {
  return createTutorStore({ db: getDb(), now });
}

describe('tutor store — profile', () => {
  it('returns null before any profile exists', () => {
    expect(store().getProfile()).toBeNull();
  });

  it('upsert creates the single row then patches it in place', () => {
    let t = 1000;
    const s = store(() => t);

    const created = s.updateProfile({ dailyHour: 9 });
    expect(created.placementState).toBe('none');
    expect(created.level).toBeNull();
    expect(created.dailyHour).toBe(9);
    expect(created.paused).toBe(false);
    expect(created.createdAt).toBe(1000);

    t = 2000;
    const patched = s.updateProfile({ level: 'B1', placementState: 'done', paused: true });
    expect(patched.level).toBe('B1');
    expect(patched.placementState).toBe('done');
    expect(patched.paused).toBe(true);
    expect(patched.dailyHour).toBe(9); // untouched field preserved
    expect(patched.createdAt).toBe(1000); // created_at is stable
    expect(patched.updatedAt).toBe(2000);

    // still exactly one row
    const count = getDb()
      .prepare('SELECT COUNT(*) AS n FROM tutor_profile')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('round-trips placement_payload as JSON and can clear it', () => {
    const s = store();
    s.updateProfile({ placementPayload: { step: 2, answers: ['a', 'b'] } });
    expect(s.getProfile()!.placementPayload).toEqual({ step: 2, answers: ['a', 'b'] });

    s.updateProfile({ placementPayload: null });
    expect(s.getProfile()!.placementPayload).toBeNull();
  });
});

describe('tutor store — lessons', () => {
  it('createLesson starts in awaiting_mcq at current_ex 0', () => {
    const s = store(() => 5000);
    const lesson = s.createLesson({ topic: 'past-simple', payload: { explanation: 'x', exercises: [] } });
    expect(lesson.id).toBeGreaterThan(0);
    expect(lesson.status).toBe('awaiting_mcq');
    expect(lesson.currentEx).toBe(0);
    expect(lesson.score).toBeNull();
    expect(lesson.completedAt).toBeNull();
    expect(lesson.createdAt).toBe(5000);
    expect(lesson.payload).toEqual({ explanation: 'x', exercises: [] });
  });

  it('getActiveLesson returns the newest non-done lesson', () => {
    const s = store();
    expect(s.getActiveLesson()).toBeNull();

    const first = s.createLesson({ topic: 'a', payload: {} });
    const second = s.createLesson({ topic: 'b', payload: {} });
    expect(s.getActiveLesson()!.id).toBe(second.id);

    // completing the newest falls back to the older still-active one
    s.completeLesson(second.id, 1);
    expect(s.getActiveLesson()!.id).toBe(first.id);

    s.completeLesson(first.id, 0.5);
    expect(s.getActiveLesson()).toBeNull();
  });

  it('updateLesson patches only the given fields', () => {
    const s = store();
    const lesson = s.createLesson({ topic: 'a', payload: { v: 1 } });
    const updated = s.updateLesson(lesson.id, { status: 'awaiting_free', currentEx: 2 });
    expect(updated.status).toBe('awaiting_free');
    expect(updated.currentEx).toBe(2);
    expect(updated.payload).toEqual({ v: 1 }); // untouched
    expect(updated.score).toBeNull();
  });

  it('completeLesson sets status/score/completed_at', () => {
    const s = store(() => 8000);
    const lesson = s.createLesson({ topic: 'a', payload: {} });
    const done = s.completeLesson(lesson.id, 0.75);
    expect(done.status).toBe('done');
    expect(done.score).toBe(0.75);
    expect(done.completedAt).toBe(8000);
  });

  it('updateLesson / completeLesson throw on unknown id', () => {
    const s = store();
    expect(() => s.updateLesson(999, { currentEx: 1 })).toThrow();
    expect(() => s.completeLesson(999, 1)).toThrow();
  });
});

describe('tutor store — progress + mastery EWMA', () => {
  it('getProgress is null for an unseen topic', () => {
    expect(store().getProgress('nope')).toBeNull();
  });

  it('first attempt seeds mastery at the target, later attempts blend via EWMA', () => {
    const s = store(() => 100);
    const first = s.recordAttempt({ topic: 'articles', correct: true });
    expect(first.attempts).toBe(1);
    expect(first.correct).toBe(1);
    expect(first.mastery).toBe(1); // seeded, not blended against 0

    const second = s.recordAttempt({ topic: 'articles', correct: false });
    expect(second.attempts).toBe(2);
    expect(second.correct).toBe(1);
    // mastery = α·0 + (1-α)·1 = 1 - α
    expect(second.mastery).toBeCloseTo(1 - DEFAULT_MASTERY_ALPHA, 10);
  });

  it('honours an explicit outcome (partial credit) and custom alpha', () => {
    const s = store();
    s.recordAttempt({ topic: 't', correct: true }); // mastery 1
    const r = s.recordAttempt({ topic: 't', correct: false, outcome: 0.5, alpha: 0.5 });
    // mastery = 0.5·0.5 + 0.5·1 = 0.75
    expect(r.mastery).toBeCloseTo(0.75, 10);
    expect(r.correct).toBe(1); // correct flag still false → counter unchanged
  });

  it('listProgress returns all topics newest-first', () => {
    let t = 1;
    const s = store(() => t);
    t = 10;
    s.recordAttempt({ topic: 'old', correct: true });
    t = 20;
    s.recordAttempt({ topic: 'new', correct: true });
    const list = s.listProgress();
    expect(list.map((p) => p.topic)).toEqual(['new', 'old']);
  });
});

describe('tutor store — migrations', () => {
  it('creates the tutor tables idempotently', () => {
    // initDb ran in beforeEach; running it again must not throw and must keep
    // the tables present.
    initDb(':memory:');
    initDb(':memory:');
    const db = getDb();
    const names = ['tutor_profile', 'tutor_lesson', 'tutor_progress'];
    for (const name of names) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(name) as { name: string } | undefined;
      expect(row?.name).toBe(name);
    }
  });
});
