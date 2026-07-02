import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageFlags } from 'discord.js';
import { initDb, getDb, closeDb } from '../../../db.js';
import { createEmailStore } from '../../../emails/store.js';
import { createEmailSentLog } from '../../../emails/sent-log.js';
import { createEmailSuppressionStore } from '../../../emails/suppression-store.js';
import { createEmailFeedbackStore } from '../../../emails/feedback-store.js';
import { AUTO_FEEDBACK_VIA } from '../../../emails/feedback-scorer.js';
import type { FeedbackOutcome } from '../../../emails/feedback-store.js';
import { createCommandService } from '../../../services/command-service.js';
import { routeInteraction, type InteractionDeps } from '../interactions.js';
import type { EmailPendingRow } from '../../../emails/types.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

function makeWhySlashIxn(opts: { id?: number; userId?: string } = {}) {
  const getInteger = vi.fn((name: string) =>
    name === 'id' && typeof opts.id === 'number' ? opts.id : null,
  );
  return {
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isChatInputCommand: () => true,
    commandName: 'why',
    user: { id: opts.userId ?? 'user-1' },
    options: { getInteger },
    reply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeBaseDeps(overrides: Partial<InteractionDeps> = {}): InteractionDeps {
  return {
    whitelist: new Set(['user-1']),
    reminderService: {} as any,
    permissionService: {} as any,
    planReviewService: {} as any,
    commandService: {} as any,
    cognitionService: {} as any,
    ...overrides,
  };
}

function insertPendingRow(opts: {
  from_addr?: string;
  subject?: string;
  importance?: number;
  received_at?: number;
  urgent_pinged_at?: number | null;
}): EmailPendingRow {
  const store = createEmailStore({ db: getDb() });
  store.insertPending({
    account_id: 'acc-1',
    message_uid: Math.floor(Math.random() * 1_000_000),
    from_addr: opts.from_addr ?? 'alerts@bank.com',
    subject: opts.subject ?? 'Large transaction notice',
    snippet: 'snip',
    importance: opts.importance ?? 5,
    received_at: opts.received_at ?? 1_700_000_000_000,
    added_at: 1_700_000_001_000,
  });
  // Find the just-inserted row (fetchPendingUndelivered returns by importance/received).
  const rows = getDb()
    .prepare('SELECT * FROM email_pending ORDER BY id DESC LIMIT 1')
    .all() as EmailPendingRow[];
  const row = rows[0]!;
  if (opts.urgent_pinged_at !== undefined && opts.urgent_pinged_at !== null) {
    store.markUrgentPinged(row.id, opts.urgent_pinged_at);
    return { ...row, urgent_pinged_at: opts.urgent_pinged_at };
  }
  return row;
}

describe('commandService.whyEmailUrgent', () => {
  it('returns not_configured when email stores are absent', () => {
    const svc = createCommandService({
      db: getDb(),
      reminderService: { list: vi.fn().mockReturnValue([]) } as any,
      permissionService: { hasPending: vi.fn() } as any,
      memoryService: null,
    });
    expect(svc.whyEmailUrgent({}).kind).toBe('not_configured');
  });

  it('returns no_recent_urgent when no row has been urgent-pinged', () => {
    const svc = createCommandService({
      db: getDb(),
      reminderService: { list: vi.fn().mockReturnValue([]) } as any,
      permissionService: { hasPending: vi.fn() } as any,
      memoryService: null,
      emailStore: createEmailStore({ db: getDb() }),
      emailSentLog: createEmailSentLog({ db: getDb() }),
      emailSuppressionStore: createEmailSuppressionStore({ db: getDb() }),
    });
    expect(svc.whyEmailUrgent({}).kind).toBe('no_recent_urgent');
  });

  it('returns not_found when explicit id has no row', () => {
    const svc = createCommandService({
      db: getDb(),
      reminderService: { list: vi.fn().mockReturnValue([]) } as any,
      permissionService: { hasPending: vi.fn() } as any,
      memoryService: null,
      emailStore: createEmailStore({ db: getDb() }),
      emailSentLog: createEmailSentLog({ db: getDb() }),
      emailSuppressionStore: createEmailSuppressionStore({ db: getDb() }),
    });
    const result = svc.whyEmailUrgent({ id: 9999 });
    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') expect(result.id).toBe(9999);
  });

  it('returns urgent with zero-count history when the row has no priors', () => {
    const row = insertPendingRow({ urgent_pinged_at: 1_700_000_005_000 });
    const svc = createCommandService({
      db: getDb(),
      reminderService: { list: vi.fn().mockReturnValue([]) } as any,
      permissionService: { hasPending: vi.fn() } as any,
      memoryService: null,
      emailStore: createEmailStore({ db: getDb() }),
      emailSentLog: createEmailSentLog({ db: getDb() }),
      emailSuppressionStore: createEmailSuppressionStore({ db: getDb() }),
    });
    const result = svc.whyEmailUrgent({ now: 1_700_000_010_000 });
    expect(result.kind).toBe('urgent');
    if (result.kind === 'urgent') {
      expect(result.row.id).toBe(row.id);
      // The row itself counts as 1 pending from the sender within the window.
      expect(result.history.pendings).toBe(1);
      expect(result.history.sent).toBe(0);
      expect(result.history.cancelled).toBe(0);
      expect(result.history.error).toBe(0);
      expect(result.activeRule).toBeNull();
    }
  });

  it('counts prior pendings, sent, cancelled, error from the same sender', () => {
    const sender = 'alerts@bank.com';
    // Use a "now" anchored to wall-clock so the 7-day window covers the
    // synthesised received_at timestamps; using fixed 1.7e12 values puts the
    // rows years before Date.now() and the window excludes them.
    const now = Date.now();
    // Two prior pendings from the same sender + the urgent row itself = 3.
    insertPendingRow({ from_addr: sender, received_at: now - 60_000 });
    insertPendingRow({ from_addr: sender, received_at: now - 30_000 });
    const urgent = insertPendingRow({
      from_addr: sender,
      received_at: now - 10_000,
      urgent_pinged_at: now - 5_000,
    });

    const sentLog = createEmailSentLog({ db: getDb() });
    sentLog.record({ action: 'sent', draftId: 's1', to: sender, subject: 'r1' });
    sentLog.record({ action: 'cancelled', draftId: 'c1', to: sender, subject: 'r2' });
    sentLog.record({ action: 'cancelled', draftId: 'c2', to: sender, subject: 'r3' });
    sentLog.record({ action: 'error', draftId: 'e1', to: sender, subject: 'r4', errorMessage: 'x' });
    // Unrelated sender — must not contaminate the counts.
    sentLog.record({ action: 'sent', draftId: 'x1', to: 'other@x.com', subject: 'noise' });

    const svc = createCommandService({
      db: getDb(),
      reminderService: { list: vi.fn().mockReturnValue([]) } as any,
      permissionService: { hasPending: vi.fn() } as any,
      memoryService: null,
      emailStore: createEmailStore({ db: getDb() }),
      emailSentLog: sentLog,
      emailSuppressionStore: createEmailSuppressionStore({ db: getDb() }),
    });
    const result = svc.whyEmailUrgent({ id: urgent.id, now });
    expect(result.kind).toBe('urgent');
    if (result.kind === 'urgent') {
      expect(result.history.pendings).toBe(3);
      expect(result.history.sent).toBe(1);
      expect(result.history.cancelled).toBe(2);
      expect(result.history.error).toBe(1);
    }
  });

  it('surfaces an active suppression rule that matches the urgent row', () => {
    const sender = 'alerts@bank.com';
    const urgent = insertPendingRow({
      from_addr: sender,
      urgent_pinged_at: 1_700_000_005_000,
    });
    const suppression = createEmailSuppressionStore({ db: getDb() });
    const inserted = suppression.insertRule({
      rule_type: 'sender',
      pattern: sender,
      ttl_days: 7,
    });

    const svc = createCommandService({
      db: getDb(),
      reminderService: { list: vi.fn().mockReturnValue([]) } as any,
      permissionService: { hasPending: vi.fn() } as any,
      memoryService: null,
      emailStore: createEmailStore({ db: getDb() }),
      emailSentLog: createEmailSentLog({ db: getDb() }),
      emailSuppressionStore: suppression,
    });
    const result = svc.whyEmailUrgent({ id: urgent.id, now: Date.now() });
    expect(result.kind).toBe('urgent');
    if (result.kind === 'urgent') {
      expect(result.activeRule).not.toBeNull();
      expect(result.activeRule?.id).toBe(inserted.id);
      expect(result.activeRule?.pattern).toBe(sender);
    }
  });

  it('canonicalizes display-name from_addr when counting sent-log priors', () => {
    // Regression: email_pending.from_addr is stored as `"Name" <addr>` while
    // email_sent_log.to_addr is the bare address (parseFromAddress at the
    // draft-reply callsite). Without canonicalization in whyEmailUrgent, the
    // exact-match `to_addr = ?` lookup misses every prior with a display name.
    const now = Date.now();
    const bareAddr = 'boss@example.com';
    const displayForm = `"Big Boss" <${bareAddr}>`;
    const urgent = insertPendingRow({
      from_addr: displayForm,
      received_at: now - 10_000,
      urgent_pinged_at: now - 5_000,
    });
    const sentLog = createEmailSentLog({ db: getDb() });
    sentLog.record({ action: 'sent', draftId: 's1', to: bareAddr, subject: 'r1' });
    sentLog.record({ action: 'cancelled', draftId: 'c1', to: bareAddr, subject: 'r2' });

    const svc = createCommandService({
      db: getDb(),
      reminderService: { list: vi.fn().mockReturnValue([]) } as any,
      permissionService: { hasPending: vi.fn() } as any,
      memoryService: null,
      emailStore: createEmailStore({ db: getDb() }),
      emailSentLog: sentLog,
      emailSuppressionStore: createEmailSuppressionStore({ db: getDb() }),
    });
    const result = svc.whyEmailUrgent({ id: urgent.id, now });
    expect(result.kind).toBe('urgent');
    if (result.kind === 'urgent') {
      expect(result.history.sent).toBe(1);
      expect(result.history.cancelled).toBe(1);
    }
  });

  it('returns not_urgent when row exists but was never urgent-pinged', () => {
    // /why id:<n> must not render "🔍 Why this is urgent" for rows that were
    // never pinged (importance < 5, or still queued). Caller renders a
    // separate "not pinged" embed instead.
    const row = insertPendingRow({ importance: 4 });
    const svc = createCommandService({
      db: getDb(),
      reminderService: { list: vi.fn().mockReturnValue([]) } as any,
      permissionService: { hasPending: vi.fn() } as any,
      memoryService: null,
      emailStore: createEmailStore({ db: getDb() }),
      emailSentLog: createEmailSentLog({ db: getDb() }),
      emailSuppressionStore: createEmailSuppressionStore({ db: getDb() }),
    });
    const result = svc.whyEmailUrgent({ id: row.id, now: Date.now() });
    expect(result.kind).toBe('not_urgent');
    if (result.kind === 'not_urgent') {
      expect(result.row.id).toBe(row.id);
      expect(result.activeRule).toBeNull();
    }
  });

  it('attaches feedback signals (mixed outcomes) for the sender when feedback store present', () => {
    const now = Date.now();
    const sender = 'alerts@bank.com';
    const feedbackStore = createEmailFeedbackStore({ db: getDb() });
    // Resolve one of each outcome for the sender, all pinged inside the window.
    const outcomes: FeedbackOutcome[] = ['replied', 'read', 'ignored', 'ignored'];
    for (const outcome of outcomes) {
      const r = insertPendingRow({ from_addr: sender, received_at: now - 60_000 });
      feedbackStore.recordPinged(r.id, now - 50_000);
      feedbackStore.finalize(r.id, outcome, now - 10_000);
    }
    const urgent = insertPendingRow({
      from_addr: sender,
      received_at: now - 10_000,
      urgent_pinged_at: now - 5_000,
    });
    const svc = createCommandService({
      db: getDb(),
      reminderService: { list: vi.fn().mockReturnValue([]) } as any,
      permissionService: { hasPending: vi.fn() } as any,
      memoryService: null,
      emailStore: createEmailStore({ db: getDb() }),
      emailSentLog: createEmailSentLog({ db: getDb() }),
      emailSuppressionStore: createEmailSuppressionStore({ db: getDb() }),
      emailFeedbackStore: feedbackStore,
    });
    const result = svc.whyEmailUrgent({ id: urgent.id, now });
    expect(result.kind).toBe('urgent');
    if (result.kind === 'urgent') {
      expect(result.feedback).not.toBeNull();
      expect(result.feedback?.replied).toBe(1);
      expect(result.feedback?.read).toBe(1);
      expect(result.feedback?.ignored).toBe(2);
      expect(result.feedback?.autoSuppression).toBeNull();
    }
  });

  it('surfaces an active auto_feedback suppression in feedback signals', () => {
    const now = Date.now();
    const sender = 'noisy@spam.com';
    const suppression = createEmailSuppressionStore({ db: getDb() });
    const inserted = suppression.insertRule({
      rule_type: 'sender',
      pattern: sender,
      ttl_days: 7,
      created_via: AUTO_FEEDBACK_VIA,
    });
    const urgent = insertPendingRow({
      from_addr: sender,
      received_at: now - 10_000,
      urgent_pinged_at: now - 5_000,
    });
    const svc = createCommandService({
      db: getDb(),
      reminderService: { list: vi.fn().mockReturnValue([]) } as any,
      permissionService: { hasPending: vi.fn() } as any,
      memoryService: null,
      emailStore: createEmailStore({ db: getDb() }),
      emailSentLog: createEmailSentLog({ db: getDb() }),
      emailSuppressionStore: suppression,
      emailFeedbackStore: createEmailFeedbackStore({ db: getDb() }),
    });
    const result = svc.whyEmailUrgent({ id: urgent.id, now });
    expect(result.kind).toBe('urgent');
    if (result.kind === 'urgent') {
      // No outcomes recorded yet → zero counts, but the auto-rule is reported.
      expect(result.feedback?.replied).toBe(0);
      expect(result.feedback?.read).toBe(0);
      expect(result.feedback?.ignored).toBe(0);
      expect(result.feedback?.autoSuppression).not.toBeNull();
      expect(result.feedback?.autoSuppression?.expiresAt).toBe(inserted.expires_at);
    }
  });

  it('feedback is null when no feedback store is wired (graceful empty)', () => {
    const urgent = insertPendingRow({ urgent_pinged_at: Date.now() - 5_000 });
    const svc = createCommandService({
      db: getDb(),
      reminderService: { list: vi.fn().mockReturnValue([]) } as any,
      permissionService: { hasPending: vi.fn() } as any,
      memoryService: null,
      emailStore: createEmailStore({ db: getDb() }),
      emailSentLog: createEmailSentLog({ db: getDb() }),
      emailSuppressionStore: createEmailSuppressionStore({ db: getDb() }),
    });
    const result = svc.whyEmailUrgent({ id: urgent.id, now: Date.now() });
    expect(result.kind).toBe('urgent');
    if (result.kind === 'urgent') expect(result.feedback).toBeNull();
  });

  it('returns suppressed when row has sentinel urgent_pinged_at = -1', () => {
    const sender = 'spam@nope.com';
    const row = insertPendingRow({ from_addr: sender, urgent_pinged_at: -1 });
    const suppression = createEmailSuppressionStore({ db: getDb() });
    const inserted = suppression.insertRule({
      rule_type: 'sender',
      pattern: sender,
      ttl_days: null,
    });
    const svc = createCommandService({
      db: getDb(),
      reminderService: { list: vi.fn().mockReturnValue([]) } as any,
      permissionService: { hasPending: vi.fn() } as any,
      memoryService: null,
      emailStore: createEmailStore({ db: getDb() }),
      emailSentLog: createEmailSentLog({ db: getDb() }),
      emailSuppressionStore: suppression,
    });
    const result = svc.whyEmailUrgent({ id: row.id, now: Date.now() });
    expect(result.kind).toBe('suppressed');
    if (result.kind === 'suppressed') {
      expect(result.row.id).toBe(row.id);
      expect(result.matchedRule?.id).toBe(inserted.id);
    }
  });
});

describe('/why slash command routing', () => {
  function makeCommandSvc(overrides: { result?: unknown } = {}) {
    return {
      whyEmailUrgent: vi.fn().mockReturnValue(
        overrides.result ?? { kind: 'no_recent_urgent' },
      ),
    } as any;
  }

  it('no recent urgent → "Недавних urgent писем нет"', async () => {
    const ixn = makeWhySlashIxn();
    const deps = makeBaseDeps({ commandService: makeCommandSvc() });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('Недавних urgent'),
      }),
    );
  });

  it('not_found → "не найдено"', async () => {
    const ixn = makeWhySlashIxn({ id: 42 });
    const deps = makeBaseDeps({
      commandService: makeCommandSvc({
        result: { kind: 'not_found', id: 42 },
      }),
    });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('не найдено'),
      }),
    );
  });

  it('not_configured → "не настроено"', async () => {
    const ixn = makeWhySlashIxn();
    const deps = makeBaseDeps({
      commandService: makeCommandSvc({ result: { kind: 'not_configured' } }),
    });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('не настроено'),
      }),
    );
  });

  it('urgent → embed with row info and zero-count history line', async () => {
    const row: EmailPendingRow = {
      id: 7,
      account_id: 'acc-1',
      message_uid: 42,
      from_addr: 'alerts@bank.com',
      subject: 'Large transaction notice',
      snippet: 'snip',
      importance: 5,
      received_at: 1_700_000_000_000,
      added_at: 1_700_000_001_000,
      delivered_at: null,
      urgent_pinged_at: 1_700_000_005_000,
      gist: null,
    };
    const ixn = makeWhySlashIxn({ id: 7 });
    const deps = makeBaseDeps({
      commandService: makeCommandSvc({
        result: {
          kind: 'urgent',
          row,
          history: { pendings: 0, sent: 0, cancelled: 0, error: 0 },
          activeRule: null,
        },
      }),
    });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledTimes(1);
    const args = ixn.reply.mock.calls[0]![0];
    expect(args.flags).toBe(MessageFlags.Ephemeral);
    const embeds = args.embeds as any[];
    expect(embeds.length).toBe(1);
    const description = embeds[0].data?.description ?? embeds[0].description ?? '';
    expect(description).toContain('alerts@bank.com');
    expect(description).toContain('Large transaction notice');
    expect(description).toContain('Importance: 5/5');
    expect(description).toMatch(/писем: 0/);
    expect(description).toMatch(/отправлено: 0/);
    expect(description).toMatch(/отменено: 0/);
    expect(description).toMatch(/ошибок: 0/);
    expect(description).toContain('Активное правило заглушения: —');
  });

  it('urgent with priors + active rule → counts shown, rule line populated', async () => {
    const row: EmailPendingRow = {
      id: 9,
      account_id: 'acc-1',
      message_uid: 42,
      from_addr: 'alerts@bank.com',
      subject: 'Order shipped',
      snippet: 'snip',
      importance: 5,
      received_at: 1_700_000_000_000,
      added_at: 1_700_000_001_000,
      delivered_at: null,
      urgent_pinged_at: 1_700_000_005_000,
      gist: null,
    };
    const ixn = makeWhySlashIxn({ id: 9 });
    const deps = makeBaseDeps({
      commandService: makeCommandSvc({
        result: {
          kind: 'urgent',
          row,
          history: { pendings: 3, sent: 1, cancelled: 1, error: 0 },
          activeRule: {
            id: 11,
            rule_type: 'sender',
            pattern: 'alerts@bank.com',
            created_at: 1_700_000_000_000,
            expires_at: 1_700_000_604_800_000,
            created_via: 'discord_button',
          },
        },
      }),
    });
    await routeInteraction(ixn, deps);
    const args = ixn.reply.mock.calls[0]![0];
    const embeds = args.embeds as any[];
    const description = embeds[0].data?.description ?? embeds[0].description ?? '';
    expect(description).toMatch(/писем: 3/);
    expect(description).toMatch(/отправлено: 1/);
    expect(description).toMatch(/отменено: 1/);
    expect(description).toMatch(/ошибок: 0/);
    expect(description).toContain('alerts@bank.com');
    // The rule line names the pattern; expiry label is locale-formatted, so
    // assert just the prefix to avoid a brittle date string match.
    expect(description).toMatch(/Активное правило заглушения: отправитель/);
  });

  it('urgent with feedback signals → reaction counts + auto-suppression line shown', async () => {
    const row: EmailPendingRow = {
      id: 51,
      account_id: 'acc-1',
      message_uid: 42,
      from_addr: 'noisy@spam.com',
      subject: 'Daily digest',
      snippet: 'snip',
      importance: 5,
      received_at: 1_700_000_000_000,
      added_at: 1_700_000_001_000,
      delivered_at: null,
      urgent_pinged_at: 1_700_000_005_000,
      gist: null,
    };
    const ixn = makeWhySlashIxn({ id: 51 });
    const deps = makeBaseDeps({
      commandService: makeCommandSvc({
        result: {
          kind: 'urgent',
          row,
          history: { pendings: 4, sent: 0, cancelled: 0, error: 0 },
          activeRule: null,
          feedback: {
            replied: 0,
            read: 1,
            ignored: 3,
            autoSuppression: { expiresAt: 1_700_000_604_800_000 },
          },
        },
      }),
    });
    await routeInteraction(ixn, deps);
    const args = ixn.reply.mock.calls[0]![0];
    const description = args.embeds[0].data?.description ?? args.embeds[0].description ?? '';
    expect(description).toMatch(/Реакция на urgent-пинги/);
    expect(description).toMatch(/ответил: 0/);
    expect(description).toMatch(/прочитал: 1/);
    expect(description).toMatch(/проигнорировал: 3/);
    expect(description).toMatch(/авто-заглушение активно/);
  });

  it('urgent without feedback (feature off) → no feedback section', async () => {
    const row: EmailPendingRow = {
      id: 52,
      account_id: 'acc-1',
      message_uid: 42,
      from_addr: 'alerts@bank.com',
      subject: 'Subj',
      snippet: 'snip',
      importance: 5,
      received_at: 1_700_000_000_000,
      added_at: 1_700_000_001_000,
      delivered_at: null,
      urgent_pinged_at: 1_700_000_005_000,
      gist: null,
    };
    const ixn = makeWhySlashIxn({ id: 52 });
    const deps = makeBaseDeps({
      commandService: makeCommandSvc({
        result: {
          kind: 'urgent',
          row,
          history: { pendings: 0, sent: 0, cancelled: 0, error: 0 },
          activeRule: null,
          feedback: null,
        },
      }),
    });
    await routeInteraction(ixn, deps);
    const args = ixn.reply.mock.calls[0]![0];
    const description = args.embeds[0].data?.description ?? args.embeds[0].description ?? '';
    expect(description).not.toMatch(/Реакция на urgent-пинги/);
  });

  it('not_urgent → embed says urgent ping never fired', async () => {
    const row: EmailPendingRow = {
      id: 17,
      account_id: 'acc-1',
      message_uid: 42,
      from_addr: 'newsletter@example.com',
      subject: 'Weekly update',
      snippet: 'snip',
      importance: 3,
      received_at: 1_700_000_000_000,
      added_at: 1_700_000_001_000,
      delivered_at: null,
      urgent_pinged_at: null,
      gist: null,
    };
    const ixn = makeWhySlashIxn({ id: 17 });
    const deps = makeBaseDeps({
      commandService: makeCommandSvc({
        result: { kind: 'not_urgent', row, activeRule: null },
      }),
    });
    await routeInteraction(ixn, deps);
    const args = ixn.reply.mock.calls[0]![0];
    const embeds = args.embeds as any[];
    const description = embeds[0].data?.description ?? embeds[0].description ?? '';
    expect(embeds[0].data?.title ?? embeds[0].title).toMatch(/не помечено как urgent/);
    expect(description).toContain('newsletter@example.com');
    expect(description).toContain('Importance: 3/5');
    expect(description).toMatch(/urgent ping не отправлялся/);
  });

  it('suppressed → embed explains which rule blocked it', async () => {
    const row: EmailPendingRow = {
      id: 13,
      account_id: 'acc-1',
      message_uid: 42,
      from_addr: 'spam@nope.com',
      subject: 'Newsletter',
      snippet: 'snip',
      importance: 5,
      received_at: 1_700_000_000_000,
      added_at: 1_700_000_001_000,
      delivered_at: null,
      urgent_pinged_at: -1,
      gist: null,
    };
    const ixn = makeWhySlashIxn({ id: 13 });
    const deps = makeBaseDeps({
      commandService: makeCommandSvc({
        result: {
          kind: 'suppressed',
          row,
          matchedRule: {
            id: 4,
            rule_type: 'subject',
            pattern: 'Newsletter',
            created_at: 1_700_000_000_000,
            expires_at: null,
            created_via: 'discord_button',
          },
        },
      }),
    });
    await routeInteraction(ixn, deps);
    const args = ixn.reply.mock.calls[0]![0];
    const embeds = args.embeds as any[];
    const description = embeds[0].data?.description ?? embeds[0].description ?? '';
    expect(embeds[0].data?.title ?? embeds[0].title).toMatch(/Suppressed/);
    expect(description).toContain('spam@nope.com');
    expect(description).toMatch(/Заглушено правилом: тема/);
    expect(description).toContain('Newsletter');
    expect(description).toContain('навсегда');
  });

  it('suppressed with no current matching rule → "правило истекло"', async () => {
    const row: EmailPendingRow = {
      id: 21,
      account_id: 'acc-1',
      message_uid: 42,
      from_addr: 'spam@nope.com',
      subject: 'Newsletter',
      snippet: 'snip',
      importance: 5,
      received_at: 1_700_000_000_000,
      added_at: 1_700_000_001_000,
      delivered_at: null,
      urgent_pinged_at: -1,
      gist: null,
    };
    const ixn = makeWhySlashIxn({ id: 21 });
    const deps = makeBaseDeps({
      commandService: makeCommandSvc({
        result: { kind: 'suppressed', row, matchedRule: null },
      }),
    });
    await routeInteraction(ixn, deps);
    const args = ixn.reply.mock.calls[0]![0];
    const description = args.embeds[0].data?.description ?? args.embeds[0].description ?? '';
    expect(description).toMatch(/правило истекло|правило/);
  });

  it('suppressed by auto_feedback rule → embed shows reaction counts + auto provenance', async () => {
    const row: EmailPendingRow = {
      id: 22,
      account_id: 'acc-1',
      message_uid: 42,
      from_addr: 'spam@nope.com',
      subject: 'Newsletter',
      snippet: 'snip',
      importance: 5,
      received_at: 1_700_000_000_000,
      added_at: 1_700_000_001_000,
      delivered_at: null,
      urgent_pinged_at: -1,
      gist: null,
    };
    const ixn = makeWhySlashIxn({ id: 22 });
    const deps = makeBaseDeps({
      commandService: makeCommandSvc({
        result: {
          kind: 'suppressed',
          row,
          matchedRule: {
            id: 7,
            rule_type: 'sender',
            pattern: 'spam@nope.com',
            created_at: 1_700_000_000_000,
            expires_at: 1_700_000_900_000,
            created_via: 'auto_feedback',
          },
          feedback: {
            replied: 0,
            read: 1,
            ignored: 3,
            autoSuppression: { expiresAt: 1_700_000_900_000 },
          },
        },
      }),
    });
    await routeInteraction(ixn, deps);
    const args = ixn.reply.mock.calls[0]![0];
    const description = args.embeds[0].data?.description ?? args.embeds[0].description ?? '';
    // Rule line flags R2 provenance, and the feedback section explains *why*.
    expect(description).toMatch(/авто \(по реакции\)/);
    expect(description).toContain('Реакция на urgent-пинги');
    expect(description).toMatch(/проигнорировал: 3/);
    expect(description).toMatch(/авто-заглушение активно/);
  });

  it('clips multi-KB from_addr so embed description stays under Discord cap', async () => {
    // Discord embed description hard limit is 4096 — EmbedBuilder.setDescription
    // throws RangeError past it. A malicious sender with a multi-KB display
    // name would otherwise break /why for that row and leave the slash
    // interaction unacked.
    const longFrom =
      '"' + 'A'.repeat(8000) + '" <attacker@evil.com>';
    const row: EmailPendingRow = {
      id: 31,
      account_id: 'acc-1',
      message_uid: 42,
      from_addr: longFrom,
      subject: 'short subject',
      snippet: 'snip',
      importance: 5,
      received_at: 1_700_000_000_000,
      added_at: 1_700_000_001_000,
      delivered_at: null,
      urgent_pinged_at: 1_700_000_005_000,
      gist: null,
    };
    const ixn = makeWhySlashIxn({ id: 31 });
    const deps = makeBaseDeps({
      commandService: makeCommandSvc({
        result: {
          kind: 'urgent',
          row,
          history: { pendings: 0, sent: 0, cancelled: 0, error: 0 },
          activeRule: null,
        },
      }),
    });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledTimes(1);
    const description =
      ixn.reply.mock.calls[0]![0].embeds[0].data?.description ?? '';
    expect(description.length).toBeLessThan(4096);
    expect(description).toContain('…');
  });
});
