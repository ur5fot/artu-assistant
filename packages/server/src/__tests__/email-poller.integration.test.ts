import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { initDb, closeDb, getDb } from '../db.js';
import { createEmailStore } from '../emails/store.js';
import { runPollTick } from '../emails/multi-account-poller.js';
import type { ImapAccount } from '../emails/types.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

const accA: ImapAccount = { id: 'a', host: 'h', port: 993, user: 'u', password: 'p', tls: true };

describe('email-poller UIDVALIDITY reset → cognition integration', () => {
  it('emits exactly one cognition_publish on a UIDVALIDITY change and resets the watermark', async () => {
    const store = createEmailStore({ db: getDb() });
    const bus = new EventEmitter();
    const events: Array<{ type: string; runId?: number; handler?: string; content?: string }> = [];
    bus.on('push', (e) => events.push(e));

    // Dead epoch watermark: high UID stored against the old UIDVALIDITY 111.
    store.setLastSeenAndValidity('a', 5000, 111, 1000);

    // Mailbox recreated: validity flipped to 222, UIDs restarted low (maxUid 7).
    const validityProbe = vi.fn(async () => 222);
    const maxUidProbe = vi.fn(async () => 7);
    const fetcher = vi.fn(async () => []);
    const scorer = vi.fn(async () => []);

    // onUidValidityReset mirrors index.ts wiring: console.warn (omitted here) +
    // one cognition_publish through the bus with sentinel runId -1.
    const onUidValidityReset = (info: { account: string; previous: number; current: number }) =>
      bus.emit('push', {
        type: 'cognition_publish',
        runId: -1,
        handler: 'email-poller',
        content: `reset ${info.account} ${info.previous}->${info.current}`,
      });

    await runPollTick({
      accounts: [accA],
      store,
      fetcher,
      scorer,
      maxUidProbe,
      validityProbe,
      onUidValidityReset,
      now: 2000,
    });

    // Reset path: we bailed before fetching, reset watermark to current maxUid,
    // and persisted the new validity.
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.getLastSeenUid('a')).toBe(7);
    expect(store.getUidValidity('a')).toBe(222);

    const publishes = events.filter(
      (e) => e.type === 'cognition_publish' && e.handler === 'email-poller',
    );
    expect(publishes.length).toBe(1);
    expect(typeof publishes[0].content).toBe('string');
    expect(publishes[0].content!.length).toBeGreaterThan(0);

    // Next tick: validity now matches stored (222) → normal path, no re-alert.
    const validityProbe2 = vi.fn(async () => 222);
    const fetcher2 = vi.fn(async () => []);
    await runPollTick({
      accounts: [accA],
      store,
      fetcher: fetcher2,
      scorer,
      maxUidProbe,
      validityProbe: validityProbe2,
      onUidValidityReset,
      now: 3000,
    });

    // Still exactly one publish — one alert per reset event.
    expect(events.filter((e) => e.type === 'cognition_publish').length).toBe(1);
    // Ongoing path resumed: this tick did fetch (validity matched).
    expect(fetcher2).toHaveBeenCalled();
  });
});
