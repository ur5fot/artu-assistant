import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDb, getDb, closeDb } from '../db.js';
import { createEmailStore } from '../emails/store.js';
import { createEmailSentLog } from '../emails/sent-log.js';
import { createEmailSuppressionStore } from '../emails/suppression-store.js';
import { createCommandService } from '../services/command-service.js';
import { createEmailUrgentHandler } from '../cognition/handlers/emailUrgent.js';
import {
  routeInteraction,
  type InteractionDeps,
} from '../channels/discord/interactions.js';
import type { EmailPendingRow } from '../emails/types.js';

// Integration boundaries: real EmailStore + EmailSentLog + EmailSuppressionStore
// + CommandService + emailUrgent handler, all wired against the same in-memory
// SQLite. Only the Discord interaction surface (button + slash command) is
// faked. The point is to confirm the pieces compose end-to-end the way they
// are wired in index.ts/bot.ts — not to re-test branch coverage already
// pinned down by per-module unit tests.

function insertPending(opts: {
  from_addr: string;
  subject: string;
  message_uid: number;
  received_at?: number;
}): EmailPendingRow {
  const store = createEmailStore({ db: getDb() });
  store.insertPending({
    account_id: 'acc-1',
    message_uid: opts.message_uid,
    from_addr: opts.from_addr,
    subject: opts.subject,
    snippet: 'snip',
    importance: 5,
    received_at: opts.received_at ?? 1_700_000_000_000,
    added_at: 1_700_000_001_000,
  });
  const row = getDb()
    .prepare('SELECT * FROM email_pending WHERE message_uid = ? AND account_id = ?')
    .get(opts.message_uid, 'acc-1') as EmailPendingRow;
  return row;
}

function makeSenderTtlButton(rowId: number, ttl: number) {
  return {
    isButton: () => true,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isChatInputCommand: () => false,
    user: { id: 'user-1' },
    customId: `email_suppress:sender_set_ttl:${rowId}:${ttl}`,
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeWhySlashIxn(id?: number) {
  const getInteger = vi.fn((name: string) =>
    name === 'id' && typeof id === 'number' ? id : null,
  );
  return {
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isChatInputCommand: () => true,
    commandName: 'why',
    user: { id: 'user-1' },
    options: { getInteger },
    reply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('email suppress flow — integration', () => {
  beforeEach(() => initDb(':memory:'));
  afterEach(() => closeDb());

  it('sender TTL button → urgent trigger marks matching row -1 → /why explains suppression', async () => {
    const emailStore = createEmailStore({ db: getDb() });
    const emailSentLog = createEmailSentLog({ db: getDb() });
    const emailSuppressionStore = createEmailSuppressionStore({ db: getDb() });

    const row1 = insertPending({
      from_addr: 'alerts@bank.com',
      subject: 'Large transaction notice',
      message_uid: 1001,
      received_at: 1_700_000_000_000,
    });
    const row2 = insertPending({
      from_addr: 'alerts@bank.com',
      subject: 'Another statement',
      message_uid: 1002,
      // received later so findUnpingedUrgent (ORDER BY received_at ASC) picks
      // row1 first; we'll mark row1 as already-pinged below so the trigger
      // tries row2 next, which is what the suppression should catch.
      received_at: 1_700_000_100_000,
    });

    // Pretend row1 was already pinged in a prior tick — that's the typical
    // path: the user sees row1's urgent embed, clicks 🙈 Sender, picks 7d. On
    // the next tick, row2 (same sender) is the candidate the rule must block.
    emailStore.markUrgentPinged(row1.id, 1_700_000_050_000);

    // Step 1: simulate the 🙈 Sender → 7d button click.
    const commandService = createCommandService({
      db: getDb(),
      reminderService: { list: vi.fn().mockReturnValue([]) } as any,
      permissionService: { hasPending: vi.fn() } as any,
      memoryService: null,
      emailStore,
      emailSentLog,
      emailSuppressionStore,
    });
    const deps: InteractionDeps = {
      whitelist: new Set(['user-1']),
      reminderService: {} as any,
      permissionService: {} as any,
      planReviewService: {} as any,
      commandService,
      cognitionService: {} as any,
      emailStore,
      emailSuppressionStore,
    };
    const setTtlIxn = makeSenderTtlButton(row1.id, 7);
    await routeInteraction(setTtlIxn, deps);

    const rules = emailSuppressionStore.listActive(Date.now());
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      rule_type: 'sender',
      pattern: 'alerts@bank.com',
    });
    expect(rules[0]!.expires_at).not.toBeNull();

    // Step 2: run the urgent trigger. Use a time well inside the rule TTL and
    // outside quiet hours so the trigger isn't short-circuited by the
    // inQuietHours guard. 12:00 UTC on 2024-01-15 is 14:00 in Europe/Kyiv,
    // which is outside the 22:00-* quiet window.
    const handler = createEmailUrgentHandler({
      store: emailStore,
      suppressionStore: emailSuppressionStore,
      tz: 'Europe/Kyiv',
      quietStart: 22,
    });
    const triggeredAt = new Date('2024-01-15T12:00:00Z').getTime();
    const triggered = await handler.trigger(
      { now: triggeredAt, lastFiredAt: null, lastResult: null },
      { db: getDb() },
    );
    expect(triggered).toBe(false);

    const row2After = emailStore.findByPendingId(row2.id);
    expect(row2After).not.toBeNull();
    expect(row2After!.urgent_pinged_at).toBe(-1);

    // Step 3: /why id:row2 → embed describes the suppression rule.
    const whyIxn = makeWhySlashIxn(row2.id);
    await routeInteraction(whyIxn, deps);

    expect(whyIxn.reply).toHaveBeenCalledTimes(1);
    const replyArg = whyIxn.reply.mock.calls[0][0];
    const embed = replyArg.embeds[0];
    const embedJson = typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
    expect(embedJson.title).toBe('🙈 Suppressed by rule');
    expect(embedJson.description).toContain('alerts@bank.com');
    expect(embedJson.description).toContain('отправитель');
  });
});
