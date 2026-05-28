import type Anthropic from '@anthropic-ai/sdk';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Interaction,
  ModalSubmitInteraction,
} from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { randomUUID } from 'crypto';
import type { ReminderService } from '../../services/reminder-service.js';
import type { PermissionService } from '../../services/permission-service.js';
import type { PlanReviewService } from '../../services/plan-review-service.js';
import type { CommandService } from '../../services/command-service.js';
import type { CognitionService } from '../../cognition/service.js';
import type { MemoryConfirmService } from '../../services/memory-confirm-service.js';
import type {
  DraftReplyService,
  DraftState,
} from '../../services/draft-reply-service.js';
import type { EmailStore } from '../../emails/store.js';
import type { ImapAccount, FullMessage } from '../../emails/types.js';
import type { MessageHeaders } from '../../emails/imap-client.js';
import type { PiiProxy } from '../../pii/proxy.js';
import {
  buildReminderEmbed,
  buildPermissionEmbed,
  buildPermissionsListReply,
} from './embeds.js';

// Discord hard-limits a single reply to 2000 chars; leave a tail for the
// "…N more" marker so a long list degrades gracefully instead of 50035-ing.
const SLASH_REPLY_LIMIT = 1900;

function truncateLines(lines: string[]): string {
  if (lines.length === 0) return '';
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const sep = out.length === 0 ? 0 : 1;
    if (out.length === 0 && line.length + sep > SLASH_REPLY_LIMIT) {
      // Single line longer than the whole budget — slice it so we still return
      // something useful rather than just "…N more".
      const suffix = lines.length > 1 ? `\n…${lines.length - 1} more` : '';
      return line.slice(0, SLASH_REPLY_LIMIT - suffix.length - 1) + '…' + suffix;
    }
    const added = sep + line.length;
    if (used + added > SLASH_REPLY_LIMIT) {
      const remaining = lines.length - i;
      out.push(`…${remaining} more`);
      return out.join('\n');
    }
    out.push(line);
    used += added;
  }
  return out.join('\n');
}

export interface DraftImapClient {
  fetchHeaders(account: ImapAccount, uid: number): Promise<MessageHeaders>;
}

export interface DraftThreadFetcher {
  fetchThread(account: ImapAccount, uid: number): Promise<FullMessage[]>;
}

export interface SmtpClient {
  sendReply(params: {
    account: ImapAccount;
    to: string;
    subject: string;
    body: string;
    inReplyTo: string | null;
    references: string[];
  }): Promise<unknown>;
}

export interface InteractionDeps {
  whitelist: Set<string>;
  reminderService: ReminderService;
  permissionService: PermissionService;
  planReviewService: PlanReviewService;
  commandService: CommandService;
  cognitionService: CognitionService;
  memoryConfirmService?: MemoryConfirmService;
  /**
   * Lookup for the initial value to prefill the modal when the user clicks
   * "Edit & approve". Keyed by callId. The bot.ts handler seeds this when it
   * sends a `tool_memory_confirm` message so the text input can be prefilled
   * (custom_id has a 32-char cap and can't carry the value itself).
   */
  memoryConfirmInitialValues?: Map<string, string>;
  /** Email draft reply flow — pending in-memory state keyed by nanoid. */
  draftReplyService?: DraftReplyService;
  emailStore?: EmailStore;
  imapClient?: DraftImapClient;
  threadFetcher?: DraftThreadFetcher;
  anthropic?: Anthropic;
  /** Lookup by account id used by the urgent email row's account_id. */
  imapAccounts?: Map<string, ImapAccount>;
  smtpClient?: SmtpClient;
  /** PII proxy — anonymizes the email thread before it leaves to Claude, then
   *  deanonymizes Claude's draft so the body sent over SMTP has real names. */
  piiProxy?: PiiProxy;
}

// Parses the description rendered by buildPermissionEmbed —
// "Tool: `<name>`\n<argsSummary>" — back into its original parts so
// we can rebuild the embed without nesting a prior description inside itself.
function parsePermissionDescription(description: string): { toolName: string; argsSummary: string } {
  const match = description.match(/^Tool: `([^`]*)`\n?([\s\S]*)$/);
  if (!match) return { toolName: '', argsSummary: description };
  return { toolName: match[1] ?? '', argsSummary: match[2] ?? '' };
}

export async function routeInteraction(
  interaction: Interaction,
  deps: InteractionDeps,
): Promise<void> {
  if (!deps.whitelist.has(interaction.user.id)) {
    if ('reply' in interaction && typeof (interaction as any).reply === 'function') {
      await (interaction as any).reply({ content: 'Not authorized.', flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (interaction.isButton()) {
    await routeButton(interaction, deps);
    return;
  }

  if (interaction.isModalSubmit()) {
    await routeModalSubmit(interaction, deps);
    return;
  }

  if (interaction.isChatInputCommand()) {
    await routeSlashCommand(interaction, deps);
    return;
  }
}

// Splits a customId of the form `domain:action:rawId` where `rawId` may itself
// contain colons (e.g. a tool name like `tool:v2`). A naive split(':') would
// truncate the id at the third segment and lose the rest.
function splitCustomId(customId: string): {
  domain: string;
  action: string;
  rawId: string | undefined;
} {
  const firstColon = customId.indexOf(':');
  if (firstColon < 0) return { domain: customId, action: '', rawId: undefined };
  const domain = customId.slice(0, firstColon);
  const rest = customId.slice(firstColon + 1);
  const secondColon = rest.indexOf(':');
  if (secondColon < 0) return { domain, action: rest, rawId: undefined };
  return {
    domain,
    action: rest.slice(0, secondColon),
    rawId: rest.slice(secondColon + 1),
  };
}

async function routeButton(
  ixn: ButtonInteraction,
  deps: InteractionDeps,
): Promise<void> {
  const { domain, action, rawId } = splitCustomId(ixn.customId);

  if (domain === 'reminder') {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) return;
    if (action === 'dismiss') {
      const result = deps.reminderService.dismiss(id);
      const state = result.ok ? 'dismissed' : 'missed';
      const currentTitle =
        (ixn as any).message?.embeds?.[0]?.title?.replace(/^⏰\s*/, '') ?? '';
      const { embed } = buildReminderEmbed({ id, text: currentTitle, state });
      await (ixn as any).update({ embeds: [embed], components: [] });
      return;
    }
    if (action === 'snooze') {
      const result = deps.reminderService.snooze(id);
      const state = result.ok ? 'snoozed' : 'missed';
      const currentTitle =
        (ixn as any).message?.embeds?.[0]?.title?.replace(/^⏰\s*/, '') ?? '';
      const { embed } = buildReminderEmbed({ id, text: currentTitle, state });
      await (ixn as any).update({ embeds: [embed], components: [] });
      return;
    }
    return;
  }

  if (domain === 'perm') {
    const callId = rawId ?? '';
    let allowed = false;
    let remember = false;
    let intendedState: 'allowed_once' | 'allowed_always' | 'denied';
    if (action === 'allow_once') { allowed = true; intendedState = 'allowed_once'; }
    else if (action === 'allow_always') { allowed = true; remember = true; intendedState = 'allowed_always'; }
    else if (action === 'deny') { allowed = false; intendedState = 'denied'; }
    else return;
    // Use resolveConfirm's return as the single source of truth for whether
    // the pending entry was actually resolved. A prior hasPending() check
    // would race with timeout/abort clearing the entry between the check
    // and the resolve call, causing the UI to claim success while the
    // backend already moved on.
    const result = deps.permissionService.resolveConfirm(callId, allowed, remember);
    const msgEmbed = (ixn as any).message?.embeds?.[0];
    const { toolName, argsSummary } = parsePermissionDescription(
      msgEmbed?.description ?? '',
    );
    const { embed } = buildPermissionEmbed({
      callId,
      toolName,
      argsSummary,
      state: result.ok ? intendedState : 'expired',
    });
    await (ixn as any).update({ embeds: [embed], components: [] });
    return;
  }

  if (domain === 'plan') {
    const callId = rawId ?? '';
    let approved: boolean;
    if (action === 'approve') approved = true;
    else if (action === 'reject') approved = false;
    else return;
    const result = deps.planReviewService.resolveReview(callId, approved);
    await (ixn as any).update({
      components: [],
      content: result.ok ? (approved ? '✓ approved' : '✗ rejected') : '⚠️ expired',
    });
    return;
  }

  if (domain === 'clear') {
    if (action === 'yes') {
      const r = deps.commandService.clearHistory();
      await (ixn as any).update({
        content: `🗑️ Cleared ${r.deleted} messages.`,
        components: [],
      });
    } else if (action === 'no') {
      await (ixn as any).update({ content: 'Cancelled.', components: [] });
    }
    return;
  }

  if (domain === 'memconfirm') {
    if (!deps.memoryConfirmService) {
      await (ixn as any).reply({
        flags: MessageFlags.Ephemeral,
        content: 'Memory confirm is not configured.',
      });
      return;
    }
    // `edit` packs the field name after the callId: rawId = "<callId>:<field>".
    // approve/deny: rawId = "<callId>".
    const rawIdValue = rawId ?? '';
    if (action === 'approve' || action === 'deny') {
      const approved = action === 'approve';
      const result = deps.memoryConfirmService.resolve(rawIdValue, approved);
      // Clean up the prefill map immediately on approve/deny — otherwise the
      // entry sits around until the request's finally block runs.
      deps.memoryConfirmInitialValues?.delete(rawIdValue);
      const currentContent = (ixn as any).message?.content ?? '';
      const suffix = result.ok
        ? approved
          ? '\n\n✅ Approved'
          : '\n\n❌ Denied'
        : '\n\n⚠️ Expired';
      await (ixn as any).update({ content: currentContent + suffix, components: [] });
      return;
    }
    if (action === 'edit') {
      const sepIdx = rawIdValue.indexOf(':');
      if (sepIdx < 0) return;
      const callId = rawIdValue.slice(0, sepIdx);
      const field = rawIdValue.slice(sepIdx + 1);
      if (!field) return;
      const rawInitial = deps.memoryConfirmInitialValues?.get(callId) ?? '';
      // Discord's TextInputBuilder.setValue throws a RangeError when the prefill
      // exceeds 4000 chars. The tool supplies LLM-emitted params (query for
      // memory_forget, newValue for memory_update) with no length cap, so clamp
      // defensively — otherwise an oversized value silently breaks the Edit
      // button and the user is stuck with only Approve/Deny.
      const initialValue = rawInitial.length > 4000 ? rawInitial.slice(0, 4000) : rawInitial;
      const modal = new ModalBuilder()
        .setCustomId(`memconfirm_modal:${callId}:${field}`)
        .setTitle('Edit parameter');
      const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel(field === 'query' ? 'Query' : 'New value')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(initialValue);
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(input),
      );
      await (ixn as any).showModal(modal);
      return;
    }
    return;
  }

  if (domain === 'email_draft') {
    if (action === 'start') {
      await handleEmailDraftStart(ixn, deps, rawId ?? '');
      return;
    }
    if (action === 'send') {
      await handleEmailDraftSend(ixn, deps, rawId ?? '');
      return;
    }
    if (action === 'edit') {
      await handleEmailDraftEdit(ixn, deps, rawId ?? '');
      return;
    }
    if (action === 'cancel') {
      await handleEmailDraftCancel(ixn, deps, rawId ?? '');
      return;
    }
    return;
  }

  if (domain === 'perm_rule' && action === 'revoke') {
    const toolName = rawId ?? '';
    deps.commandService.revokePermissionRule(toolName);
    const remaining = deps.commandService.listPermissionRules();
    if (remaining.length === 0) {
      await (ixn as any).update({
        content: 'No saved permission rules left.',
        embeds: [],
        components: [],
      });
      return;
    }
    const reply = buildPermissionsListReply(remaining);
    await (ixn as any).update({
      content: reply.content,
      embeds: reply.embeds,
      components: reply.components,
    });
    return;
  }
}

const DRAFT_MAX_TOKENS = 1024;
const DRAFT_BODY_MARKER = '✏️ Черновик:\n\n';
// Discord caps a message at 2000 chars; leave room for the "Черновик:" prefix
// plus the trailing "…" ellipsis when we slice an oversized draft.
const DRAFT_BODY_MAX_DISPLAY = 2000 - DRAFT_BODY_MARKER.length - 1;
// Per-message body cap when serialising the thread into the LLM prompt. Full
// bodies arrive via fetchFullBody (already capped at FULL_BODY_LEN=50_000),
// but a single 50k message × 20-thread cap would blow past 1M tokens; clamp
// each message so a long thread still fits well under the Claude 200k context.
const THREAD_BODY_LIMIT = 8_000;
// Block on outbound mentions — Claude-generated draft bodies are LLM output
// and could contain @everyone / @here / role mentions that would notify the
// recipient when rendered in Discord. Ephemerals do not fire notifications,
// but defense in depth costs nothing.
const NO_MENTIONS = { parse: [] as never[] };
const DRAFT_SYSTEM_PROMPT =
  "You are R2's email draft writer. Compose a concise, natural reply matching the language of the thread. Plain text only. No greeting boilerplate, no signature.";

// Parses an RFC 5322 mailbox of the form `Name <addr@host>` or a bare
// `addr@host` into just the address part. Reply needs the bare address —
// nodemailer accepts the wrapped form too, but `to` should be canonical so
// the SMTP envelope and visible header agree across providers.
// Pick the LAST angle-bracketed group: an attacker-controlled display name
// can contain `<fake@evil.com>` (e.g. `"Bank <fake@evil.com>" <real@bank.com>`)
// and matching the first group would route the reply to the spoof address.
export function parseFromAddress(fromAddr: string): string {
  const matches = fromAddr.match(/<([^>]+)>/g);
  if (matches && matches.length > 0) {
    const last = matches[matches.length - 1]!;
    return last.slice(1, -1).trim();
  }
  return fromAddr.trim();
}

function buildDraftPrompt(thread: FullMessage[], currentUid: number): string {
  const parts: string[] = [];
  for (const msg of thread) {
    const marker = msg.uid === currentUid ? ' ⟵ current' : '';
    const body = (msg.bodyText ?? '').slice(0, THREAD_BODY_LIMIT);
    parts.push(
      `From: ${msg.from}${marker}\nSubject: ${msg.subject}\nBody: ${body}`,
    );
  }
  return (
    'Email thread (oldest first). Draft a reply to the current message.\n\n' +
    parts.join('\n---\n')
  );
}

function extractClaudeText(content: any[]): string {
  if (!Array.isArray(content)) return '';
  const block = content.find((b) => b && b.type === 'text');
  return block && typeof block.text === 'string' ? block.text.trim() : '';
}

function buildDraftActionRow(pendingId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`email_draft:send:${pendingId}`)
      .setLabel('Send')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`email_draft:edit:${pendingId}`)
      .setLabel('Edit')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`email_draft:cancel:${pendingId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
  );
}

async function handleEmailDraftStart(
  ixn: ButtonInteraction,
  deps: InteractionDeps,
  rawId: string,
): Promise<void> {
  if (
    !deps.draftReplyService ||
    !deps.emailStore ||
    !deps.imapClient ||
    !deps.threadFetcher ||
    !deps.anthropic ||
    !deps.imapAccounts
  ) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: 'Draft reply is not configured.',
    });
    return;
  }

  const rowId = Number(rawId);
  if (!Number.isInteger(rowId) || rowId <= 0) {
    // A bare `return` here would leave Discord showing "thinking…" until the
    // 3s ack window expires. Surface the bad customId immediately instead.
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: '⚠️ Некорректная ссылка на письмо',
    });
    return;
  }

  // deferReply gives us 15 minutes to edit a follow-up; the IMAP+Claude path
  // here easily exceeds Discord's 3s initial-ack window.
  await (ixn as any).deferReply({ flags: MessageFlags.Ephemeral });

  const row = deps.emailStore.findByPendingId(rowId);
  if (!row) {
    await (ixn as any).editReply({ content: '⚠️ Письмо пропало' });
    return;
  }

  const account = deps.imapAccounts.get(row.account_id);
  if (!account) {
    await (ixn as any).editReply({
      content: `⚠️ Аккаунт ${row.account_id} не настроен`,
    });
    return;
  }

  let headers: MessageHeaders;
  let thread: FullMessage[];
  try {
    headers = await deps.imapClient.fetchHeaders(account, row.message_uid);
    thread = await deps.threadFetcher.fetchThread(account, row.message_uid);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await (ixn as any).editReply({
      content: `❌ Не удалось загрузить тред: ${msg}`,
    });
    return;
  }

  // thread-fetcher silently degrades to "ancestors only" when fetchFullBody
  // for the current uid throws (network blip, message moved between scoring
  // and click). Without the current message the draft prompt would ask
  // Claude to reply to whatever the last ancestor is — wrong context. Bail.
  if (!thread.some((m) => m.uid === row.message_uid)) {
    await (ixn as any).editReply({
      content: '❌ Не удалось загрузить текущее письмо',
    });
    return;
  }

  const rawPrompt = buildDraftPrompt(thread, row.message_uid);
  // PII proxy is always present at runtime (index.ts always constructs one —
  // either a real proxy or a passthrough). The optional `?` keeps the type
  // surface contained but at runtime we always anonymize → call → deanonymize,
  // mirroring morningBrief.ai.ts. With a passthrough proxy this collapses to
  // a no-op so behaviour is unchanged when PII is disabled.
  let prompt: string;
  try {
    prompt = deps.piiProxy
      ? (await deps.piiProxy.anonymize(rawPrompt)).text
      : rawPrompt;
  } catch (err) {
    // In PII_MODE=required, a Presidio outage throws here. Without a catch
    // the error bubbles past bot.ts's logger and the ephemeral reply hangs
    // on "thinking…" until the 15-min webhook window expires.
    const msg = err instanceof Error ? err.message : String(err);
    await (ixn as any).editReply({
      content: `❌ PII proxy failed: ${msg}`,
    });
    return;
  }
  let body: string;
  try {
    const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
    const msg = await deps.anthropic.messages.create({
      model,
      max_tokens: DRAFT_MAX_TOKENS,
      system: DRAFT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
    body = extractClaudeText(msg.content as any[]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await (ixn as any).editReply({
      content: `❌ Claude не ответил: ${msg}`,
    });
    return;
  }

  if (body && deps.piiProxy) {
    try {
      body = await deps.piiProxy.deanonymize(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await (ixn as any).editReply({
        content: `❌ PII proxy failed: ${msg}`,
      });
      return;
    }
  }

  if (!body) {
    await (ixn as any).editReply({
      content: '❌ Не удалось сгенерировать черновик',
    });
    return;
  }

  const pendingId = randomUUID();
  // References chain: existing refs + parent Message-ID, deduped, nulls dropped.
  // We always reply *to* the current message, so its Message-ID belongs at the
  // tail of References (it's the most recent ancestor of the future reply).
  const refSet = new Set<string>();
  for (const r of headers.references) refSet.add(r);
  if (headers.messageId) refSet.add(headers.messageId);
  // Cap stored body to what the preview will show: Discord clips at 2000
  // chars, but Claude (max_tokens=1024) can emit a longer reply. Send must
  // never ship a hidden tail past the "…" — store only what the user saw.
  // If they want to extend, Edit lets them grow from this base.
  const prepared = prepareDraftBody(body);
  const state: DraftState = {
    pendingId,
    originalUid: row.message_uid,
    accountId: row.account_id,
    to: parseFromAddress(row.from_addr),
    subject: row.subject ?? '',
    inReplyTo: headers.messageId,
    references: Array.from(refSet),
    body: prepared.stored,
  };
  deps.draftReplyService.put(state);

  await (ixn as any).editReply({
    content: DRAFT_BODY_MARKER + prepared.display,
    components: [buildDraftActionRow(pendingId)],
    allowedMentions: NO_MENTIONS,
  });
}

function prepareDraftBody(body: string): { stored: string; display: string } {
  if (body.length <= DRAFT_BODY_MAX_DISPLAY) {
    return { stored: body, display: body };
  }
  // Reserve one char for the ellipsis marker so the display still fits the
  // Discord cap. Stored matches display (minus the marker) so what Send ships
  // equals what the user reviewed in the preview.
  const stored = body.slice(0, DRAFT_BODY_MAX_DISPLAY - 1);
  return { stored, display: stored + '…' };
}

// Display-only clip for modal-submitted bodies. Unlike LLM output, the user
// just authored the text in the 4000-char modal — there's no hidden-tail
// concern, so we keep the full body in state and only clip the preview.
function clipDraftBodyForDisplay(body: string): string {
  return body.length > DRAFT_BODY_MAX_DISPLAY
    ? body.slice(0, DRAFT_BODY_MAX_DISPLAY - 1) + '…'
    : body;
}

async function handleEmailDraftSend(
  ixn: ButtonInteraction,
  deps: InteractionDeps,
  pendingId: string,
): Promise<void> {
  if (!deps.draftReplyService || !deps.imapAccounts || !deps.smtpClient) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: 'Draft reply is not configured.',
    });
    return;
  }
  await (ixn as any).deferUpdate();
  // Consume the draft *before* awaiting SMTP so a rapid double-click can't
  // observe the same pending state twice and send duplicate emails. Restore
  // it on transient failures (no account, SMTP reject) so the user can retry
  // without re-generating the draft.
  const state = deps.draftReplyService.get(pendingId);
  if (!state) {
    await (ixn as any).editReply({
      content: '⚠️ Черновик истёк',
      components: [],
    });
    return;
  }
  deps.draftReplyService.drop(pendingId);
  const account = deps.imapAccounts.get(state.accountId);
  if (!account) {
    deps.draftReplyService.put(state);
    await (ixn as any).editReply({
      content: `⚠️ Аккаунт ${state.accountId} не настроен`,
      components: [],
    });
    return;
  }
  try {
    await deps.smtpClient.sendReply({
      account,
      to: state.to,
      subject: state.subject,
      body: state.body,
      inReplyTo: state.inReplyTo,
      references: state.references,
    });
  } catch (err) {
    // Restore state + buttons so the user can retry without re-generating.
    deps.draftReplyService.put(state);
    const msg = err instanceof Error ? err.message : String(err);
    await (ixn as any).editReply({
      content: `❌ Не отправилось: ${msg}`,
      components: [buildDraftActionRow(pendingId)],
    });
    return;
  }
  await (ixn as any).editReply({
    content: '✅ Отправлено',
    components: [],
  });
}

async function handleEmailDraftCancel(
  ixn: ButtonInteraction,
  deps: InteractionDeps,
  pendingId: string,
): Promise<void> {
  if (!deps.draftReplyService) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: 'Draft reply is not configured.',
    });
    return;
  }
  await (ixn as any).deferUpdate();
  deps.draftReplyService.drop(pendingId);
  await (ixn as any).editReply({
    content: '❌ Отменено',
    components: [],
  });
}

async function handleEmailDraftEdit(
  ixn: ButtonInteraction,
  deps: InteractionDeps,
  pendingId: string,
): Promise<void> {
  if (!deps.draftReplyService) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: 'Draft reply is not configured.',
    });
    return;
  }
  const state = deps.draftReplyService.get(pendingId);
  if (!state) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: '⚠️ Черновик истёк',
    });
    return;
  }
  // Discord modal text input is capped at 4000 chars; clamp defensively so a
  // longer body doesn't make setValue throw and silently break the Edit flow.
  const initial = state.body.length > 4000 ? state.body.slice(0, 4000) : state.body;
  const modal = new ModalBuilder()
    .setCustomId(`email_draft_modal:${pendingId}`)
    .setTitle('Edit draft');
  const input = new TextInputBuilder()
    .setCustomId('body')
    .setLabel('Body')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setValue(initial);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(input),
  );
  await (ixn as any).showModal(modal);
}

async function handleEmailDraftModalSubmit(
  ixn: ModalSubmitInteraction,
  deps: InteractionDeps,
  pendingId: string,
): Promise<void> {
  if (!deps.draftReplyService) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: 'Draft reply is not configured.',
    });
    return;
  }
  const state = deps.draftReplyService.get(pendingId);
  if (!state) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: '⚠️ Черновик истёк',
    });
    return;
  }
  const newBody = ixn.fields.getTextInputValue('body');
  deps.draftReplyService.put({ ...state, body: newBody });
  // ModalSubmitInteraction#update edits the message the originating button
  // was on — for us, that's the ephemeral draft reply. This avoids needing
  // a separate webhook editMessage call against the stored messageId.
  await (ixn as any).update({
    content: DRAFT_BODY_MARKER + clipDraftBodyForDisplay(newBody),
    components: [buildDraftActionRow(pendingId)],
    allowedMentions: NO_MENTIONS,
  });
}

async function routeModalSubmit(
  ixn: ModalSubmitInteraction,
  deps: InteractionDeps,
): Promise<void> {
  const customId = ixn.customId;
  if (customId.startsWith('email_draft_modal:')) {
    await handleEmailDraftModalSubmit(
      ixn,
      deps,
      customId.slice('email_draft_modal:'.length),
    );
    return;
  }
  if (!customId.startsWith('memconfirm_modal:')) return;
  if (!deps.memoryConfirmService) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: 'Memory confirm is not configured.',
    });
    return;
  }
  // Format: memconfirm_modal:<callId>:<field>
  const rest = customId.slice('memconfirm_modal:'.length);
  const sepIdx = rest.indexOf(':');
  if (sepIdx < 0) return;
  const callId = rest.slice(0, sepIdx);
  const field = rest.slice(sepIdx + 1);
  if (!field) return;
  const value = ixn.fields.getTextInputValue('value');
  const result = deps.memoryConfirmService.resolve(callId, true, {
    [field]: value,
  });
  deps.memoryConfirmInitialValues?.delete(callId);
  // Update the original confirm DM so its buttons are cleared and the
  // embed reflects the resolved state. Without this, the original message
  // keeps showing Approve/Edit/Deny buttons even after the modal resolved it.
  const originalMessage = (ixn as any).message;
  if (originalMessage && typeof originalMessage.edit === 'function') {
    const currentContent = originalMessage.content ?? '';
    const suffix = result.ok
      ? `\n\n✅ Approved (edited: ${field}="${value}")`
      : '\n\n⚠️ Expired';
    // Discord caps edited message content at 2000 chars. The user's modal
    // input can be up to 4000 chars, and currentContent is already near the
    // per-message budget, so the naive concatenation can hit the cap. Clip
    // the combined content rather than letting the edit throw and leaving
    // the buttons in place.
    const MESSAGE_MAX = 2000;
    const combined = currentContent + suffix;
    const safe = combined.length > MESSAGE_MAX
      ? combined.slice(0, MESSAGE_MAX - 1) + '…'
      : combined;
    try {
      await originalMessage.edit({ content: safe, components: [] });
    } catch {
      // original message gone or no permission — ignore
    }
  }
  // Discord caps a reply at 2000 chars. The modal text input can hold up to
  // 4000, so a long edited value can blow past the limit and make ixn.reply
  // throw even though the confirm was already resolved. Clamp defensively.
  const REPLY_MAX = 2000;
  const replyRaw = result.ok
    ? `✅ Approved with edit: ${field}="${value}"`
    : '⚠️ Expired';
  const replyContent = replyRaw.length > REPLY_MAX
    ? replyRaw.slice(0, REPLY_MAX - 1) + '…'
    : replyRaw;
  await (ixn as any).reply({
    flags: MessageFlags.Ephemeral,
    content: replyContent,
  });
}

async function routeSlashCommand(
  ixn: ChatInputCommandInteraction,
  deps: InteractionDeps,
): Promise<void> {
  const name = ixn.commandName;
  if (name === 'clear') {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: 'Clear all chat history?',
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 4, label: 'Yes, clear', custom_id: 'clear:yes' },
            { type: 2, style: 2, label: 'No', custom_id: 'clear:no' },
          ],
        },
      ],
    });
    return;
  }
  if (name === 'status') {
    const s = deps.commandService.status();
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content:
        `**Status**\n` +
        `Model: \`${s.model}\`\n` +
        `Uptime: ${s.uptimeSeconds}s\n` +
        `Active reminders: ${s.activeReminders}\n` +
        `Pending permissions: ${s.pendingPermissions}`,
    });
    return;
  }
  if (name === 'reminders') {
    const list = deps.commandService.listReminders();
    const content = list.length === 0
      ? 'No active reminders.'
      : truncateLines(
          list.map((r) => `#${r.id} · ${r.text} · ${new Date(r.next_fire_at_ms).toISOString()}`),
        );
    await (ixn as any).reply({ flags: MessageFlags.Ephemeral, content });
    return;
  }
  if (name === 'permissions') {
    const rules = deps.commandService.listPermissionRules();
    const reply = buildPermissionsListReply(rules);
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: reply.content,
      embeds: reply.embeds,
      components: reply.components,
    });
    return;
  }
  if (name === 'memory') {
    // Memory search runs an Ollama embeddings call which routinely exceeds
    // Discord's 3s interaction-token window on a cold model. Defer first so
    // the subsequent editReply is not rejected as "Unknown interaction".
    await (ixn as any).deferReply({ flags: MessageFlags.Ephemeral });
    const query = (ixn as any).options.getString('query') ?? undefined;
    try {
      const result = await deps.commandService.listMemory(query);
      const content = !result.available
        ? 'Memory not available.'
        : result.entries.length === 0
          ? 'No memory entries.'
          : truncateLines(
              result.entries.map(
                (e) => `- ${e.text}${e.timestamp ? ` (${new Date(e.timestamp).toISOString()})` : ''}`,
              ),
            );
      await (ixn as any).editReply({ content });
    } catch (err) {
      // Without this catch the outer bot.ts handler only logs, leaving the
      // deferred ephemeral reply stuck on "thinking..." until Discord's
      // 15-minute token expires.
      const msg = err instanceof Error ? err.message : String(err);
      await (ixn as any).editReply({ content: `Memory lookup failed: ${msg}` });
    }
    return;
  }
  if (name === 'heartbeat') {
    const sub = (ixn as any).options.getSubcommand();
    if (sub === 'status') {
      const s = deps.cognitionService.status();
      const lines = [
        `**Heartbeat: ${s.paused ? '⏸️ paused' : '🫀 alive'}**`,
        `Last tick: ${s.lastTickAt ? new Date(s.lastTickAt).toISOString() : 'never'}`,
        `Ticks (last 24h): ${s.ticks24h}`,
        `Queue depth: ${s.queueSize}`,
        `Registered handlers: ${s.handlers.length > 0 ? s.handlers.join(', ') : '(none)'}`,
      ];
      if (s.recentRuns.length > 0) {
        lines.push('', 'Recent runs:');
        for (const r of s.recentRuns.slice(0, 10)) {
          const t = new Date(r.firedAt).toISOString().slice(11, 19);
          const note = r.outcome === 'publish' ? r.content : r.reason;
          lines.push(`\`${t}\` ${r.handlerName} — ${r.outcome}${note ? ` (${note.slice(0, 80)})` : ''}`);
        }
      }
      await (ixn as any).reply({
        flags: MessageFlags.Ephemeral,
        content: truncateLines(lines),
      });
      return;
    }
    if (sub === 'pause') {
      deps.cognitionService.pause();
      await (ixn as any).reply({ flags: MessageFlags.Ephemeral, content: '⏸️ Heartbeat paused.' });
      return;
    }
    if (sub === 'resume') {
      deps.cognitionService.resume();
      await (ixn as any).reply({ flags: MessageFlags.Ephemeral, content: '🫀 Heartbeat resumed.' });
      return;
    }
    // Unknown subcommand: Discord otherwise shows "The application did not
    // respond" after 3 seconds because the interaction token is never acked.
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: `Unknown /heartbeat subcommand: \`${sub}\`.`,
    });
  }
}
