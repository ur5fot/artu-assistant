import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, initDb } from '../../db.js';
import { createCognitionStore } from '../store.js';

beforeEach(() => initDb(':memory:'));

describe('CognitionStore — pause/resume', () => {
  it('isPaused returns false initially', () => {
    const store = createCognitionStore({ db: getDb() });
    expect(store.isPaused()).toBe(false);
  });

  it('pause sets paused=1 and timestamp', () => {
    const store = createCognitionStore({ db: getDb() });
    store.pause(12345);
    expect(store.isPaused()).toBe(true);
    const row = getDb()
      .prepare('SELECT paused, paused_at FROM cognition_state WHERE id = 1')
      .get() as { paused: number; paused_at: number };
    expect(row).toEqual({ paused: 1, paused_at: 12345 });
  });

  it('resume clears paused', () => {
    const store = createCognitionStore({ db: getDb() });
    store.pause(12345);
    store.resume();
    expect(store.isPaused()).toBe(false);
    const row = getDb()
      .prepare('SELECT paused, paused_at FROM cognition_state WHERE id = 1')
      .get() as { paused: number; paused_at: number | null };
    expect(row).toEqual({ paused: 0, paused_at: null });
  });
});

describe('CognitionStore — ticks', () => {
  it('recordTick inserts a row', () => {
    const store = createCognitionStore({ db: getDb() });
    store.recordTick(1000);
    expect(store.getLastTickAt()).toBe(1000);
  });

  it('countTicksSince counts ticks at or after the cutoff', () => {
    const store = createCognitionStore({ db: getDb() });
    store.recordTick(1000);
    store.recordTick(2000);
    store.recordTick(3000);
    expect(store.countTicksSince(1500)).toBe(2);
  });

  it('recordTick prunes ticks older than 7 days', () => {
    const store = createCognitionStore({ db: getDb() });
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    store.recordTick(eightDaysAgo);
    store.recordTick(now);
    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM cognition_ticks').get() as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe('CognitionStore — handler runs', () => {
  it('recordHandlerRun returns row id and persists outcome', () => {
    const store = createCognitionStore({ db: getDb() });
    const id = store.recordHandlerRun({
      handlerName: 'pulse',
      firedAt: 1000,
      durationMs: 5,
      result: { skip: true, reason: 'alive' },
    });
    expect(id).toBeGreaterThan(0);
    const row = getDb()
      .prepare('SELECT handler_name, outcome, reason FROM cognition_handler_runs WHERE id = ?')
      .get(id) as { handler_name: string; outcome: string; reason: string };
    expect(row).toEqual({ handler_name: 'pulse', outcome: 'skip', reason: 'alive' });
  });

  it('recordHandlerRun stores publish content', () => {
    const store = createCognitionStore({ db: getDb() });
    const id = store.recordHandlerRun({
      handlerName: 'reflect',
      firedAt: 2000,
      durationMs: 1234,
      result: { publish: true, content: 'noticed X' },
    });
    const row = getDb()
      .prepare('SELECT outcome, content FROM cognition_handler_runs WHERE id = ?')
      .get(id) as { outcome: string; content: string };
    expect(row).toEqual({ outcome: 'publish', content: 'noticed X' });
  });

  it('recordHandlerRun stores error message in reason', () => {
    const store = createCognitionStore({ db: getDb() });
    const id = store.recordHandlerRun({
      handlerName: 'broken',
      firedAt: 3000,
      durationMs: 10,
      result: { error: true, message: 'boom' },
    });
    const row = getDb()
      .prepare('SELECT outcome, reason FROM cognition_handler_runs WHERE id = ?')
      .get(id) as { outcome: string; reason: string };
    expect(row).toEqual({ outcome: 'error', reason: 'boom' });
  });

  it('markPublished sets published_at', () => {
    const store = createCognitionStore({ db: getDb() });
    const id = store.recordHandlerRun({
      handlerName: 'reflect',
      firedAt: 1,
      durationMs: 1,
      result: { publish: true, content: 'x' },
    });
    store.markPublished(id, 9999);
    const row = getDb()
      .prepare('SELECT published_at FROM cognition_handler_runs WHERE id = ?')
      .get(id) as { published_at: number };
    expect(row.published_at).toBe(9999);
  });

  it('getLastFiredAt returns latest fired_at for handler', () => {
    const store = createCognitionStore({ db: getDb() });
    store.recordHandlerRun({
      handlerName: 'a',
      firedAt: 100,
      durationMs: 0,
      result: { skip: true, reason: '' },
    });
    store.recordHandlerRun({
      handlerName: 'a',
      firedAt: 500,
      durationMs: 0,
      result: { skip: true, reason: '' },
    });
    store.recordHandlerRun({
      handlerName: 'b',
      firedAt: 999,
      durationMs: 0,
      result: { skip: true, reason: '' },
    });
    expect(store.getLastFiredAt('a')).toBe(500);
    expect(store.getLastFiredAt('missing')).toBe(null);
  });

  it('getLastResult round-trips publish/skip/error', () => {
    const store = createCognitionStore({ db: getDb() });
    store.recordHandlerRun({
      handlerName: 'a',
      firedAt: 1,
      durationMs: 0,
      result: { publish: true, content: 'hi' },
    });
    expect(store.getLastResult('a')).toEqual({ publish: true, content: 'hi' });
    store.recordHandlerRun({
      handlerName: 'a',
      firedAt: 2,
      durationMs: 0,
      result: { skip: true, reason: 'why' },
    });
    expect(store.getLastResult('a')).toEqual({ skip: true, reason: 'why' });
    store.recordHandlerRun({
      handlerName: 'a',
      firedAt: 3,
      durationMs: 0,
      result: { error: true, message: 'boom' },
    });
    expect(store.getLastResult('a')).toEqual({ error: true, message: 'boom' });
  });

  it('recordHandlerRun persists publish_payload with embed + components', () => {
    const store = createCognitionStore({ db: getDb() });
    const id = store.recordHandlerRun({
      handlerName: 'morningBrief',
      firedAt: 2000,
      durationMs: 10,
      result: {
        publish: true,
        content: 'Good morning',
        embed: { title: 'Brief', description: 'today' },
        components: [{ type: 'row', buttons: [{ customId: 'b1', label: 'Ok', style: 'primary' }] }],
      },
    });
    const row = getDb()
      .prepare('SELECT publish_payload FROM cognition_handler_runs WHERE id = ?')
      .get(id) as { publish_payload: string };
    expect(JSON.parse(row.publish_payload)).toEqual({
      content: 'Good morning',
      embed: { title: 'Brief', description: 'today' },
      components: [{ type: 'row', buttons: [{ customId: 'b1', label: 'Ok', style: 'primary' }] }],
    });
  });

  it('recordHandlerRun leaves publish_payload NULL for skip/error', () => {
    const store = createCognitionStore({ db: getDb() });
    const id = store.recordHandlerRun({
      handlerName: 'pulse',
      firedAt: 1,
      durationMs: 0,
      result: { skip: true, reason: 'alive' },
    });
    const row = getDb()
      .prepare('SELECT publish_payload FROM cognition_handler_runs WHERE id = ?')
      .get(id) as { publish_payload: string | null };
    expect(row.publish_payload).toBeNull();
  });

  it('recentRuns returns rows ordered by fired_at desc, limited', () => {
    const store = createCognitionStore({ db: getDb() });
    for (let i = 1; i <= 5; i++) {
      store.recordHandlerRun({
        handlerName: 'h',
        firedAt: i * 100,
        durationMs: 0,
        result: { skip: true, reason: `r${i}` },
      });
    }
    const recent = store.recentRuns(3);
    expect(recent.map((r) => r.firedAt)).toEqual([500, 400, 300]);
    expect(recent[0].outcome).toBe('skip');
    expect(recent[0].reason).toBe('r5');
  });
});

describe('CognitionStore — findUndeliveredPublishes', () => {
  it('returns only publish rows with NULL published_at and fired_at >= sinceMs', () => {
    const store = createCognitionStore({ db: getDb() });
    // eligible: publish, unpublished, recent
    const eligible = store.recordHandlerRun({
      handlerName: 'morningBrief',
      firedAt: 5000,
      durationMs: 1,
      result: { publish: true, content: 'brief' },
    });
    // excluded: already published
    const published = store.recordHandlerRun({
      handlerName: 'morningBrief',
      firedAt: 5000,
      durationMs: 1,
      result: { publish: true, content: 'old' },
    });
    store.markPublished(published, 6000);
    // excluded: stale (fired_at < sinceMs)
    store.recordHandlerRun({
      handlerName: 'morningBrief',
      firedAt: 1000,
      durationMs: 1,
      result: { publish: true, content: 'stale' },
    });
    // excluded: not a publish
    store.recordHandlerRun({
      handlerName: 'pulse',
      firedAt: 5000,
      durationMs: 1,
      result: { skip: true, reason: 'alive' },
    });

    const found = store.findUndeliveredPublishes(4000);
    expect(found.map((f) => f.runId)).toEqual([eligible]);
    expect(found[0].payload.content).toBe('brief');
  });

  it('round-trips embed + components through the payload', () => {
    const store = createCognitionStore({ db: getDb() });
    const id = store.recordHandlerRun({
      handlerName: 'morningBrief',
      firedAt: 5000,
      durationMs: 1,
      result: {
        publish: true,
        content: 'brief',
        embed: { title: 'T', fields: [{ name: 'n', value: 'v' }] },
        components: [{ type: 'row', buttons: [{ customId: 'c', label: 'L', style: 'success' }] }],
      },
    });
    const found = store.findUndeliveredPublishes(0);
    expect(found).toEqual([
      {
        runId: id,
        payload: {
          content: 'brief',
          embed: { title: 'T', fields: [{ name: 'n', value: 'v' }] },
          components: [{ type: 'row', buttons: [{ customId: 'c', label: 'L', style: 'success' }] }],
        },
      },
    ]);
  });

  it('falls back to {content} for pre-migration rows with NULL publish_payload', () => {
    const store = createCognitionStore({ db: getDb() });
    // simulate a pre-migration row: insert directly without publish_payload
    const r = getDb()
      .prepare(
        `INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome, content, reason)
         VALUES ('morningBrief', 5000, 1, 'publish', 'legacy brief', NULL)`,
      )
      .run();
    const found = store.findUndeliveredPublishes(0);
    expect(found).toEqual([
      { runId: Number(r.lastInsertRowid), payload: { content: 'legacy brief' } },
    ]);
  });

  it('falls back to {content} (not throw) when publish_payload is corrupt JSON', () => {
    const store = createCognitionStore({ db: getDb() });
    // A non-null but malformed payload must not block the flush loop for other rows.
    const r = getDb()
      .prepare(
        `INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome, content, reason, publish_payload)
         VALUES ('morningBrief', 5000, 1, 'publish', 'salvaged brief', NULL, '{not valid json')`,
      )
      .run();
    const found = store.findUndeliveredPublishes(0);
    expect(found).toEqual([
      { runId: Number(r.lastInsertRowid), payload: { content: 'salvaged brief' } },
    ]);
  });

  it('includes a run whose fired_at equals sinceMs (>= boundary, not >)', () => {
    const store = createCognitionStore({ db: getDb() });
    const id = store.recordHandlerRun({
      handlerName: 'morningBrief',
      firedAt: 4000,
      durationMs: 1,
      result: { publish: true, content: 'edge' },
    });
    // fired_at === sinceMs must be eligible; an off-by-one (> vs >=) would drop it.
    const found = store.findUndeliveredPublishes(4000);
    expect(found.map((f) => f.runId)).toEqual([id]);
  });
});
