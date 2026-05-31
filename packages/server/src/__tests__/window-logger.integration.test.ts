import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { initDb, closeDb, getDb } from '../db.js';
import { createCognitionStore } from '../cognition/store.js';
import { createHandlerRegistry } from '../cognition/registry.js';
import { createJobQueue } from '../cognition/queue.js';
import { createDispatcher } from '../cognition/dispatcher.js';
import { createWindowHistoryStore } from '../observers/window-history-store.js';
import { createContextPingStore } from '../observers/context-switch-detector.js';
import { startWindowLogger } from '../observers/window-logger.js';
import { createContextSwitchHandler } from '../cognition/handlers/contextSwitch.js';
import type { WindowSnapshot, WindowSnapshotProvider } from '../observers/window-snapshot.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

const INTERVAL_MS = 30_000;
const START = Date.UTC(2026, 4, 29, 9, 0, 0);

// A provider that walks a fixed script of snapshots, one per poll tick, and
// repeats the final snapshot once exhausted (so a stray trailing tick is
// harmless rather than throwing).
function scriptedProvider(script: WindowSnapshot[]): WindowSnapshotProvider {
  let idx = 0;
  return {
    async getActive() {
      const snap = script[Math.min(idx, script.length - 1)];
      idx += 1;
      return snap;
    },
  };
}

function repeat(snap: WindowSnapshot, n: number): WindowSnapshot[] {
  return Array.from({ length: n }, () => ({ ...snap }));
}

describe('window-logger → context-switch → cognition integration', () => {
  it('polls samples, detects the Chrome away-session, and pings exactly once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);

    const db = getDb();
    const cognStore = createCognitionStore({ db });
    const registry = createHandlerRegistry();
    const bus = new EventEmitter();
    const events: Array<{
      type: string;
      runId?: number;
      handler?: string;
      content?: string;
      embed?: { fields?: Array<{ name: string; value: string }> };
    }> = [];
    bus.on('push', (e) => events.push(e));
    const queue = createJobQueue({ registry, store: cognStore, bus });
    const dispatcher = createDispatcher({ registry, queue, store: cognStore, db });

    const windowStore = createWindowHistoryStore({ db });
    const pingStore = createContextPingStore({ db });

    // Thresholds tuned for the compressed test timeline (6 min Chrome session
    // must clear longSessionMin). The detection logic is identical to prod.
    registry.register(
      createContextSwitchHandler({
        store: windowStore,
        pingStore,
        longSessionMin: 5,
        switchGapMin: 5,
        stableNewMin: 5,
        dedupeWindowH: 8,
      }),
    );

    const iterm: WindowSnapshot = { app_name: 'iTerm2', window_title: 'zsh — R2' };
    const chrome: WindowSnapshot = { app_name: 'Google Chrome', window_title: 'Inbox — Gmail' };
    // 70 × iTerm (35 min) → 12 × Chrome (6 min) → 11 × iTerm (5.5 min)
    const script = [...repeat(iterm, 70), ...repeat(chrome, 12), ...repeat(iterm, 11)];
    const provider = scriptedProvider(script);

    queue.start();
    const stop = startWindowLogger({ store: windowStore, provider, intervalMs: INTERVAL_MS });

    // Tick 0 fires synchronously inside startWindowLogger; flush its promise
    // chain, then advance one interval per remaining scripted sample.
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 1; i < script.length; i++) {
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    }
    stop();

    // Coalescing should have produced exactly three rows: iTerm, Chrome, iTerm.
    const rows = windowStore.findRecentRows(0, 200);
    expect(rows.map((r) => r.app_name)).toEqual(['iTerm2', 'Google Chrome', 'iTerm2']);

    // Heartbeat fires shortly after the latest sample.
    vi.setSystemTime(START + script.length * INTERVAL_MS);
    await dispatcher.runTick(Date.now());
    await vi.advanceTimersByTimeAsync(0);

    const publishes = events.filter((e) => e.type === 'cognition_publish');
    expect(publishes.length).toBe(1);
    const ev = publishes[0];
    expect(ev.handler).toBe('contextSwitch');
    const wasOn = ev.embed?.fields?.find((f) => f.name === 'Was on');
    expect(wasOn?.value).toBe('Google Chrome');

    // Ping is only recorded after the publish channel confirms delivery.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM context_pings').get() as { n: number }).n,
    ).toBe(0);

    queue.firePublished(ev.runId!);
    await vi.advanceTimersByTimeAsync(0);

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM context_pings').get() as { n: number }).n,
    ).toBe(1);
    const ping = db
      .prepare('SELECT away_app FROM context_pings LIMIT 1')
      .get() as { away_app: string };
    expect(ping.away_app).toBe('Google Chrome');

    await queue.stop();
  });

  it('emits exactly one cognition_publish on a blind streak and records no rows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);

    const db = getDb();
    const bus = new EventEmitter();
    const events: Array<{ type: string; runId?: number; handler?: string; content?: string }> = [];
    bus.on('push', (e) => events.push(e));

    const windowStore = createWindowHistoryStore({ db });

    // Permanently blind provider: every poll returns null — the real osascript
    // failure mode after sleep/wake, which onError (throw-only) never sees.
    const provider: WindowSnapshotProvider = {
      async getActive() {
        return null;
      },
    };

    const stop = startWindowLogger({
      store: windowStore,
      provider,
      intervalMs: INTERVAL_MS,
      blindAlertAfter: 3,
      onBlind: ({ consecutive }) =>
        bus.emit('push', {
          type: 'cognition_publish',
          runId: -1, // sentinel: poller has no cognition_handler_runs row
          handler: 'window-logger',
          content: `blind ~${consecutive}`,
        }),
    });

    // Six blind ticks — well past the threshold of 3.
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 1; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    }
    stop();

    const publishes = events.filter(
      (e) => e.type === 'cognition_publish' && e.handler === 'window-logger',
    );
    expect(publishes.length).toBe(1); // fired once at threshold, no spam
    expect(typeof publishes[0].content).toBe('string');
    expect(publishes[0].content!.length).toBeGreaterThan(0);

    // Nothing was written during the blind streak.
    expect(windowStore.findRecentRows(0, 200)).toEqual([]);
  });
});
