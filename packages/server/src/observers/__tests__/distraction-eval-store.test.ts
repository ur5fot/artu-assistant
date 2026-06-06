import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb, closeDb } from '../../db.js';
import {
  createDistractionEvalStore,
  type DistractionEvalInput,
} from '../distraction-eval-store.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;

function baseInput(overrides: Partial<DistractionEvalInput> = {}): DistractionEvalInput {
  return {
    app_name: 'Chrome',
    dwell_started_at: T0,
    window_title: 'YouTube',
    evaluated_at: T0 + 25 * MIN,
    eval_dwell_ms: 25 * MIN,
    verdict: 'distracted',
    confidence: 80,
    pinged: false,
    ...overrides,
  };
}

beforeEach(() => initDb(':memory:'));
afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

describe('createDistractionEvalStore', () => {
  describe('recordEval + findLatestEvalForDwell', () => {
    it('records an eval and reads it back by dwell key', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      const id = store.recordEval(baseInput());
      expect(id).toBeGreaterThan(0);

      const row = store.findLatestEvalForDwell('Chrome', T0);
      expect(row).not.toBeNull();
      expect(row!.app_name).toBe('Chrome');
      expect(row!.dwell_started_at).toBe(T0);
      expect(row!.window_title).toBe('YouTube');
      expect(row!.verdict).toBe('distracted');
      expect(row!.confidence).toBe(80);
      expect(row!.pinged).toBe(0);
      expect(row!.feedback).toBeNull();
      expect(row!.snooze_until).toBeNull();
    });

    it('returns the most recent eval when a dwell is re-evaluated', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(baseInput({ verdict: 'break', evaluated_at: T0 + 25 * MIN }));
      store.recordEval(baseInput({ verdict: 'distracted', evaluated_at: T0 + 55 * MIN }));

      const row = store.findLatestEvalForDwell('Chrome', T0);
      expect(row!.verdict).toBe('distracted');
      expect(row!.evaluated_at).toBe(T0 + 55 * MIN);
    });

    it('returns null for an unknown dwell key (empty table / no match)', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      expect(store.findLatestEvalForDwell('Chrome', T0)).toBeNull();
      store.recordEval(baseInput());
      expect(store.findLatestEvalForDwell('Chrome', T0 + 1)).toBeNull();
      expect(store.findLatestEvalForDwell('Slack', T0)).toBeNull();
    });

    it('defaults optional confidence / window_title to null', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(
        baseInput({ window_title: undefined, confidence: undefined, verdict: 'error' }),
      );
      const row = store.findLatestEvalForDwell('Chrome', T0);
      expect(row!.window_title).toBeNull();
      expect(row!.confidence).toBeNull();
      expect(row!.verdict).toBe('error');
    });
  });

  describe('findRecentPing', () => {
    it('returns the most recent pinged eval for the app at/after since', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(baseInput({ pinged: true, evaluated_at: T0 }));
      store.recordEval(baseInput({ pinged: true, evaluated_at: T0 + 2 * HOUR }));

      const row = store.findRecentPing('Chrome', T0 + HOUR);
      expect(row).not.toBeNull();
      expect(row!.evaluated_at).toBe(T0 + 2 * HOUR);
      expect(row!.pinged).toBe(1);
    });

    it('ignores non-pinged evals (dedup only cares about actual pings)', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(baseInput({ pinged: false, verdict: 'break' }));
      expect(store.findRecentPing('Chrome', T0)).toBeNull();
    });

    it('ignores pings older than since and pings for other apps', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(baseInput({ pinged: true, evaluated_at: T0 }));
      expect(store.findRecentPing('Chrome', T0 + HOUR)).toBeNull();
      store.recordEval(baseInput({ app_name: 'Slack', pinged: true, evaluated_at: T0 + 2 * HOUR }));
      expect(store.findRecentPing('Chrome', T0 + HOUR)).toBeNull();
    });
  });

  describe('countEvalsSince', () => {
    it('counts evals at or after the cutoff', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(baseInput({ evaluated_at: T0 }));
      store.recordEval(baseInput({ evaluated_at: T0 + 10 * MIN }));
      store.recordEval(baseInput({ evaluated_at: T0 + 20 * MIN }));

      expect(store.countEvalsSince(T0 + 10 * MIN)).toBe(2);
      expect(store.countEvalsSince(T0)).toBe(3);
    });

    it('returns 0 on an empty table', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      expect(store.countEvalsSince(T0)).toBe(0);
    });
  });

  describe('listEvalsInWindow', () => {
    it('returns evals with evaluated_at within [from, to], chronological', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(baseInput({ app_name: 'Slack', evaluated_at: T0 + 30 * MIN }));
      store.recordEval(baseInput({ app_name: 'Chrome', evaluated_at: T0 + 10 * MIN }));
      store.recordEval(baseInput({ app_name: 'Code', evaluated_at: T0 + 20 * MIN }));

      const rows = store.listEvalsInWindow(T0, T0 + HOUR);
      expect(rows.map((r) => r.app_name)).toEqual(['Chrome', 'Code', 'Slack']);
    });

    it('is inclusive of the window bounds and excludes evals outside', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(baseInput({ app_name: 'Before', evaluated_at: T0 - MIN }));
      store.recordEval(baseInput({ app_name: 'AtFrom', evaluated_at: T0 }));
      store.recordEval(baseInput({ app_name: 'AtTo', evaluated_at: T0 + HOUR }));
      store.recordEval(baseInput({ app_name: 'After', evaluated_at: T0 + HOUR + MIN }));

      const rows = store.listEvalsInWindow(T0, T0 + HOUR);
      expect(rows.map((r) => r.app_name)).toEqual(['AtFrom', 'AtTo']);
    });

    it('returns an empty array when nothing falls in the window', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(baseInput({ evaluated_at: T0 }));
      expect(store.listEvalsInWindow(T0 + HOUR, T0 + 2 * HOUR)).toEqual([]);
    });
  });

  describe('activeSnoozeUntil', () => {
    it('returns the max future snooze_until', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(baseInput({ evaluated_at: T0 }));
      store.recordFeedback('Chrome', T0, 'snooze', T0 + 60 * MIN);

      expect(store.activeSnoozeUntil(T0 + 10 * MIN)).toBe(T0 + 60 * MIN);
    });

    it('returns the latest among several snoozes', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(baseInput({ app_name: 'Chrome', dwell_started_at: T0 }));
      store.recordEval(baseInput({ app_name: 'Slack', dwell_started_at: T0 + MIN }));
      store.recordFeedback('Chrome', T0, 'snooze', T0 + 30 * MIN);
      store.recordFeedback('Slack', T0 + MIN, 'snooze', T0 + 90 * MIN);

      expect(store.activeSnoozeUntil(T0)).toBe(T0 + 90 * MIN);
    });

    it('returns null when all snoozes have expired', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(baseInput({ evaluated_at: T0 }));
      store.recordFeedback('Chrome', T0, 'snooze', T0 + 60 * MIN);

      expect(store.activeSnoozeUntil(T0 + 60 * MIN)).toBeNull();
      expect(store.activeSnoozeUntil(T0 + 120 * MIN)).toBeNull();
    });

    it('returns null when no snoozes exist', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(baseInput());
      expect(store.activeSnoozeUntil(T0)).toBeNull();
    });
  });

  describe('recordFeedback', () => {
    it('attaches "work" feedback to the latest eval for a dwell', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(baseInput());
      store.recordFeedback('Chrome', T0, 'work');

      const row = store.findLatestEvalForDwell('Chrome', T0);
      expect(row!.feedback).toBe('work');
      expect(row!.snooze_until).toBeNull();
    });

    it('attaches "done" feedback to the latest eval for a dwell', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(baseInput());
      store.recordFeedback('Chrome', T0, 'done');

      const row = store.findLatestEvalForDwell('Chrome', T0);
      expect(row!.feedback).toBe('done');
      expect(row!.snooze_until).toBeNull();
    });

    it('writes snooze_until when provided and preserves it otherwise', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(baseInput());
      store.recordFeedback('Chrome', T0, 'snooze', T0 + 60 * MIN);
      expect(store.findLatestEvalForDwell('Chrome', T0)!.snooze_until).toBe(T0 + 60 * MIN);

      // A later feedback without snoozeUntil must not clobber the existing snooze.
      store.recordFeedback('Chrome', T0, 'back');
      const row = store.findLatestEvalForDwell('Chrome', T0);
      expect(row!.feedback).toBe('back');
      expect(row!.snooze_until).toBe(T0 + 60 * MIN);
    });

    it('updates only the latest eval row for a re-evaluated dwell', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      store.recordEval(baseInput({ verdict: 'break', evaluated_at: T0 + 25 * MIN }));
      const latestId = store.recordEval(
        baseInput({ verdict: 'distracted', evaluated_at: T0 + 55 * MIN }),
      );
      store.recordFeedback('Chrome', T0, 'work');

      const rows = getDb()
        .prepare('SELECT id, feedback FROM distraction_evals ORDER BY id')
        .all() as Array<{ id: number; feedback: string | null }>;
      const withFeedback = rows.filter((r) => r.feedback === 'work');
      expect(withFeedback).toHaveLength(1);
      expect(withFeedback[0].id).toBe(latestId);
    });

    it('is a no-op when no eval exists for the dwell', () => {
      const store = createDistractionEvalStore({ db: getDb() });
      expect(() => store.recordFeedback('Chrome', T0, 'work')).not.toThrow();
      expect(store.findLatestEvalForDwell('Chrome', T0)).toBeNull();
    });
  });
});
