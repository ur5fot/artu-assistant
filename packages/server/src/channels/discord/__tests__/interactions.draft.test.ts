import { describe, it, expect, vi, afterEach } from 'vitest';
import { MessageFlags } from 'discord.js';
import {
  parseFromAddress,
  routeInteraction,
  type InteractionDeps,
} from '../interactions.js';
import {
  createDraftReplyService,
  type DraftState,
} from '../../../services/draft-reply-service.js';
import type { EmailStore } from '../../../emails/store.js';
import type { EmailPendingRow, FullMessage, ImapAccount } from '../../../emails/types.js';
import type { MessageHeaders } from '../../../emails/imap-client.js';

const SAMPLE_ROW: EmailPendingRow = {
  id: 7,
  account_id: 'acc-1',
  message_uid: 42,
  from_addr: 'Alice <alice@example.com>',
  subject: 'Project status',
  snippet: 'Hey, any update?',
  importance: 5,
  received_at: 1_700_000_000_000,
  added_at: 1_700_000_001_000,
  delivered_at: null,
  urgent_pinged_at: 1_700_000_002_000,
};

const SAMPLE_ACCOUNT: ImapAccount = {
  id: 'acc-1',
  host: 'imap.example.com',
  port: 993,
  user: 'me@example.com',
  password: 'secret',
  tls: true,
};

const SAMPLE_HEADERS: MessageHeaders = {
  messageId: '<orig@example.com>',
  inReplyTo: null,
  references: ['<root@example.com>'],
};

const SAMPLE_THREAD: FullMessage[] = [
  { uid: 30, from: 'Alice', subject: 'Project status', bodyText: 'kickoff plan attached', receivedAt: 1 },
  { uid: 42, from: 'Alice', subject: 'Project status', bodyText: 'Hey, any update on the kickoff?', receivedAt: 2 },
];

function makeDeps(overrides: Partial<InteractionDeps> = {}): InteractionDeps {
  const emailStore = {
    findByPendingId: vi.fn().mockReturnValue(SAMPLE_ROW),
  } as unknown as EmailStore;
  const imapClient = {
    fetchHeaders: vi.fn().mockResolvedValue(SAMPLE_HEADERS),
  };
  const threadFetcher = {
    fetchThread: vi.fn().mockResolvedValue(SAMPLE_THREAD),
  };
  const anthropic = {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Yes, shipping Friday.' }],
      }),
    },
  } as any;
  const imapAccounts = new Map<string, ImapAccount>([['acc-1', SAMPLE_ACCOUNT]]);
  const draftReplyService = createDraftReplyService({ pendingDrafts: new Map() });
  const smtpClient = { sendReply: vi.fn().mockResolvedValue({ messageId: 'smtp-1' }) };

  return {
    whitelist: new Set(['user-1']),
    reminderService: {} as any,
    permissionService: {} as any,
    planReviewService: {} as any,
    commandService: {} as any,
    cognitionService: {} as any,
    draftReplyService,
    emailStore,
    imapClient,
    threadFetcher,
    anthropic,
    imapAccounts,
    smtpClient,
    ...overrides,
  };
}

function sampleDraftState(overrides: Partial<DraftState> = {}): DraftState {
  return {
    pendingId: 'p1',
    originalUid: 42,
    accountId: 'acc-1',
    to: 'alice@example.com',
    subject: 'Re: Project status',
    inReplyTo: '<orig@example.com>',
    references: ['<root@example.com>', '<orig@example.com>'],
    body: 'Yes, shipping Friday.',
    ...overrides,
  };
}

function makeModalSubmit(overrides: Record<string, any> = {}) {
  return {
    isButton: () => false,
    isModalSubmit: () => true,
    isChatInputCommand: () => false,
    user: { id: 'user-1' },
    customId: 'email_draft_modal:p1',
    fields: { getTextInputValue: vi.fn().mockReturnValue('edited body') },
    update: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function makeButton(overrides: Record<string, any> = {}) {
  const webhookEditMessage = vi.fn().mockResolvedValue(undefined);
  return {
    isButton: () => true,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    user: { id: 'user-1' },
    customId: 'email_draft:start:7',
    createdTimestamp: Date.now(),
    deferReply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({ id: 'msg-99' }),
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
    webhook: { editMessage: webhookEditMessage },
    ...overrides,
  } as any;
}

describe('parseFromAddress', () => {
  it('extracts address from "Name <addr>"', () => {
    expect(parseFromAddress('Alice <alice@example.com>')).toBe('alice@example.com');
  });
  it('returns bare address as-is', () => {
    expect(parseFromAddress('alice@example.com')).toBe('alice@example.com');
  });
  it('trims whitespace', () => {
    expect(parseFromAddress('  bob@example.com  ')).toBe('bob@example.com');
  });
  it('picks last angle-bracketed group when display name contains <...>', () => {
    // Hostile From header: attacker stuffs a fake address into the display
    // name. We must reply to the real envelope address, not the spoof.
    expect(
      parseFromAddress('"Bank <fake@evil.com>" <real@bank.com>'),
    ).toBe('real@bank.com');
  });
});

describe('email_draft:start — happy path', () => {
  it('defers, loads row, fetches headers + thread, calls Claude, edits reply with buttons', async () => {
    const deps = makeDeps();
    const ixn = makeButton();
    await routeInteraction(ixn, deps);

    expect(ixn.deferReply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    expect((deps.emailStore as any).findByPendingId).toHaveBeenCalledWith(7);
    expect((deps.imapClient as any).fetchHeaders).toHaveBeenCalledWith(SAMPLE_ACCOUNT, 42);
    expect((deps.threadFetcher as any).fetchThread).toHaveBeenCalledWith(SAMPLE_ACCOUNT, 42);
    expect((deps.anthropic as any).messages.create).toHaveBeenCalledTimes(1);

    expect(ixn.editReply).toHaveBeenCalledTimes(1);
    const editArg = ixn.editReply.mock.calls[0]![0];
    expect(editArg.content).toContain('Yes, shipping Friday.');
    expect(editArg.components).toHaveLength(1);
    const row = editArg.components[0];
    const customIds = row.components.map((c: any) => c.data.custom_id);
    expect(customIds).toEqual([
      expect.stringMatching(/^email_draft:send:/),
      expect.stringMatching(/^email_draft:edit:/),
      expect.stringMatching(/^email_draft:cancel:/),
    ]);
  });

  it('stores draft state with parsed to-address and ordered references', async () => {
    const deps = makeDeps();
    const ixn = makeButton();
    await routeInteraction(ixn, deps);

    // Assert via the final stored state (rather than spying on `put`) so the
    // test is decoupled from how many times the handler writes during start.
    const editArg = ixn.editReply.mock.calls[0]![0];
    const sendCustomId = editArg.components[0].components[0].data.custom_id;
    const pendingId = sendCustomId.replace(/^email_draft:send:/, '');
    const state = deps.draftReplyService!.get(pendingId);
    expect(state).not.toBeNull();
    expect(state!.accountId).toBe('acc-1');
    expect(state!.originalUid).toBe(42);
    expect(state!.to).toBe('alice@example.com');
    expect(state!.subject).toBe('Project status');
    expect(state!.inReplyTo).toBe('<orig@example.com>');
    expect(state!.references).toEqual(['<root@example.com>', '<orig@example.com>']);
    expect(state!.body).toBe('Yes, shipping Friday.');
    expect(state!.pendingId).toBe(pendingId);
  });

  it('blocks @everyone in editReply via allowedMentions', async () => {
    const deps = makeDeps();
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    const editArg = ixn.editReply.mock.calls[0]![0];
    expect(editArg.allowedMentions).toEqual({ parse: [] });
  });

  it('clips long Claude output to fit Discord 2000-char cap', async () => {
    const longBody = 'A'.repeat(3000);
    const deps = makeDeps({
      anthropic: {
        messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: longBody }] }) },
      } as any,
    });
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    const editArg = ixn.editReply.mock.calls[0]![0];
    expect(editArg.content.length).toBeLessThanOrEqual(2000);
    expect(editArg.content.endsWith('…')).toBe(true);
  });

  it('caps stored body to displayed length so Send cannot ship a hidden tail', async () => {
    const longBody = 'A'.repeat(3000);
    const deps = makeDeps({
      anthropic: {
        messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: longBody }] }) },
      } as any,
    });
    const ixn = makeButton();
    await routeInteraction(ixn, deps);

    const editArg = ixn.editReply.mock.calls[0]![0];
    const sendCustomId = editArg.components[0].components[0].data.custom_id;
    const pendingId = sendCustomId.replace(/^email_draft:send:/, '');
    const stored = deps.draftReplyService!.get(pendingId);
    // Stored must be strictly shorter than what Claude produced and must equal
    // the preview text (minus the trailing ellipsis marker the preview adds).
    expect(stored!.body.length).toBeLessThan(longBody.length);
    expect(stored!.body.length).toBeLessThan(2000);
    expect(longBody.startsWith(stored!.body)).toBe(true);
    // What Send would ship == what the user reviewed (preview minus marker).
    const displayedBody = editArg.content.replace(/^✏️ Черновик:\n\n/, '');
    expect(displayedBody.replace(/…$/, '')).toBe(stored!.body);
  });

  it('anonymizes prompt before Claude and deanonymizes the draft body', async () => {
    const anonymize = vi.fn(async (text: string) => ({
      text: text.replace(/Alice/g, '<PERSON:abcd1234>'),
      entities: [{ type: 'PERSON', token: '<PERSON:abcd1234>', original: 'Alice' }],
    }));
    const deanonymize = vi.fn(async (text: string) =>
      text.replace(/<PERSON:abcd1234>/g, 'Alice'),
    );
    const deps = makeDeps({
      piiProxy: { anonymize, deanonymize } as any,
      anthropic: {
        messages: {
          create: vi
            .fn()
            .mockResolvedValue({ content: [{ type: 'text', text: 'Hi <PERSON:abcd1234>, ok' }] }),
        },
      } as any,
    });
    const ixn = makeButton();
    await routeInteraction(ixn, deps);

    expect(anonymize).toHaveBeenCalled();
    const promptArg = (deps.anthropic as any).messages.create.mock.calls[0][0].messages[0].content;
    expect(promptArg).not.toContain('Alice');
    expect(promptArg).toContain('<PERSON:abcd1234>');

    expect(deanonymize).toHaveBeenCalledWith('Hi <PERSON:abcd1234>, ok');
    const editArg = ixn.editReply.mock.calls[0]![0];
    expect(editArg.content).toContain('Hi Alice, ok');
  });
});

describe('email_draft:start — error paths', () => {
  it('invalid rowId → ephemeral reply, no defer', async () => {
    const deps = makeDeps();
    const ixn = makeButton({ customId: 'email_draft:start:not-a-number' });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('Некорректная'),
      }),
    );
    expect(ixn.deferReply).not.toHaveBeenCalled();
  });

  it('row not found → editReply "пропало", no Claude call', async () => {
    const deps = makeDeps({
      emailStore: { findByPendingId: vi.fn().mockReturnValue(null) } as unknown as EmailStore,
    });
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('пропало') }),
    );
    expect((deps.anthropic as any).messages.create).not.toHaveBeenCalled();
  });

  it('account missing → editReply with account error, no IMAP call', async () => {
    const deps = makeDeps({ imapAccounts: new Map() });
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('acc-1') }),
    );
    expect((deps.imapClient as any).fetchHeaders).not.toHaveBeenCalled();
  });

  it('thread fetch fails → editReply with error, no Claude call', async () => {
    const deps = makeDeps({
      threadFetcher: { fetchThread: vi.fn().mockRejectedValue(new Error('imap down')) },
    });
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('загрузить тред'),
      }),
    );
    expect((deps.anthropic as any).messages.create).not.toHaveBeenCalled();
  });

  it('Claude returns empty → editReply "не удалось сгенерировать"', async () => {
    const deps = makeDeps({
      anthropic: {
        messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '' }] }) },
      } as any,
    });
    const putSpy = vi.spyOn(deps.draftReplyService!, 'put');
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('сгенерировать') }),
    );
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('PII anonymize throws → editReply with PII proxy error (no hung "thinking…")', async () => {
    const anonymize = vi.fn().mockRejectedValue(new Error('presidio down'));
    const deanonymize = vi.fn();
    const deps = makeDeps({
      piiProxy: { anonymize, deanonymize } as any,
    });
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('PII proxy') }),
    );
    expect((deps.anthropic as any).messages.create).not.toHaveBeenCalled();
  });

  it('PII deanonymize throws → editReply with PII proxy error', async () => {
    const anonymize = vi.fn(async (t: string) => ({ text: t, entities: [] }));
    const deanonymize = vi.fn().mockRejectedValue(new Error('presidio down'));
    const deps = makeDeps({
      piiProxy: { anonymize, deanonymize } as any,
    });
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    const editArg = ixn.editReply.mock.calls[ixn.editReply.mock.calls.length - 1][0];
    expect(editArg.content).toContain('PII proxy');
  });

  it('thread fetch returns ancestors only (no current) → editReply, no Claude call', async () => {
    const deps = makeDeps({
      // Thread missing the current uid (42) — only ancestor 30 present.
      threadFetcher: {
        fetchThread: vi.fn().mockResolvedValue([
          { uid: 30, from: 'Alice', subject: 'Project status', bodyText: 'old', receivedAt: 1 },
        ]),
      },
    });
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('текущее письмо'),
      }),
    );
    expect((deps.anthropic as any).messages.create).not.toHaveBeenCalled();
  });

  it('Claude throws → editReply with error', async () => {
    const deps = makeDeps({
      anthropic: {
        messages: { create: vi.fn().mockRejectedValue(new Error('rate limit')) },
      } as any,
    });
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('rate limit') }),
    );
  });

  it('deps not configured → ephemeral reply, no defer', async () => {
    const deps = makeDeps({ draftReplyService: undefined });
    const ixn = makeButton();
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('not configured'),
      }),
    );
    expect(ixn.deferReply).not.toHaveBeenCalled();
  });

  it('non-whitelisted user is rejected', async () => {
    const deps = makeDeps();
    const ixn = makeButton({ user: { id: 'evil' } });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    expect((deps.emailStore as any).findByPendingId).not.toHaveBeenCalled();
  });
});

describe('email_draft:send', () => {
  it('happy path: defers, calls SMTP with state, drops draft, confirms', async () => {
    const deps = makeDeps();
    deps.draftReplyService!.put(sampleDraftState());
    const dropSpy = vi.spyOn(deps.draftReplyService!, 'drop');
    const ixn = makeButton({ customId: 'email_draft:send:p1' });

    await routeInteraction(ixn, deps);

    expect(ixn.deferUpdate).toHaveBeenCalled();
    expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
    const sendArg = (deps.smtpClient as any).sendReply.mock.calls[0][0];
    expect(sendArg.account).toEqual(SAMPLE_ACCOUNT);
    expect(sendArg.to).toBe('alice@example.com');
    expect(sendArg.subject).toBe('Re: Project status');
    expect(sendArg.body).toBe('Yes, shipping Friday.');
    expect(sendArg.inReplyTo).toBe('<orig@example.com>');
    expect(sendArg.references).toEqual(['<root@example.com>', '<orig@example.com>']);

    expect(dropSpy).toHaveBeenCalledWith('p1');
    expect(ixn.editReply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Отправлено'),
        components: [],
      }),
    );
  });

  it('state missing → editReply "истёк", no SMTP call', async () => {
    const deps = makeDeps();
    const ixn = makeButton({ customId: 'email_draft:send:missing' });

    await routeInteraction(ixn, deps);

    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('истёк'),
        components: [],
      }),
    );
  });

  it('account missing → editReply, no SMTP call, state preserved with buttons for cancel/retry', async () => {
    const deps = makeDeps({ imapAccounts: new Map() });
    deps.draftReplyService!.put(sampleDraftState());
    const ixn = makeButton({ customId: 'email_draft:send:p1' });

    await routeInteraction(ixn, deps);

    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    // State must remain so the user can Cancel cleanly (otherwise the Map
    // entry would leak until process restart). Buttons must remain so the
    // ephemeral message stays actionable.
    expect(deps.draftReplyService!.has('p1')).toBe(true);
    const editArg = ixn.editReply.mock.calls[ixn.editReply.mock.calls.length - 1][0];
    expect(editArg.content).toContain('acc-1');
    expect(editArg.components).toHaveLength(1);
    const customIds = editArg.components[0].components.map((c: any) => c.data.custom_id);
    expect(customIds).toEqual([
      'email_draft:send:p1',
      'email_draft:edit:p1',
      'email_draft:cancel:p1',
    ]);
  });

  it('SMTP rejects → editReply with error, state preserved for retry, buttons kept', async () => {
    const deps = makeDeps({
      smtpClient: { sendReply: vi.fn().mockRejectedValue(new Error('554 reject')) },
    });
    deps.draftReplyService!.put(sampleDraftState());
    const ixn = makeButton({ customId: 'email_draft:send:p1' });

    await routeInteraction(ixn, deps);

    // Implementation drops-then-restores around await to block double-click
    // races; what matters for retry is the final state, not the internal
    // call sequence.
    expect(deps.draftReplyService!.has('p1')).toBe(true);
    const editArg = ixn.editReply.mock.calls[ixn.editReply.mock.calls.length - 1][0];
    expect(editArg.content).toContain('554 reject');
    expect(editArg.components).toHaveLength(1);
    const customIds = editArg.components[0].components.map((c: any) => c.data.custom_id);
    expect(customIds).toEqual([
      'email_draft:send:p1',
      'email_draft:edit:p1',
      'email_draft:cancel:p1',
    ]);
  });

  it('rapid double-click consumes state once → exactly one SMTP send', async () => {
    // sendReply hangs until released so two concurrent clicks both reach the
    // await before either completes — the exact window where a get-then-await
    // pattern races and double-sends.
    let release: () => void = () => {};
    const sendPromise = new Promise<unknown>((res) => {
      release = () => res({ messageId: 'smtp-1' });
    });
    const sendReply = vi.fn().mockReturnValue(sendPromise);
    const deps = makeDeps({ smtpClient: { sendReply } });
    deps.draftReplyService!.put(sampleDraftState());

    const ixn1 = makeButton({ customId: 'email_draft:send:p1' });
    const ixn2 = makeButton({ customId: 'email_draft:send:p1' });

    const p1 = routeInteraction(ixn1, deps);
    const p2 = routeInteraction(ixn2, deps);
    // Yield so both handlers reach the consume-state step before SMTP resolves.
    await new Promise((r) => setImmediate(r));
    release();
    await Promise.all([p1, p2]);

    expect(sendReply).toHaveBeenCalledTimes(1);
    // Second click sees the state already consumed and surfaces "истёк".
    const secondEdit = ixn2.editReply.mock.calls[0]![0];
    expect(secondEdit.content).toContain('истёк');
    // State remains dropped after successful send.
    expect(deps.draftReplyService!.has('p1')).toBe(false);
  });

  it('smtpClient not configured → ephemeral reply, no defer', async () => {
    const deps = makeDeps({ smtpClient: undefined });
    const ixn = makeButton({ customId: 'email_draft:send:p1' });

    await routeInteraction(ixn, deps);

    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('not configured'),
      }),
    );
    expect(ixn.deferUpdate).not.toHaveBeenCalled();
  });
});

describe('email_draft:send — hold zone', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bypass mode (holdSeconds=0): SMTP fires synchronously, records sent, no Cancel-send button', async () => {
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 0,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const ixn = makeButton({ customId: 'email_draft:send:p1' });

    await routeInteraction(ixn, deps);

    expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
    expect(recordLog).toHaveBeenCalledTimes(1);
    expect(recordLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sent',
        draftId: 'p1',
        to: 'alice@example.com',
        subject: 'Re: Project status',
      }),
    );
    const editArg = ixn.editReply.mock.calls[ixn.editReply.mock.calls.length - 1][0];
    expect(editArg.content).toContain('Отправлено');
    expect(editArg.components).toEqual([]);
  });

  it('bypass mode SMTP failure: records error, restores state + buttons', async () => {
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 0,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
      smtpClient: { sendReply: vi.fn().mockRejectedValue(new Error('554 reject')) },
    });
    deps.draftReplyService!.put(sampleDraftState());
    const ixn = makeButton({ customId: 'email_draft:send:p1' });

    await routeInteraction(ixn, deps);

    expect(recordLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'error',
        draftId: 'p1',
        errorMessage: expect.stringContaining('554 reject'),
      }),
    );
    expect(deps.draftReplyService!.has('p1')).toBe(true);
  });

  it('hold path: arms timer, edits to "Will send at HH:MM:SS" + Cancel-send, no SMTP yet', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const ixn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });

    await routeInteraction(ixn, deps);

    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    expect(recordLog).not.toHaveBeenCalled();

    const editArg = ixn.editReply.mock.calls[ixn.editReply.mock.calls.length - 1][0];
    expect(editArg.content).toMatch(/Will send at \d{2}:\d{2}:\d{2}/);
    expect(editArg.components).toHaveLength(1);
    const cancelCustomId = editArg.components[0].components[0].data.custom_id;
    expect(cancelCustomId).toBe('email_draft:cancelSend:p1');

    const state = deps.draftReplyService!.get('p1');
    expect(state!.holdTimer).not.toBeNull();
    expect(state!.holdSendAt).toBe(Date.now() + 30_000);
  });

  it('15-min pre-check: ephemeral lifetime too short → refuse, drop state, no timer, no SMTP', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    // Interaction created 14 min ago → only 1 min of ephemeral life left, less
    // than holdSeconds(30) + 60s buffer.
    const ixn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now() - 14 * 60 * 1000,
    });

    await routeInteraction(ixn, deps);

    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    expect(recordLog).not.toHaveBeenCalled();
    expect(deps.draftReplyService!.has('p1')).toBe(false);
    const editArg = ixn.editReply.mock.calls[ixn.editReply.mock.calls.length - 1][0];
    expect(editArg.content).toContain('истекает');
    expect(editArg.components).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
  });

  it('timer expiry success: SMTP called once, records sent, edits "@original" to "✅ Sent"', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const ixn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });

    await routeInteraction(ixn, deps);
    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
    expect(recordLog).toHaveBeenCalledTimes(1);
    expect(recordLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sent', draftId: 'p1' }),
    );
    expect(ixn.webhook.editMessage).toHaveBeenCalledWith(
      '@original',
      expect.objectContaining({
        content: expect.stringContaining('Sent'),
        components: [],
      }),
    );
    expect(deps.draftReplyService!.has('p1')).toBe(false);
  });

  it('timer expiry SMTP failure: records error, edits "@original" to clamped error string', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
      smtpClient: { sendReply: vi.fn().mockRejectedValue(new Error('554 reject')) },
    });
    deps.draftReplyService!.put(sampleDraftState());
    const ixn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });

    await routeInteraction(ixn, deps);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(recordLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'error',
        draftId: 'p1',
        errorMessage: expect.stringContaining('554 reject'),
      }),
    );
    expect(ixn.webhook.editMessage).toHaveBeenCalledWith(
      '@original',
      expect.objectContaining({
        content: expect.stringContaining('554 reject'),
        components: [],
      }),
    );
    expect(deps.draftReplyService!.has('p1')).toBe(false);
  });

  it('edit-after-expire: webhook.editMessage rejects but SMTP completes + records sent + no thrown error', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const failingEdit = vi.fn().mockRejectedValue(new Error('Unknown Webhook'));
    const ixn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
      webhook: { editMessage: failingEdit },
    });

    await routeInteraction(ixn, deps);
    // advanceTimersByTimeAsync awaits the timer-fired promise chain; this would
    // reject if executeQueuedSend let the edit error escape.
    await vi.advanceTimersByTimeAsync(30_000);

    expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
    expect(recordLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sent', draftId: 'p1' }),
    );
    expect(failingEdit).toHaveBeenCalled();
    expect(deps.draftReplyService!.has('p1')).toBe(false);
  });

  it('missing state on Send (hold mode) → "истёк" path preserved, no timer armed', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    const ixn = makeButton({
      customId: 'email_draft:send:missing',
      createdTimestamp: Date.now(),
    });

    await routeInteraction(ixn, deps);

    const editArg = ixn.editReply.mock.calls[ixn.editReply.mock.calls.length - 1][0];
    expect(editArg.content).toContain('истёк');
    expect(editArg.components).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    expect(recordLog).not.toHaveBeenCalled();
  });

  it('initial editReply rejects → hold disarmed, state dropped, SMTP never fires', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const failingEditReply = vi.fn().mockRejectedValue(new Error('Unknown interaction'));
    const ixn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
      editReply: failingEditReply,
    });

    // Handler rethrows the editReply error so the bot logger can pick it up;
    // we just need to make sure the queued send is rolled back before that.
    await expect(routeInteraction(ixn, deps)).rejects.toThrow('Unknown interaction');

    expect(deps.draftReplyService!.has('p1')).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    expect(recordLog).not.toHaveBeenCalled();
  });

  // Codex race: timer was being armed before `await editReply` — if Discord
  // API stalled past holdSeconds, the timer would fire while the Cancel-send
  // UI was still not visible, silently sending an email the user had no
  // chance to abort. Fix arms the timer only after editReply resolves.
  it('slow editReply past hold deadline → SMTP does not fire until Cancel UI is confirmed', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn();
    let releaseEdit!: () => void;
    const editGate = new Promise<void>((resolve) => {
      releaseEdit = resolve;
    });
    const slowEditReply = vi.fn().mockReturnValue(editGate);
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const ixn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
      editReply: slowEditReply,
    });

    const sendPromise = routeInteraction(ixn, deps);

    // Advance well past the labelled deadline while editReply is still pending.
    await vi.advanceTimersByTimeAsync(60_000);

    // Timer must NOT have armed yet — SMTP and audit log are untouched.
    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    expect(recordLog).not.toHaveBeenCalled();
    // No hold timer in state — armHold hasn't run yet.
    expect(deps.draftReplyService!.get('p1')?.holdTimer ?? null).toBeNull();

    releaseEdit();
    await sendPromise;

    // editReply resolved → timer armed with remaining=0 → fires on next tick.
    await vi.advanceTimersByTimeAsync(0);
    expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
    expect(recordLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sent', draftId: 'p1' }),
    );
  });

  // Defensive branch: account is removed between Send click and timer fire
  // (e.g. config reload, account disabled). The ephemeral is still showing
  // "Will send at …" + Cancel-send — surface the failure so the user isn't
  // lied to by stale UI, and log the error so it's observable in the audit.
  it('executeQueuedSend account-missing → records error + edits ephemeral to account warning', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn();
    const imapAccounts = new Map<string, ImapAccount>([['acc-1', SAMPLE_ACCOUNT]]);
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
      imapAccounts,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const ixn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });

    await routeInteraction(ixn, deps);
    // Simulate account being removed between Send-time pre-check and timer fire.
    imapAccounts.delete('acc-1');

    await vi.advanceTimersByTimeAsync(30_000);

    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    expect(recordLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'error',
        draftId: 'p1',
        errorMessage: expect.stringContaining('acc-1 missing'),
      }),
    );
    expect(ixn.webhook.editMessage).toHaveBeenCalledWith(
      '@original',
      expect.objectContaining({
        content: expect.stringContaining('acc-1'),
        components: [],
      }),
    );
  });

  it('emailSentLog.record throws on success path → ephemeral still edits to "Sent"', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn().mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const ixn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });

    await routeInteraction(ixn, deps);
    await vi.advanceTimersByTimeAsync(30_000);

    expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
    expect(recordLog).toHaveBeenCalledTimes(1);
    expect(ixn.webhook.editMessage).toHaveBeenCalledWith(
      '@original',
      expect.objectContaining({
        content: expect.stringContaining('Sent'),
        components: [],
      }),
    );
  });
});

describe('email_draft:cancel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops state and shows "Отменено"', async () => {
    const deps = makeDeps();
    deps.draftReplyService!.put(sampleDraftState());
    const dropSpy = vi.spyOn(deps.draftReplyService!, 'drop');
    const ixn = makeButton({ customId: 'email_draft:cancel:p1' });

    await routeInteraction(ixn, deps);

    expect(ixn.deferUpdate).toHaveBeenCalled();
    expect(dropSpy).toHaveBeenCalledWith('p1');
    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Отменено'),
        components: [],
      }),
    );
  });

  it('silent on unknown id — no editReply so we never clobber a terminal Send UI', async () => {
    // Stale Cancel click after Send already terminated (or never had state).
    // editReply on this interaction targets the same ephemeral as the Send
    // flow's terminal write — overwriting it would replace "✅ Sent" or an
    // error message with "❌ Отменено".
    const deps = makeDeps();
    const ixn = makeButton({ customId: 'email_draft:cancel:missing' });

    await routeInteraction(ixn, deps);

    expect(ixn.deferUpdate).toHaveBeenCalled();
    expect(ixn.editReply).not.toHaveBeenCalled();
  });

  // Codex race: stale OLD Cancel button click while Send's hold timer is
  // armed. If Cancel awaits deferUpdate before disarming, the timer can
  // fire mid-await: SMTP completes, ephemeral painted "Sent", then Cancel
  // resumes and overwrites with "Отменено". The fix synchronously drops
  // state (which clearTimeouts the timer) before any await, so SMTP never
  // fires and the "Отменено" UI is the user's actual outcome.
  it('slow deferUpdate after Send armed timer → timer cancelled synchronously, SMTP never fires', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const deps = makeDeps({ emailSendHoldSeconds: 30 });
    deps.draftReplyService!.put(sampleDraftState());
    const sendIxn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });
    await routeInteraction(sendIxn, deps);
    expect(deps.draftReplyService!.get('p1')?.holdTimer).toBeTruthy();

    // Stale OLD Cancel click during the hold window with a slow deferUpdate.
    let releaseDefer!: () => void;
    const deferGate = new Promise<void>((resolve) => {
      releaseDefer = resolve;
    });
    const cancelIxn = makeButton({
      customId: 'email_draft:cancel:p1',
      deferUpdate: vi.fn().mockReturnValue(deferGate),
    });
    const cancelPromise = routeInteraction(cancelIxn, deps);
    // Yield so the synchronous drop runs before we advance timers.
    await Promise.resolve();

    // State must already be gone — drop was synchronous.
    expect(deps.draftReplyService!.has('p1')).toBe(false);
    // Advance past the original deadline while deferUpdate is still pending.
    await vi.advanceTimersByTimeAsync(60_000);
    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();

    releaseDefer();
    await cancelPromise;

    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    expect(cancelIxn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Отменено'),
        components: [],
      }),
    );
  });

  // OLD Cancel button click while Send's hold timer is armed must also record
  // a 'cancelled' audit row, otherwise the post-period cancel-rate query
  // undercounts every stale-client cancel that lands on the old button.
  it('OLD Cancel on a hold-armed draft → records cancelled in emailSentLog', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const sendIxn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });
    await routeInteraction(sendIxn, deps);
    expect(deps.draftReplyService!.get('p1')?.holdTimer).toBeTruthy();

    const cancelIxn = makeButton({ customId: 'email_draft:cancel:p1' });
    await routeInteraction(cancelIxn, deps);

    expect(recordLog).toHaveBeenCalledTimes(1);
    expect(recordLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cancelled',
        draftId: 'p1',
        to: 'alice@example.com',
        subject: 'Re: Project status',
      }),
    );
    // Timer was disarmed by drop — SMTP must not fire on advance.
    await vi.advanceTimersByTimeAsync(60_000);
    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
  });

  // OLD Cancel on a plain (never-Send-clicked) draft must NOT log — it's a
  // draft discard, not a send terminal outcome, and logging would skew the
  // cancel-rate metric.
  it('OLD Cancel on a non-Send-armed draft → does NOT record cancelled', async () => {
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const cancelIxn = makeButton({ customId: 'email_draft:cancel:p1' });

    await routeInteraction(cancelIxn, deps);

    expect(recordLog).not.toHaveBeenCalled();
    expect(cancelIxn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Отменено') }),
    );
  });

  // Codex race: stale OLD Cancel during Send's "Will send at…" editReply
  // round-trip. State was dropped synchronously, so armHold is a no-op and
  // SMTP never fires — but Send's in-flight edit can still land at Discord
  // last, leaving the user staring at "Will send at…" + Cancel-send. Send
  // must re-emit "Отменено" after detecting the drop so the terminal UI
  // matches reality.
  it('Cancel during Send editReply → Send re-emits "Отменено", no timer armed', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const deps = makeDeps({ emailSendHoldSeconds: 30 });
    deps.draftReplyService!.put(sampleDraftState());

    let releaseEdit!: () => void;
    const editGate = new Promise<void>((resolve) => {
      releaseEdit = resolve;
    });
    const slowEditReply = vi.fn().mockReturnValue(editGate);
    const sendIxn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
      editReply: slowEditReply,
    });
    const sendPromise = routeInteraction(sendIxn, deps);
    // Yield so Send reaches its in-flight editReply before Cancel fires.
    await Promise.resolve();
    await Promise.resolve();

    const cancelIxn = makeButton({ customId: 'email_draft:cancel:p1' });
    await routeInteraction(cancelIxn, deps);
    expect(deps.draftReplyService!.has('p1')).toBe(false);

    releaseEdit();
    await sendPromise;

    // Send must have re-edited to "Отменено" after detecting the drop, and
    // never armed a timer. Advancing past the deadline must not fire SMTP.
    await vi.advanceTimersByTimeAsync(60_000);
    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    expect(slowEditReply).toHaveBeenCalledTimes(2);
    const lastEdit = slowEditReply.mock.calls.at(-1)![0];
    expect(lastEdit.content).toContain('Отменено');
    expect(lastEdit.components).toEqual([]);
  });

  // Codex race: stale OLD Cancel during Send's deferUpdate round-trip — the
  // earlier window than the editReply-stage race covered above. Cancel drops
  // state synchronously and writes "Отменено"; Send resumes, finds null
  // state, and previously would clobber with "Черновик истёк". Send must
  // re-emit "Отменено" in this branch too.
  it('Cancel during Send deferUpdate → Send re-emits "Отменено", not "истёк"', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const deps = makeDeps({ emailSendHoldSeconds: 30 });
    deps.draftReplyService!.put(sampleDraftState());

    let releaseDefer!: () => void;
    const deferGate = new Promise<void>((resolve) => {
      releaseDefer = resolve;
    });
    const sendIxn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
      deferUpdate: vi.fn().mockReturnValue(deferGate),
    });
    const sendPromise = routeInteraction(sendIxn, deps);
    // Yield so Send claims the holdPending lock synchronously and parks at
    // its deferUpdate await.
    await Promise.resolve();

    const cancelIxn = makeButton({ customId: 'email_draft:cancel:p1' });
    await routeInteraction(cancelIxn, deps);
    expect(deps.draftReplyService!.has('p1')).toBe(false);

    releaseDefer();
    await sendPromise;

    // Send must re-emit "Отменено" — never "Черновик истёк" — and arm no timer.
    await vi.advanceTimersByTimeAsync(60_000);
    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    const lastEdit = sendIxn.editReply.mock.calls.at(-1)![0];
    expect(lastEdit.content).toContain('Отменено');
    expect(lastEdit.content).not.toContain('истёк');
    expect(lastEdit.components).toEqual([]);
  });

  // Codex race: stale OLD Cancel after Send's bypass-branch SMTP has already
  // completed and painted "Отправлено". Cancel must not overwrite it.
  it('Cancel after bypass Send completed → no editReply, "Отправлено" UI preserved', async () => {
    const deps = makeDeps({ emailSendHoldSeconds: 0 });
    deps.draftReplyService!.put(sampleDraftState());
    const sendIxn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });
    await routeInteraction(sendIxn, deps);
    expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
    expect(deps.draftReplyService!.has('p1')).toBe(false);

    // Stale OLD Cancel click after Send terminated.
    const cancelIxn = makeButton({ customId: 'email_draft:cancel:p1' });
    await routeInteraction(cancelIxn, deps);

    expect(cancelIxn.deferUpdate).toHaveBeenCalled();
    expect(cancelIxn.editReply).not.toHaveBeenCalled();
  });
});

describe('email_draft:cancelSend', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the timer — SMTP never called even after long advance', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const sendIxn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });
    await routeInteraction(sendIxn, deps);

    const cancelIxn = makeButton({ customId: 'email_draft:cancelSend:p1' });
    await routeInteraction(cancelIxn, deps);

    await vi.advanceTimersByTimeAsync(60_000);
    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
  });

  it('records cancelled in emailSentLog with draft fields', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const sendIxn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });
    await routeInteraction(sendIxn, deps);

    const cancelIxn = makeButton({ customId: 'email_draft:cancelSend:p1' });
    await routeInteraction(cancelIxn, deps);

    expect(recordLog).toHaveBeenCalledTimes(1);
    expect(recordLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cancelled',
        draftId: 'p1',
        to: 'alice@example.com',
        subject: 'Re: Project status',
      }),
    );
  });

  it('edits ephemeral to "Cancelled" with no buttons + drops state', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const sendIxn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });
    await routeInteraction(sendIxn, deps);

    const cancelIxn = makeButton({ customId: 'email_draft:cancelSend:p1' });
    await routeInteraction(cancelIxn, deps);

    expect(cancelIxn.deferUpdate).toHaveBeenCalled();
    const editArg = cancelIxn.editReply.mock.calls[cancelIxn.editReply.mock.calls.length - 1][0];
    expect(editArg.content).toContain('Cancelled');
    expect(editArg.components).toEqual([]);
    expect(deps.draftReplyService!.has('p1')).toBe(false);
  });

  it('Cancel after timer already fired → "Слишком поздно", no extra record call', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const sendIxn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });
    await routeInteraction(sendIxn, deps);
    await vi.advanceTimersByTimeAsync(30_000);
    // Timer fired: SMTP completed and one 'sent' row recorded.
    expect(recordLog).toHaveBeenCalledTimes(1);
    expect(recordLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sent' }),
    );

    const cancelIxn = makeButton({ customId: 'email_draft:cancelSend:p1' });
    await routeInteraction(cancelIxn, deps);

    const editArg = cancelIxn.editReply.mock.calls[cancelIxn.editReply.mock.calls.length - 1][0];
    expect(editArg.content).toContain('Слишком поздно');
    expect(editArg.components).toEqual([]);
    // No 'cancelled' record added; only the original 'sent' remains.
    expect(recordLog).toHaveBeenCalledTimes(1);
  });

  it('Cancel with missing state → "Слишком поздно"', async () => {
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    const cancelIxn = makeButton({ customId: 'email_draft:cancelSend:nope' });

    await routeInteraction(cancelIxn, deps);

    expect(cancelIxn.deferUpdate).toHaveBeenCalled();
    const editArg = cancelIxn.editReply.mock.calls[cancelIxn.editReply.mock.calls.length - 1][0];
    expect(editArg.content).toContain('Слишком поздно');
    expect(editArg.components).toEqual([]);
    expect(recordLog).not.toHaveBeenCalled();
  });

  it('emailSentLog.record throws on cancel → ephemeral still edits to "Cancelled"', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let recordCalls = 0;
    const recordLog = vi.fn().mockImplementation(() => {
      recordCalls++;
      // Only blow up on the 'cancelled' write; let any prior calls succeed.
      throw new Error('SQLITE_BUSY');
    });
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const sendIxn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });
    await routeInteraction(sendIxn, deps);

    const cancelIxn = makeButton({ customId: 'email_draft:cancelSend:p1' });
    await routeInteraction(cancelIxn, deps);

    expect(recordCalls).toBeGreaterThan(0);
    const editArg = cancelIxn.editReply.mock.calls[cancelIxn.editReply.mock.calls.length - 1][0];
    expect(editArg.content).toContain('Cancelled');
    expect(editArg.components).toEqual([]);
    expect(deps.draftReplyService!.has('p1')).toBe(false);
  });

  // Codex race: user clicks Cancel before deadline but Discord API is slow,
  // so `await deferUpdate` yields long enough for the hold timer to fire mid-await.
  // The fix is to disarm the timer synchronously before any await — verify
  // that even with a deferUpdate that doesn't resolve until well past the
  // deadline, SMTP never fires and the cancel succeeds.
  it('slow deferUpdate past deadline → timer never fires + cancel still records "cancelled"', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const sendIxn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });
    await routeInteraction(sendIxn, deps);

    // Click Cancel 1s before the deadline. Mock deferUpdate so it stays
    // pending; if the handler doesn't disarm synchronously, the queued
    // setTimeout will fire during the await and start SMTP.
    await vi.advanceTimersByTimeAsync(29_000);
    let releaseDefer!: () => void;
    const deferGate = new Promise<void>((resolve) => {
      releaseDefer = resolve;
    });
    const cancelIxn = makeButton({
      customId: 'email_draft:cancelSend:p1',
      createdTimestamp: Date.now(),
      deferUpdate: vi.fn().mockReturnValue(deferGate),
    });
    const cancelPromise = routeInteraction(cancelIxn, deps);

    // Advance past the original deadline while deferUpdate is still pending.
    await vi.advanceTimersByTimeAsync(5_000);
    // Synchronous disarm must have already cleared the timer.
    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    expect(deps.draftReplyService!.has('p1')).toBe(false);

    releaseDefer();
    await cancelPromise;

    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    expect(recordLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cancelled', draftId: 'p1' }),
    );
    const editArg = cancelIxn.editReply.mock.calls[cancelIxn.editReply.mock.calls.length - 1][0];
    expect(editArg.content).toContain('Cancelled');
  });

  // Late click: user clicked after the wall-clock deadline (per Discord's
  // createdTimestamp). Even if our setTimeout hasn't drained from the event
  // loop yet, surface "too late" rather than allowing a cancel of a send
  // the user clearly didn't abort in time.
  it('click after deadline (createdTimestamp >= holdSendAt) → "Слишком поздно", no record', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const recordLog = vi.fn();
    const deps = makeDeps({
      emailSendHoldSeconds: 30,
      emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
    });
    deps.draftReplyService!.put(sampleDraftState());
    const sendIxn = makeButton({
      customId: 'email_draft:send:p1',
      createdTimestamp: Date.now(),
    });
    await routeInteraction(sendIxn, deps);
    const stored = deps.draftReplyService!.get('p1');
    const sendAt = stored!.holdSendAt!;

    // Forge a Cancel click whose Discord timestamp is one second past the
    // deadline. State still has an armed timer (timer hasn't fired yet
    // under fake timers since we haven't advanced).
    const cancelIxn = makeButton({
      customId: 'email_draft:cancelSend:p1',
      createdTimestamp: sendAt + 1_000,
    });
    await routeInteraction(cancelIxn, deps);

    const editArg = cancelIxn.editReply.mock.calls[cancelIxn.editReply.mock.calls.length - 1][0];
    expect(editArg.content).toContain('Слишком поздно');
    expect(recordLog).not.toHaveBeenCalled();
    // Timer must remain armed so the original send still goes through.
    expect(deps.draftReplyService!.get('p1')?.holdTimer).not.toBeNull();

    await vi.advanceTimersByTimeAsync(30_000);
    expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
  });
});

describe('email_draft:edit', () => {
  it('shows modal prefilled with current body', async () => {
    const deps = makeDeps();
    deps.draftReplyService!.put(sampleDraftState({ body: 'previous body' }));
    const ixn = makeButton({ customId: 'email_draft:edit:p1' });

    await routeInteraction(ixn, deps);

    expect(ixn.showModal).toHaveBeenCalledTimes(1);
    const modal = ixn.showModal.mock.calls[0][0];
    expect(modal.data.custom_id).toBe('email_draft_modal:p1');
    const inputData = modal.components[0].components[0].data;
    expect(inputData.custom_id).toBe('body');
    expect(inputData.value).toBe('previous body');
  });

  it('state missing → ephemeral "истёк", no modal', async () => {
    const deps = makeDeps();
    const ixn = makeButton({ customId: 'email_draft:edit:missing' });

    await routeInteraction(ixn, deps);

    expect(ixn.showModal).not.toHaveBeenCalled();
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('истёк'),
      }),
    );
  });

  it('clamps initial value to 4000 chars', async () => {
    const longBody = 'x'.repeat(5000);
    const deps = makeDeps();
    deps.draftReplyService!.put(sampleDraftState({ body: longBody }));
    const ixn = makeButton({ customId: 'email_draft:edit:p1' });

    await routeInteraction(ixn, deps);

    const modal = ixn.showModal.mock.calls[0][0];
    const inputData = modal.components[0].components[0].data;
    expect(inputData.value.length).toBe(4000);
  });
});

describe('email_draft_modal submit', () => {
  it('updates state body and edits original message via update()', async () => {
    const deps = makeDeps();
    deps.draftReplyService!.put(sampleDraftState({ body: 'old body' }));
    const ixn = makeModalSubmit();

    await routeInteraction(ixn, deps);

    expect(ixn.update).toHaveBeenCalledTimes(1);
    const updateArg = ixn.update.mock.calls[0][0];
    expect(updateArg.content).toContain('edited body');
    expect(updateArg.components).toHaveLength(1);
    const customIds = updateArg.components[0].components.map((c: any) => c.data.custom_id);
    expect(customIds).toEqual([
      'email_draft:send:p1',
      'email_draft:edit:p1',
      'email_draft:cancel:p1',
    ]);

    const stored = deps.draftReplyService!.get('p1');
    expect(stored?.body).toBe('edited body');
    // Other fields preserved.
    expect(stored?.to).toBe('alice@example.com');
    expect(stored?.references).toEqual(['<root@example.com>', '<orig@example.com>']);
  });

  it('state missing → ephemeral "истёк", no update', async () => {
    const deps = makeDeps();
    const ixn = makeModalSubmit({ customId: 'email_draft_modal:missing' });

    await routeInteraction(ixn, deps);

    expect(ixn.update).not.toHaveBeenCalled();
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('истёк'),
      }),
    );
  });

  it('non-whitelisted user is rejected', async () => {
    const deps = makeDeps();
    deps.draftReplyService!.put(sampleDraftState());
    const ixn = makeModalSubmit({ user: { id: 'evil' } });

    await routeInteraction(ixn, deps);

    expect(ixn.update).not.toHaveBeenCalled();
    // The non-whitelist branch uses ixn.reply for the rejection notice.
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });

  it('hold timer armed → modal submit refused, state body unchanged, timer still fires original body', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const recordLog = vi.fn();
      const deps = makeDeps({
        emailSendHoldSeconds: 30,
        emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
      });
      deps.draftReplyService!.put(sampleDraftState({ body: 'original reviewed body' }));
      const sendIxn = makeButton({
        customId: 'email_draft:send:p1',
        createdTimestamp: Date.now(),
      });
      await routeInteraction(sendIxn, deps);
      // Hold armed and body still matches what the user reviewed.
      expect(deps.draftReplyService!.get('p1')?.holdTimer).not.toBeNull();
      expect(deps.draftReplyService!.get('p1')?.body).toBe('original reviewed body');

      // User submits a previously-opened Edit modal after Send already queued.
      const modalIxn = makeModalSubmit({
        fields: { getTextInputValue: vi.fn().mockReturnValue('hostile post-send edit') },
      });
      await routeInteraction(modalIxn, deps);

      expect(modalIxn.update).not.toHaveBeenCalled();
      expect(modalIxn.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          flags: MessageFlags.Ephemeral,
          content: expect.stringContaining('Send уже запущен'),
        }),
      );
      // Body must still be what the user reviewed before clicking Send.
      expect(deps.draftReplyService!.get('p1')?.body).toBe('original reviewed body');

      await vi.advanceTimersByTimeAsync(30_000);
      // SMTP fired the reviewed body, not the post-send edit.
      expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
      expect((deps.smtpClient as any).sendReply).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'original reviewed body' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex race: timer fired but SMTP still awaiting. Without dropping the
  // draft before the SMTP await, a stale Edit modal could submit during the
  // in-flight window (holdTimer null but state present), mutate the body, and
  // restore Send/Edit/Cancel — allowing a duplicate send.
  it('SMTP in-flight after timer → stale modal submit refused, no duplicate send possible', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      let resolveSmtp!: () => void;
      const smtpGate = new Promise<{ messageId: string }>((resolve) => {
        resolveSmtp = () => resolve({ messageId: 'smtp-1' });
      });
      const recordLog = vi.fn();
      const deps = makeDeps({
        emailSendHoldSeconds: 30,
        emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
        smtpClient: { sendReply: vi.fn().mockReturnValue(smtpGate) },
      });
      deps.draftReplyService!.put(sampleDraftState({ body: 'original reviewed body' }));
      const sendIxn = makeButton({
        customId: 'email_draft:send:p1',
        createdTimestamp: Date.now(),
      });
      await routeInteraction(sendIxn, deps);

      // Fire the hold timer. SMTP starts but the gate keeps it pending.
      await vi.advanceTimersByTimeAsync(30_000);
      expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
      // Draft must already be gone from the map — modal/Send/Cancel below
      // all rely on `get` returning null to refuse.
      expect(deps.draftReplyService!.has('p1')).toBe(false);

      // Stale Edit modal (opened pre-Send) submits during the SMTP await.
      const modalIxn = makeModalSubmit({
        fields: { getTextInputValue: vi.fn().mockReturnValue('hostile in-flight edit') },
      });
      await routeInteraction(modalIxn, deps);
      expect(modalIxn.update).not.toHaveBeenCalled();
      expect(modalIxn.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          flags: MessageFlags.Ephemeral,
          content: expect.stringContaining('истёк'),
        }),
      );

      // A second Send click during the in-flight window must not enqueue
      // another SMTP — state is gone, so it falls through to the "истёк" reply.
      const secondSend = makeButton({
        customId: 'email_draft:send:p1',
        createdTimestamp: Date.now(),
      });
      await routeInteraction(secondSend, deps);
      expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
      const secondEditArg = secondSend.editReply.mock.calls[secondSend.editReply.mock.calls.length - 1][0];
      expect(secondEditArg.content).toContain('истёк');

      // Release SMTP and let the success tail run.
      resolveSmtp();
      await vi.advanceTimersByTimeAsync(0);
      expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
      expect((deps.smtpClient as any).sendReply).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'original reviewed body' }),
      );
      expect(recordLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'sent', draftId: 'p1' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex race: BEFORE holdPending is set, Send awaits deferUpdate — a ~100ms
  // Discord round-trip. A stale Edit modal (opened pre-Send in a parallel
  // client) that submits during this window passes both guards (holdTimer
  // null, holdPending null), rewrites the body, and Send resumes to queue
  // the mutated body. The fix: claim holdPending SYNCHRONOUSLY before the
  // first await so the modal handler refuses.
  it('deferUpdate in-flight before any state read → stale modal submit refused, reviewed body wins', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      let resolveDeferUpdate!: () => void;
      const deferUpdateGate = new Promise<void>((resolve) => {
        resolveDeferUpdate = () => resolve();
      });
      const recordLog = vi.fn();
      const deps = makeDeps({
        emailSendHoldSeconds: 30,
        emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
      });
      deps.draftReplyService!.put(sampleDraftState({ body: 'original reviewed body' }));
      const sendIxn = makeButton({
        customId: 'email_draft:send:p1',
        createdTimestamp: Date.now(),
        // deferUpdate hangs until we manually resolve it — simulates the
        // Discord ack round-trip during which a modal can submit.
        deferUpdate: vi.fn().mockReturnValue(deferUpdateGate),
      });
      // Drive the Send handler without awaiting completion: the await on
      // deferUpdate will park inside it until we resolve the gate.
      const sendPromise = routeInteraction(sendIxn, deps);
      // Yield once so the synchronous lock acquisition runs before we
      // inject the modal submit.
      await Promise.resolve();

      // Send must have claimed the lock BEFORE awaiting deferUpdate.
      expect(deps.draftReplyService!.get('p1')?.holdPending).toBe(true);
      expect(deps.draftReplyService!.get('p1')?.holdTimer ?? null).toBeNull();

      // Stale Edit modal (opened pre-Send) submits during the deferUpdate
      // window — must be refused.
      const modalIxn = makeModalSubmit({
        fields: { getTextInputValue: vi.fn().mockReturnValue('hostile pre-defer edit') },
      });
      await routeInteraction(modalIxn, deps);
      expect(modalIxn.update).not.toHaveBeenCalled();
      expect(modalIxn.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          flags: MessageFlags.Ephemeral,
          content: expect.stringContaining('Send уже запущен'),
        }),
      );
      // Body untouched.
      expect(deps.draftReplyService!.get('p1')?.body).toBe('original reviewed body');

      // Release deferUpdate so Send finishes arming the timer.
      resolveDeferUpdate();
      await sendPromise;
      expect(deps.draftReplyService!.get('p1')?.holdTimer).not.toBeNull();

      // Fire the timer — SMTP must ship the reviewed body, not the hostile edit.
      await vi.advanceTimersByTimeAsync(30_000);
      expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
      expect((deps.smtpClient as any).sendReply).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'original reviewed body' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex race: between Send click and armHold there is an editReply round
  // trip during which holdTimer is still null. Without holdPending, a stale
  // Edit modal that submits in this window passes the holdTimer guard, mutates
  // the body, and then armHold installs the timer against the mutated state —
  // SMTP would ship content the user never reviewed.
  it('editReply in-flight before armHold → stale modal submit refused, reviewed body wins', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      let resolveEditReply!: () => void;
      const editReplyGate = new Promise<{ id: string }>((resolve) => {
        resolveEditReply = () => resolve({ id: 'msg-99' });
      });
      const recordLog = vi.fn();
      const deps = makeDeps({
        emailSendHoldSeconds: 30,
        emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
      });
      deps.draftReplyService!.put(sampleDraftState({ body: 'original reviewed body' }));
      const sendIxn = makeButton({
        customId: 'email_draft:send:p1',
        createdTimestamp: Date.now(),
        // editReply hangs until we manually resolve it — simulates a slow
        // Discord round-trip during which the modal can submit.
        editReply: vi.fn().mockReturnValue(editReplyGate),
      });
      // Drive the Send handler without awaiting completion: the await on
      // editReply will park inside it until we resolve the gate.
      const sendPromise = routeInteraction(sendIxn, deps);
      // Yield once so deferUpdate / put(holdPending) run before we inject the
      // modal submit.
      await Promise.resolve();
      await Promise.resolve();

      // Pre-arm state: holdTimer is null (still mid-editReply) but
      // holdPending must already be set.
      expect(deps.draftReplyService!.get('p1')?.holdTimer ?? null).toBeNull();
      expect(deps.draftReplyService!.get('p1')?.holdPending).toBe(true);

      // Stale Edit modal (opened pre-Send) submits during the editReply window.
      const modalIxn = makeModalSubmit({
        fields: { getTextInputValue: vi.fn().mockReturnValue('hostile pre-arm edit') },
      });
      await routeInteraction(modalIxn, deps);
      expect(modalIxn.update).not.toHaveBeenCalled();
      expect(modalIxn.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          flags: MessageFlags.Ephemeral,
          content: expect.stringContaining('Send уже запущен'),
        }),
      );
      // Body untouched.
      expect(deps.draftReplyService!.get('p1')?.body).toBe('original reviewed body');

      // Release editReply so Send finishes arming the timer.
      resolveEditReply();
      await sendPromise;
      expect(deps.draftReplyService!.get('p1')?.holdTimer).not.toBeNull();

      // Fire the timer — SMTP must ship the reviewed body, not the hostile edit.
      await vi.advanceTimersByTimeAsync(30_000);
      expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
      expect((deps.smtpClient as any).sendReply).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'original reviewed body' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex race: duplicate Send click during the first click's editReply
  // round-trip. Without the holdPending/holdTimer guard at Send entry, the
  // second click runs its own parallel hold flow — its late editReply can
  // overwrite the first click's queued ephemeral (or even an already-shipped
  // "Sent" message) back to a stale "Will send at …" display, and its armHold
  // can replace the in-flight timer.
  it('duplicate Send click while holdPending → second click is a no-op, no parallel arm', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      let resolveEditReply1!: () => void;
      const editReplyGate1 = new Promise<{ id: string }>((resolve) => {
        resolveEditReply1 = () => resolve({ id: 'msg-99' });
      });
      const recordLog = vi.fn();
      const deps = makeDeps({
        emailSendHoldSeconds: 30,
        emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
      });
      deps.draftReplyService!.put(sampleDraftState());

      const ixn1 = makeButton({
        customId: 'email_draft:send:p1',
        createdTimestamp: Date.now(),
        editReply: vi.fn().mockReturnValue(editReplyGate1),
      });
      const ixn2 = makeButton({
        customId: 'email_draft:send:p1',
        createdTimestamp: Date.now(),
      });

      // Start click 1; it parks at the editReply await with holdPending=true.
      const p1 = routeInteraction(ixn1, deps);
      await Promise.resolve();
      await Promise.resolve();
      expect(deps.draftReplyService!.get('p1')?.holdPending).toBe(true);
      expect(deps.draftReplyService!.get('p1')?.holdTimer ?? null).toBeNull();

      // Click 2 arrives during click 1's in-flight editReply. It must defer
      // and bail without calling editReply or arming a parallel timer.
      await routeInteraction(ixn2, deps);
      expect(ixn2.deferUpdate).toHaveBeenCalledTimes(1);
      expect(ixn2.editReply).not.toHaveBeenCalled();

      // Release click 1's editReply so it can arm its timer normally.
      resolveEditReply1();
      await p1;
      expect(deps.draftReplyService!.get('p1')?.holdTimer).not.toBeNull();

      // Fire the timer — exactly one SMTP send, exactly one 'sent' log row.
      await vi.advanceTimersByTimeAsync(30_000);
      expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
      expect(recordLog).toHaveBeenCalledTimes(1);
      expect(recordLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'sent' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // Same guard, post-arm flavour: a stale click that arrives after the hold
  // timer is already armed must also no-op rather than racing armHold.
  it('Send click while holdTimer already armed → no-op, no double-arm', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const recordLog = vi.fn();
      const deps = makeDeps({
        emailSendHoldSeconds: 30,
        emailSentLog: { record: recordLog, countLastDays: vi.fn() } as any,
      });
      deps.draftReplyService!.put(sampleDraftState());

      // First Send arms the timer.
      const ixn1 = makeButton({
        customId: 'email_draft:send:p1',
        createdTimestamp: Date.now(),
      });
      await routeInteraction(ixn1, deps);
      const armedTimer = deps.draftReplyService!.get('p1')?.holdTimer;
      expect(armedTimer).toBeTruthy();

      // Stale Send click arrives after arm. Must be a no-op.
      const ixn2 = makeButton({
        customId: 'email_draft:send:p1',
        createdTimestamp: Date.now(),
      });
      await routeInteraction(ixn2, deps);
      expect(ixn2.editReply).not.toHaveBeenCalled();
      expect(deps.draftReplyService!.get('p1')?.holdTimer).toBe(armedTimer);

      // Fire the original timer — exactly one SMTP send.
      await vi.advanceTimersByTimeAsync(30_000);
      expect((deps.smtpClient as any).sendReply).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
