import { describe, it, expect, vi } from 'vitest';
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
  return {
    isButton: () => true,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    user: { id: 'user-1' },
    customId: 'email_draft:start:7',
    deferReply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({ id: 'msg-99' }),
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
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

  it('account missing → editReply, no SMTP call', async () => {
    const deps = makeDeps({ imapAccounts: new Map() });
    deps.draftReplyService!.put(sampleDraftState());
    const ixn = makeButton({ customId: 'email_draft:send:p1' });

    await routeInteraction(ixn, deps);

    expect((deps.smtpClient as any).sendReply).not.toHaveBeenCalled();
    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('acc-1') }),
    );
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

describe('email_draft:cancel', () => {
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

  it('silent on unknown id', async () => {
    const deps = makeDeps();
    const ixn = makeButton({ customId: 'email_draft:cancel:missing' });

    await routeInteraction(ixn, deps);

    expect(ixn.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Отменено') }),
    );
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
});
