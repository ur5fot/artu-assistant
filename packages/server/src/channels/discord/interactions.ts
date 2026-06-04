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
  EmbedBuilder,
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
import type { EmailSentLog } from '../../emails/sent-log.js';
import type { EmailSuppressionStore } from '../../emails/suppression-store.js';
import type { ImapAccount, FullMessage } from '../../emails/types.js';
import type { MessageHeaders } from '../../emails/imap-client.js';
import type { PiiProxy } from '../../pii/proxy.js';
import type { WindowHistoryStore } from '../../observers/window-history-store.js';
import type { DistractionEvalStore } from '../../observers/distraction-eval-store.js';
import type { TopicStore } from '../../topics/store.js';
import { parseFromAddress } from '../../emails/address.js';
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
  /** Set `\Answered` on the original message after a reply ships, so the
   *  implicit-feedback resolver records a `replied` outcome (and clears any
   *  auto-suppression) instead of finalizing the sender as read/ignored.
   *  Optional so call sites without IMAP write wiring stay a no-op. */
  markAnswered?(account: ImapAccount, uid: number): Promise<boolean>;
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
  /** Hold-zone delay (seconds) before SMTP send for draft replies. 0 = bypass. */
  emailSendHoldSeconds?: number;
  /** Mini audit table for send/cancel/error outcomes. */
  emailSentLog?: EmailSentLog;
  /** Sender/subject suppression rules — read by the urgent trigger gate, written by Discord buttons. */
  emailSuppressionStore?: EmailSuppressionStore;
  /** PII proxy — anonymizes the email thread before it leaves to Claude, then
   *  deanonymizes Claude's draft so the body sent over SMTP has real names. */
  piiProxy?: PiiProxy;
  /** Window history — read by the `window:show` button to reveal session titles
   *  as an ephemeral message (privacy-by-default; titles never go in the embed). */
  windowHistoryStore?: WindowHistoryStore;
  /** Distraction evals — written by the `distract:*` pullback buttons
   *  (work → quiets re-eval; snooze → sets a global snooze_until). */
  distractionEvalStore?: DistractionEvalStore;
  /** Snooze window (minutes) applied by the `distract:snooze` button. */
  distractionSnoozeMin?: number;
  /** Topic store — read/written by the `followup:done` button to dismiss a
   *  finalized topic's pending action (the morning-brief "✓ Готово" button). */
  topicStore?: TopicStore | null;
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
    if (action === 'cancelSend') {
      await handleEmailDraftCancelSend(ixn, deps, rawId ?? '');
      return;
    }
    return;
  }

  if (domain === 'email_suppress') {
    if (action === 'sender_start') {
      await handleSuppressSenderStart(ixn, deps, rawId ?? '');
      return;
    }
    if (action === 'sender_set_ttl') {
      await handleSuppressSenderSetTtl(ixn, deps, rawId ?? '');
      return;
    }
    if (action === 'subject_start') {
      await handleSuppressSubjectStart(ixn, deps, rawId ?? '');
      return;
    }
    return;
  }

  if (domain === 'window' && action === 'show') {
    await handleWindowShowTitles(ixn, deps, rawId ?? '');
    return;
  }

  if (domain === 'distract') {
    await handleDistractFeedback(ixn, deps, action, rawId ?? '');
    return;
  }

  if (domain === 'followup' && action === 'done') {
    await handleFollowupDone(ixn, deps, rawId ?? '');
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

// Max session titles to show in the ephemeral detail view, and the per-title
// char cap. Titles can be arbitrarily long window names — clamp both so the
// reply never exceeds Discord's 2000-char body limit.
const WINDOW_TITLES_MAX = 15;
const WINDOW_TITLE_CHAR_MAX = 80;

// Reveals the window titles for an away-session as an ephemeral message (visible
// only to the user). customId rawId is `${app}:${from}:${to}` — the app name may
// itself contain colons, so the two trailing epoch-ms params are parsed off the
// end and everything before them is the app name.
async function handleWindowShowTitles(
  ixn: ButtonInteraction,
  deps: InteractionDeps,
  rawId: string,
): Promise<void> {
  const lastColon = rawId.lastIndexOf(':');
  if (lastColon < 0) return;
  const to = Number(rawId.slice(lastColon + 1));
  const rest = rawId.slice(0, lastColon);
  const secondColon = rest.lastIndexOf(':');
  if (secondColon < 0) return;
  const from = Number(rest.slice(secondColon + 1));
  const app = rest.slice(0, secondColon);
  if (!app || !Number.isInteger(from) || !Number.isInteger(to)) return;

  if (!deps.windowHistoryStore) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: 'Window history is not configured.',
    });
    return;
  }

  const titles = deps.windowHistoryStore.listTitlesInSession(app, from, to);
  if (titles.length === 0) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: `No window titles recorded for ${app}.`,
    });
    return;
  }

  const lines = titles
    .slice(0, WINDOW_TITLES_MAX)
    .map((t) => {
      const title = t.title.replace(/\s+/g, ' ').trim() || '(no title)';
      return `• ${truncate(title, WINDOW_TITLE_CHAR_MAX)}`;
    });
  await (ixn as any).reply({
    flags: MessageFlags.Ephemeral,
    content: `**${app}** windows:\n${lines.join('\n')}`,
  });
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Default snooze window when distractionSnoozeMin is not wired (mirrors the
// spec default and DISTRACTION_SNOOZE_MIN's fallback).
const DEFAULT_DISTRACTION_SNOOZE_MIN = 60;
const MINUTE_MS = 60_000;

// Parses `{app}:{runStart}` where the app may itself contain colons — the
// trailing epoch-ms runStart is sliced off the end and everything before it is
// the app name (same shape as handleWindowShowTitles).
function parseAppDwell(rawId: string): { app: string; runStart: number } | null {
  const lastColon = rawId.lastIndexOf(':');
  if (lastColon < 0) return null;
  const runStart = Number(rawId.slice(lastColon + 1));
  const app = rawId.slice(0, lastColon);
  // runStart is an epoch-ms timestamp; reject 0 (which Number('') yields for a
  // trailing-empty id) and negatives so a malformed customId can't slip
  // through the integer check.
  if (!app || !Number.isInteger(runStart) || runStart <= 0) return null;
  return { app, runStart };
}

// Handles the three pullback-nudge buttons. `back` is a pure ack (no DB write);
// `work` marks the dwell as work so the filter stops re-evaluating it; `snooze`
// writes a global snooze_until that mutes all pings for DISTRACTION_SNOOZE_MIN.
// The reply is ephemeral (mirrors window:show) so the original nudge stays
// visible in the DM. Writes are no-ops if the eval row is missing (e.g. the
// store was not wired) — the user still gets an acknowledgement.
async function handleDistractFeedback(
  ixn: ButtonInteraction,
  deps: InteractionDeps,
  action: string,
  rawId: string,
): Promise<void> {
  if (action === 'back') {
    await (ixn as any).reply({ flags: MessageFlags.Ephemeral, content: '👍 Возвращаюсь' });
    return;
  }

  const parsed = parseAppDwell(rawId);
  if (!parsed) return;
  const { app, runStart } = parsed;

  if (action === 'work') {
    deps.distractionEvalStore?.recordFeedback(app, runStart, 'work');
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: '✓ Ок, помечу как работу — больше не дёргаю по этому окну.',
    });
    return;
  }

  if (action === 'snooze') {
    const snoozeMin = deps.distractionSnoozeMin ?? DEFAULT_DISTRACTION_SNOOZE_MIN;
    const snoozeUntil = Date.now() + snoozeMin * MINUTE_MS;
    deps.distractionEvalStore?.recordFeedback(app, runStart, 'snooze', snoozeUntil);
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: `😴 Молчу ${snoozeMin}м.`,
    });
    return;
  }
}

// Rebuilds a message's button rows, dropping the one whose customId matches.
// The morning brief carries one row of "✓ Готово" buttons (one per open
// action); when the owner taps one we want to remove just that button and
// leave the rest tappable — not wipe the whole row. Empty rows are dropped so
// Discord doesn't reject a zero-component action row. Defensive: a row/button
// that can't be rebuilt (unexpected shape) is skipped rather than thrown.
function rebuildComponentsWithout(
  rows: readonly any[],
  dropCustomId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const out: ActionRowBuilder<ButtonBuilder>[] = [];
  for (const row of rows) {
    const builder = new ActionRowBuilder<ButtonBuilder>();
    let kept = 0;
    for (const comp of row?.components ?? []) {
      if (comp?.customId === dropCustomId) continue;
      try {
        builder.addComponents(ButtonBuilder.from(comp));
        kept++;
      } catch {
        // A non-button component (or one ButtonBuilder.from can't parse) —
        // skip it rather than abort the whole rebuild.
      }
    }
    if (kept > 0) out.push(builder);
  }
  return out;
}

// One-tap close for a morning-brief pending action. customId is
// `followup:done:<topicId>`; dismissAction is idempotent so a stale button
// (already-dismissed action, or one tapped on an old brief) is a safe no-op —
// we still update the message to drop the tapped button so the UI reflects the
// close. No topicId / unwired store → silent return (nothing actionable).
async function handleFollowupDone(
  ixn: ButtonInteraction,
  deps: InteractionDeps,
  rawId: string,
): Promise<void> {
  const topicId = Number(rawId);
  if (!Number.isInteger(topicId) || topicId <= 0) return;
  if (!deps.topicStore) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: 'Pending actions are not configured.',
    });
    return;
  }
  deps.topicStore.dismissAction(topicId, Date.now());
  const remaining = rebuildComponentsWithout(
    (ixn as any).message?.components ?? [],
    `followup:done:${topicId}`,
  );
  await (ixn as any).update({ components: remaining });
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

// Discord caps a single message at 2000 chars. Error messages from SMTP/IMAP/
// Claude can include verbose server responses; an unclamped `${msg}` would
// blow the cap and make editReply throw, leaving the ephemeral stuck on
// "thinking…" until the 15-min webhook window expires.
const DISCORD_MESSAGE_MAX = 2000;
function clampReplyContent(content: string): string {
  return content.length > DISCORD_MESSAGE_MAX
    ? content.slice(0, DISCORD_MESSAGE_MAX - 1) + '…'
    : content;
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
      content: clampReplyContent(`❌ Не удалось загрузить тред: ${msg}`),
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
      content: clampReplyContent(`❌ PII proxy failed: ${msg}`),
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
      content: clampReplyContent(`❌ Claude не ответил: ${msg}`),
    });
    return;
  }

  if (body && deps.piiProxy) {
    try {
      body = await deps.piiProxy.deanonymize(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await (ixn as any).editReply({
        content: clampReplyContent(`❌ PII proxy failed: ${msg}`),
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
    subject: row.subject,
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

// Absolute-time label for the hold zone ephemeral. uk-UA locale renders 24h
// `HH:MM:SS` consistently with the user's expectations; a 12h locale would
// surface AM/PM which clashes with the rest of the bot.
function formatHoldTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('uk-UA', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function buildCancelSendActionRow(pendingId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`email_draft:cancelSend:${pendingId}`)
      .setLabel('Cancel send')
      .setStyle(ButtonStyle.Danger),
  );
}

// SMTP send/cancel are irreversible by the time we record; a SQLite throw must
// not strand the user on a stale "Will send at …" ephemeral. Best-effort log,
// warn on failure, never bubble.
function recordSentLogSafe(
  log: EmailSentLog | undefined,
  entry: Parameters<EmailSentLog['record']>[0],
): void {
  if (!log) return;
  try {
    log.record(entry);
  } catch (err) {
    console.warn(
      '[email_draft] emailSentLog.record failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

// After a reply ships, flag the original INBOX message `\Answered` so the
// implicit-feedback resolver records this as a `replied` outcome rather than
// fabricating read/ignored negative feedback for a sender the user answered.
// Best-effort: the email is already sent, so a flag-set failure (or absent
// wiring) must never surface to the user — log and move on.
async function markOriginalAnsweredSafe(
  deps: InteractionDeps,
  account: ImapAccount,
  uid: number,
): Promise<void> {
  if (!deps.imapClient?.markAnswered) return;
  try {
    await deps.imapClient.markAnswered(account, uid);
  } catch (err) {
    console.warn(
      '[email_draft] markAnswered failed:',
      err instanceof Error ? err.message : err,
    );
  }
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
  // Claim the body lock SYNCHRONOUSLY before any await. The deferUpdate
  // round-trip below is a ~100ms window during which a stale Edit modal
  // (opened pre-Send in a parallel client) can submit; without this lock
  // the modal handler sees holdPending=null/holdTimer=null, rewrites the
  // body, and Send resumes to queue mutated content the user never reviewed.
  // Run-to-completion guarantees the modal handler can't interleave between
  // this get + put pair.
  const initialState = deps.draftReplyService.get(pendingId);
  const lockAcquired =
    initialState != null &&
    !initialState.holdPending &&
    !initialState.holdTimer;
  if (lockAcquired) {
    deps.draftReplyService.put({ ...initialState, holdPending: true });
  }
  try {
    await (ixn as any).deferUpdate();
  } catch (err) {
    // Discord ack failed → user will never see a UI response. Release the
    // lock so a retry isn't permanently blocked by a stranded holdPending.
    if (lockAcquired) {
      const cur = deps.draftReplyService.get(pendingId);
      if (cur) {
        deps.draftReplyService.put({ ...cur, holdPending: false });
      }
    }
    throw err;
  }
  const state = deps.draftReplyService.get(pendingId);
  if (!state) {
    // lockAcquired means initialState existed and we set holdPending=true
    // synchronously before the deferUpdate await. The only writer that can
    // drop state out from under a holdPending=true entry is the OLD Cancel
    // button (handleEmailDraftCancel), which the user's stale UI may still
    // expose during our deferUpdate round-trip. Re-emit "Отменено" so this
    // tail edit doesn't clobber Cancel's terminal UI with "Черновик истёк".
    const content = lockAcquired ? '❌ Отменено' : '⚠️ Черновик истёк';
    try {
      await (ixn as any).editReply({
        content,
        components: [],
      });
    } catch (editErr) {
      console.warn(
        '[email_draft] post-cancel re-edit failed:',
        editErr instanceof Error ? editErr.message : editErr,
      );
    }
    return;
  }
  // Race: a duplicate or stale Send click arrives while the first click is
  // still mid-flow. If we did NOT acquire the lock above, another Send owns
  // the ephemeral — bail silently so this click's editReply doesn't overwrite
  // the first click's queued state (or an already-shipped "✅ Sent" message)
  // and so we don't arm a parallel timer racing the first armHold.
  if (!lockAcquired) {
    return;
  }

  // Treat absent dep as 0 (bypass) so existing call sites without the env
  // wiring keep the pre-iter-3 synchronous behaviour.
  const holdSeconds = deps.emailSendHoldSeconds ?? 0;

  if (holdSeconds === 0) {
    // Bypass branch: consume state before awaiting SMTP so a rapid double-click
    // can't observe the same pending state twice and send duplicate emails.
    // Restore it on transient failures (no account, SMTP reject) so the user
    // can retry without re-generating the draft.
    deps.draftReplyService.drop(pendingId);
    const account = deps.imapAccounts.get(state.accountId);
    if (!account) {
      // Restore the entry without the holdPending lock so the user can retry.
      deps.draftReplyService.put({ ...state, holdPending: false });
      await (ixn as any).editReply({
        content: `⚠️ Аккаунт ${state.accountId} не настроен`,
        components: [buildDraftActionRow(pendingId)],
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
      deps.draftReplyService.put({ ...state, holdPending: false });
      const msg = err instanceof Error ? err.message : String(err);
      recordSentLogSafe(deps.emailSentLog, {
        action: 'error',
        draftId: pendingId,
        to: state.to,
        subject: state.subject,
        errorMessage: msg,
      });
      await (ixn as any).editReply({
        content: clampReplyContent(`❌ Не отправилось: ${msg}`),
        components: [buildDraftActionRow(pendingId)],
      });
      return;
    }
    recordSentLogSafe(deps.emailSentLog, {
      action: 'sent',
      draftId: pendingId,
      to: state.to,
      subject: state.subject,
    });
    await markOriginalAnsweredSafe(deps, account, state.originalUid);
    await (ixn as any).editReply({
      content: '✅ Отправлено',
      components: [],
    });
    return;
  }

  // Hold branch: arm a per-draft timer; SMTP fires inside executeQueuedSend.
  // Pre-check that the 15-min ephemeral webhook window has enough lifetime
  // left for the hold + a 60s buffer (clock skew + SMTP latency). If not,
  // refuse Send so the timer doesn't fire with an already-expired token.
  const ephemeralExpiresAt = ixn.createdTimestamp + 15 * 60 * 1000;
  if (Date.now() + holdSeconds * 1000 + 60_000 > ephemeralExpiresAt) {
    deps.draftReplyService.drop(pendingId);
    await (ixn as any).editReply({
      content: '⚠️ Сессия черновика истекает. Нажми Draft reply ещё раз.',
      components: [],
    });
    return;
  }

  const account = deps.imapAccounts.get(state.accountId);
  if (!account) {
    // Release the lock so a re-Send isn't blocked by the dup-Send guard.
    deps.draftReplyService.put({ ...state, holdPending: false });
    await (ixn as any).editReply({
      content: `⚠️ Аккаунт ${state.accountId} не настроен`,
      components: [buildDraftActionRow(pendingId)],
    });
    return;
  }

  // Compute sendAt BEFORE editReply so the label is honest about the deadline
  // the user agreed to. Arm the timer ONLY AFTER editReply succeeds — otherwise
  // a slow Discord API call (editReply pending past holdSeconds) lets the timer
  // fire while the Cancel-send UI is still not visible, silently sending an
  // email the user had no chance to abort. Use `remaining` so the actual fire
  // time still tracks the labelled deadline even if editReply was slow.
  const sendAt = Date.now() + holdSeconds * 1000;
  // holdPending was already claimed synchronously at handler entry (above the
  // first await). It remains set through this editReply round-trip until
  // armHold installs the timer; the modal handler refuses on either flag, so
  // the body stays locked end-to-end.
  try {
    await (ixn as any).editReply({
      content: `✉️ Will send at ${formatHoldTime(sendAt)}`,
      components: [buildCancelSendActionRow(pendingId)],
    });
  } catch (editErr) {
    // editReply failed → user will never see the Cancel-send UI. Drop the
    // draft so a stale entry doesn't linger; no timer was armed yet.
    deps.draftReplyService.drop(pendingId);
    throw editErr;
  }
  // The OLD draft Cancel button remains clickable on the user's client until
  // our editReply above replaces it. If it was clicked while editReply was
  // in flight, handleEmailDraftCancel synchronously dropped state and issued
  // its own "Отменено" edit — but our "Will send at…" edit can still land
  // last at Discord and clobber that terminal UI. Re-emit "Отменено" when we
  // detect the drop so the user's final view matches their intent; armHold
  // is a no-op against missing state, but we'd still leave a Cancel-send
  // button that, when clicked, lies with "Слишком поздно — уже отправлено".
  if (!deps.draftReplyService.get(pendingId)) {
    try {
      await (ixn as any).editReply({
        content: '❌ Отменено',
        components: [],
      });
    } catch (editErr) {
      console.warn(
        '[email_draft] post-cancel re-edit failed:',
        editErr instanceof Error ? editErr.message : editErr,
      );
    }
    return;
  }
  const remaining = Math.max(0, sendAt - Date.now());
  const timer = setTimeout(
    () => executeQueuedSend(pendingId, ixn, deps),
    remaining,
  );
  deps.draftReplyService.armHold(pendingId, timer, sendAt);
}

// Timer-fired tail of the hold-zone Send. Runs out-of-band from the original
// click, so any thrown error here has no caller to surface it — wrap the whole
// body in a try/catch and only escalate to logger.warn. The ephemeral webhook
// token can still be valid here (we pre-checked at Send time); if the edit
// fails anyway (clock skew, deep buffer miss) we accept the loss — SMTP has
// already completed and the user can verify in their Sent folder.
async function executeQueuedSend(
  pendingId: string,
  ixn: ButtonInteraction,
  deps: InteractionDeps,
): Promise<void> {
  try {
    if (!deps.draftReplyService || !deps.imapAccounts || !deps.smtpClient) return;
    const state = deps.draftReplyService.get(pendingId);
    // holdTimer null/undefined means Cancel ran between this setTimeout firing
    // and the callback actually executing (rare microtask race in production;
    // unreachable under fake timers since clearTimeout in disarmHold cancels
    // the scheduled callback synchronously).
    if (!state || !state.holdTimer) return;

    // Drop the draft *before* awaiting SMTP. Snapshot the state locally so
    // concurrent modal submits / re-Sends / Cancels during the in-flight
    // window see `state === null` and bail ("истёк" / "Слишком поздно")
    // rather than mutating the body and restoring Send/Edit/Cancel — which
    // would let the user queue a duplicate send while the first one is
    // already irreversible. `drop` also clears the timer handle.
    deps.draftReplyService.drop(pendingId);

    const account = deps.imapAccounts.get(state.accountId);
    if (!account) {
      // Pre-check at Send time normally catches this; fall through defensively
      // (account removed between Send click and timer fire, e.g. config reload).
      // The ephemeral is still showing "Will send at …" with a Cancel-send
      // button — surface the failure so the user isn't lied to by stale UI.
      recordSentLogSafe(deps.emailSentLog, {
        action: 'error',
        draftId: pendingId,
        to: state.to,
        subject: state.subject,
        errorMessage: `Account ${state.accountId} missing at send time`,
      });
      try {
        await (ixn as any).webhook.editMessage('@original', {
          content: clampReplyContent(`⚠️ Аккаунт ${state.accountId} не настроен`),
          components: [],
        });
      } catch (editErr) {
        console.warn(
          '[email_draft] ephemeral edit failed after account-missing:',
          editErr instanceof Error ? editErr.message : editErr,
        );
      }
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
      const msg = err instanceof Error ? err.message : String(err);
      recordSentLogSafe(deps.emailSentLog, {
        action: 'error',
        draftId: pendingId,
        to: state.to,
        subject: state.subject,
        errorMessage: msg,
      });
      try {
        await (ixn as any).webhook.editMessage('@original', {
          content: clampReplyContent(`❌ Не отправилось: ${msg}`),
          components: [],
        });
      } catch (editErr) {
        console.warn(
          '[email_draft] ephemeral edit failed after SMTP error:',
          editErr instanceof Error ? editErr.message : editErr,
        );
      }
      return;
    }

    recordSentLogSafe(deps.emailSentLog, {
      action: 'sent',
      draftId: pendingId,
      to: state.to,
      subject: state.subject,
    });
    await markOriginalAnsweredSafe(deps, account, state.originalUid);
    try {
      await (ixn as any).webhook.editMessage('@original', {
        content: '✅ Sent',
        components: [],
      });
    } catch (editErr) {
      console.warn(
        '[email_draft] ephemeral edit failed after SMTP success:',
        editErr instanceof Error ? editErr.message : editErr,
      );
    }
  } catch (outerErr) {
    console.error(
      '[email_draft] executeQueuedSend unexpected error:',
      outerErr instanceof Error ? outerErr.message : outerErr,
    );
  }
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
  // SYNCHRONOUSLY snapshot + drop state before any await. The OLD Cancel
  // button can still be clicked during the Send flow's editReply round-trip
  // or from a stale client after Send already completed. If we awaited
  // deferUpdate first, the queued hold-timer could fire mid-await, SMTP
  // would complete, and we'd then overwrite the terminal "✅ Sent" UI with
  // "❌ Отменено". `drop` also clearTimeouts any armed holdTimer, so the
  // queued send can't fire even with the callback already on the event loop.
  const existing = deps.draftReplyService.get(pendingId);
  const hadState = existing != null;
  // If the dropped state was Send-armed (timer armed, or holdPending mid-arm),
  // mirror Cancel-send's audit row so the post-period cancel-rate query sees
  // OLD-Cancel-during-hold cancellations too. Plain draft-discards (no Send
  // ever clicked) are not a send terminal outcome and must not be logged.
  const wasSendQueued =
    existing != null &&
    (existing.holdTimer != null || existing.holdPending === true);
  const to = existing?.to;
  const subject = existing?.subject;
  if (hadState) {
    deps.draftReplyService.drop(pendingId);
  }
  await (ixn as any).deferUpdate();
  if (!hadState) {
    // Send already consumed the state — either still in-flight (bypass branch
    // mid-SMTP) or terminal (Sent / error already painted by Send's tail).
    // Don't editReply; we have nothing to cancel and any write would clobber
    // the terminal UI the Send flow owns.
    return;
  }
  if (wasSendQueued) {
    recordSentLogSafe(deps.emailSentLog, {
      action: 'cancelled',
      draftId: pendingId,
      to: to!,
      subject: subject!,
    });
  }
  await (ixn as any).editReply({
    content: '❌ Отменено',
    components: [],
  });
}

// Cancel-send is distinct from cancel-draft: it aborts a queued SMTP send while
// the hold-zone timer is still armed. Missing state or null holdTimer means the
// timer already fired (SMTP went through or is in flight) — we surface that to
// the user rather than silently fabricating a "Cancelled" status.
async function handleEmailDraftCancelSend(
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
  // Inspect state and disarm the timer SYNCHRONOUSLY before any await.
  // If we awaited deferUpdate first, the event loop could fire the queued
  // setTimeout mid-await: executeQueuedSend would drop state and start SMTP
  // before we resumed, so a Cancel click that arrived in time would still
  // lose to a slow Discord API. The createdTimestamp check additionally
  // rejects clicks whose wall-clock arrival is after the deadline, even
  // when the timer callback hasn't drained from the event loop yet.
  const state = deps.draftReplyService.get(pendingId);
  const tooLate =
    !state ||
    !state.holdTimer ||
    (state.holdSendAt != null && ixn.createdTimestamp >= state.holdSendAt);
  let to: string | undefined;
  let subject: string | undefined;
  if (!tooLate && state) {
    to = state.to;
    subject = state.subject;
    deps.draftReplyService.disarmHold(pendingId);
    deps.draftReplyService.drop(pendingId);
  }
  await (ixn as any).deferUpdate();
  if (tooLate) {
    await (ixn as any).editReply({
      content: '⚠️ Слишком поздно — уже отправлено.',
      components: [],
    });
    return;
  }
  recordSentLogSafe(deps.emailSentLog, {
    action: 'cancelled',
    draftId: pendingId,
    to: to!,
    subject: subject!,
  });
  await (ixn as any).editReply({
    content: '🚫 Cancelled',
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

// uk-UA locale renders 24h `DD.MM.YYYY HH:MM`, consistent with other absolute
// times surfaced by the bot (formatHoldTime above).
function formatExpiryLabel(ms: number): string {
  return new Date(ms).toLocaleString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buildSenderTtlActionRow(rowId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`email_suppress:sender_set_ttl:${rowId}:1`)
      .setLabel('1d')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`email_suppress:sender_set_ttl:${rowId}:7`)
      .setLabel('7d')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`email_suppress:sender_set_ttl:${rowId}:30`)
      .setLabel('30d')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`email_suppress:sender_set_ttl:${rowId}:0`)
      .setLabel('forever')
      .setStyle(ButtonStyle.Danger),
  );
}

async function handleSuppressSenderStart(
  ixn: ButtonInteraction,
  deps: InteractionDeps,
  rawId: string,
): Promise<void> {
  if (!deps.emailStore) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: 'Suppression is not configured.',
    });
    return;
  }
  const rowId = Number(rawId);
  if (!Number.isInteger(rowId) || rowId <= 0) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: '⚠️ Некорректная ссылка на письмо',
    });
    return;
  }
  const row = deps.emailStore.findByPendingId(rowId);
  if (!row) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: '⚠️ Письмо больше недоступно',
    });
    return;
  }
  await (ixn as any).reply({
    flags: MessageFlags.Ephemeral,
    content: `🙈 На сколько заглушить \`${row.from_addr}\`?`,
    components: [buildSenderTtlActionRow(row.id)],
  });
}

async function handleSuppressSenderSetTtl(
  ixn: ButtonInteraction,
  deps: InteractionDeps,
  rawId: string,
): Promise<void> {
  if (!deps.emailStore || !deps.emailSuppressionStore) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: 'Suppression is not configured.',
    });
    return;
  }
  // rawId format: `${rowId}:${ttl}`
  const sepIdx = rawId.indexOf(':');
  if (sepIdx < 0) {
    await (ixn as any).update({
      content: '⚠️ Некорректная ссылка',
      components: [],
    });
    return;
  }
  const rowId = Number(rawId.slice(0, sepIdx));
  const ttl = Number(rawId.slice(sepIdx + 1));
  if (
    !Number.isInteger(rowId) ||
    rowId <= 0 ||
    !Number.isInteger(ttl) ||
    ttl < 0
  ) {
    await (ixn as any).update({
      content: '⚠️ Некорректная ссылка',
      components: [],
    });
    return;
  }
  const row = deps.emailStore.findByPendingId(rowId);
  if (!row) {
    await (ixn as any).update({
      content: '⚠️ Письмо больше недоступно',
      components: [],
    });
    return;
  }
  // ttl=0 sentinel maps to expires_at=NULL ("forever"). Any other value is the
  // TTL in days; suppression-store converts to absolute epoch ms.
  const ttl_days = ttl === 0 ? null : ttl;
  const inserted = deps.emailSuppressionStore.insertRule({
    rule_type: 'sender',
    pattern: row.from_addr,
    ttl_days,
  });
  const expiresLabel =
    inserted.expires_at === null ? 'навсегда' : formatExpiryLabel(inserted.expires_at);
  await (ixn as any).update({
    content: `🙈 Заглушён \`${row.from_addr}\` до ${expiresLabel}`,
    components: [],
  });
}

// Discord text-input max length for the subject substring. Long enough to hold
// most full subjects (the modal pre-fills from `row.subject`), short enough to
// keep the LIKE '%pattern%' index-less scan cheap.
const SUBJECT_PATTERN_MAX_LEN = 200;
// Days bounds for the subject TTL. 0 → forever (NULL expires_at); upper bound
// is arbitrary but generous; longer than ~a year is "forever" in practice.
const SUBJECT_TTL_DAYS_MIN = 0;
const SUBJECT_TTL_DAYS_MAX = 365;

async function handleSuppressSubjectStart(
  ixn: ButtonInteraction,
  deps: InteractionDeps,
  rawId: string,
): Promise<void> {
  if (!deps.emailStore) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: 'Suppression is not configured.',
    });
    return;
  }
  const rowId = Number(rawId);
  if (!Number.isInteger(rowId) || rowId <= 0) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: '⚠️ Некорректная ссылка на письмо',
    });
    return;
  }
  const row = deps.emailStore.findByPendingId(rowId);
  if (!row) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: '⚠️ Письмо больше недоступно',
    });
    return;
  }
  // Clamp the prefill so TextInputBuilder.setValue doesn't throw when the
  // subject exceeds the modal's per-field max; subjects from the wild can be
  // arbitrarily long (auto-generated alerts, forwarded chains).
  const prefill =
    row.subject.length > SUBJECT_PATTERN_MAX_LEN
      ? row.subject.slice(0, SUBJECT_PATTERN_MAX_LEN)
      : row.subject;
  const modal = new ModalBuilder()
    .setCustomId(`email_suppress:subject_submit:${row.id}`)
    .setTitle('🙈 Заглушить тему');
  const substringInput = new TextInputBuilder()
    .setCustomId('substring')
    .setLabel('Шаблон для блокировки (substring)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(SUBJECT_PATTERN_MAX_LEN)
    .setValue(prefill);
  const daysInput = new TextInputBuilder()
    .setCustomId('days')
    .setLabel('Дней (0 = forever)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(3)
    .setValue('7');
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(substringInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(daysInput),
  );
  await (ixn as any).showModal(modal);
}

async function handleSuppressSubjectSubmit(
  ixn: ModalSubmitInteraction,
  deps: InteractionDeps,
  rawId: string,
): Promise<void> {
  if (!deps.emailSuppressionStore) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: 'Suppression is not configured.',
    });
    return;
  }
  // rawId is the source row id — kept for symmetry with the sender flow and
  // future "rule attribution" use; not strictly required to insert the rule.
  const rowId = Number(rawId);
  if (!Number.isInteger(rowId) || rowId <= 0) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: '⚠️ Некорректная ссылка на письмо',
    });
    return;
  }
  const substringRaw = ixn.fields.getTextInputValue('substring') ?? '';
  const daysRaw = ixn.fields.getTextInputValue('days') ?? '';
  const substring = substringRaw.trim();
  if (substring.length === 0) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: '⚠️ Пустой шаблон не сохраняется',
    });
    return;
  }
  // Reject NaN, floats, infinities, and out-of-range — match the test contract
  // exactly so the user gets one consistent error string.
  // Empty / whitespace input must be rejected explicitly: `Number('')` is 0,
  // which would otherwise pass the range check and silently create a
  // forever-rule despite the modal field being marked required.
  const daysTrimmed = daysRaw.trim();
  const days = Number(daysTrimmed);
  if (
    daysTrimmed.length === 0 ||
    !Number.isInteger(days) ||
    days < SUBJECT_TTL_DAYS_MIN ||
    days > SUBJECT_TTL_DAYS_MAX
  ) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: `⚠️ Введите число от ${SUBJECT_TTL_DAYS_MIN} до ${SUBJECT_TTL_DAYS_MAX}`,
    });
    return;
  }
  const ttl_days = days === 0 ? null : days;
  const inserted = deps.emailSuppressionStore.insertRule({
    rule_type: 'subject',
    pattern: substring,
    ttl_days,
  });
  const expiresLabel =
    inserted.expires_at === null ? 'навсегда' : formatExpiryLabel(inserted.expires_at);
  await (ixn as any).reply({
    flags: MessageFlags.Ephemeral,
    content: `🙈 Заглушены письма с темой «${substring}» до ${expiresLabel}`,
  });
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
  // Race: the user opened the Edit modal *before* clicking Send, then submitted
  // it while the hold timer is armed — or while editReply on the Send click is
  // still in flight (holdPending=true but holdTimer not yet armed). Both
  // windows must refuse: accepting the edit would silently change the body the
  // timer is (or will be) armed against, bypassing the hold UI the user just
  // confirmed. Refuse so the queued body matches what was reviewed.
  if (state.holdTimer || state.holdPending) {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: '⚠️ Send уже запущен. Сначала Cancel send, потом редактируй.',
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
  if (customId.startsWith('email_suppress:subject_submit:')) {
    await handleSuppressSubjectSubmit(
      ixn,
      deps,
      customId.slice('email_suppress:subject_submit:'.length),
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
  if (name === 'why') {
    await handleWhySlash(ixn, deps);
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

// Embed-friendly clip. Discord embed description has a 4096-char cap and
// EmbedBuilder.setDescription throws RangeError past it — a multi-KB subject
// or from header would break /why for the offending row. Clip each field
// independently so the rest of the embed stays intact.
const WHY_SUBJECT_MAX_LEN = 100;
const WHY_FROM_MAX_LEN = 200;
function clipForWhy(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function formatWhyTime(ms: number): string {
  // `HH:MM DD.MM` — short form matching the plan's embed mockup. Same uk-UA
  // locale used elsewhere (24h, day-first) so dates align across surfaces.
  const d = new Date(ms);
  const time = d.toLocaleTimeString('uk-UA', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const date = d.toLocaleDateString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
  });
  return `${time} ${date}`;
}

function formatWhyHourMinute(ms: number): string {
  return new Date(ms).toLocaleTimeString('uk-UA', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function describeRule(rule: import('../../emails/suppression-store.js').SuppressionRule): string {
  const expires =
    rule.expires_at === null ? 'навсегда' : `до ${formatExpiryLabel(rule.expires_at)}`;
  const kind = rule.rule_type === 'sender' ? 'отправитель' : 'тема';
  // Flag R2-driven rules so the user can tell an auto-suppression from a
  // manual /mute. Keeps `'auto_feedback'` as the single source of truth.
  const origin = rule.created_via === 'auto_feedback' ? ' — авто (по реакции)' : '';
  return `${kind} \`${rule.pattern}\` (${expires})${origin}`;
}

/** Render the implicit-feedback section shown in `/why`. Shared by the urgent
 *  and suppressed branches so an auto-suppression is explained on the very
 *  emails it silences. */
function feedbackLines(
  fb: import('../../services/command-service.js').SenderFeedbackSignals,
): string[] {
  const autoLine = fb.autoSuppression
    ? `авто-заглушение активно (${
        fb.autoSuppression.expiresAt === null
          ? 'навсегда'
          : `до ${formatExpiryLabel(fb.autoSuppression.expiresAt)}`
      })`
    : 'авто-заглушение: нет';
  return [
    '',
    'Реакция на urgent-пинги (7д):',
    `  ответил: ${fb.replied} — прочитал: ${fb.read} — проигнорировал: ${fb.ignored}`,
    `  ${autoLine}`,
  ];
}

async function handleWhySlash(
  ixn: ChatInputCommandInteraction,
  deps: InteractionDeps,
): Promise<void> {
  const rawId = (ixn as any).options.getInteger('id') as number | null;
  const id = typeof rawId === 'number' ? rawId : undefined;
  const result = deps.commandService.whyEmailUrgent({ id });

  if (result.kind === 'not_configured') {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: '⚠️ Email-наблюдение не настроено.',
    });
    return;
  }
  if (result.kind === 'not_found') {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: `Письмо с id=\`${result.id}\` не найдено.`,
    });
    return;
  }
  if (result.kind === 'no_recent_urgent') {
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      content: 'Недавних urgent писем нет.',
    });
    return;
  }

  if (result.kind === 'not_urgent') {
    const row = result.row;
    const ruleLine = result.activeRule ? describeRule(result.activeRule) : '—';
    const embed = new EmbedBuilder()
      .setTitle('ℹ️ Письмо не помечено как urgent')
      .setDescription(
        [
          `From: ${clipForWhy(row.from_addr, WHY_FROM_MAX_LEN)}`,
          `Subject: ${clipForWhy(row.subject, WHY_SUBJECT_MAX_LEN)}`,
          `Importance: ${row.importance}/5 — получено ${formatWhyTime(row.received_at)}`,
          '',
          'urgent ping не отправлялся — importance < 5 или письмо ещё в очереди.',
          '',
          `Активное правило заглушения: ${ruleLine}`,
        ].join('\n'),
      );
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      embeds: [embed],
    });
    return;
  }

  if (result.kind === 'suppressed') {
    const row = result.row;
    const ruleLine = result.matchedRule
      ? describeRule(result.matchedRule)
      : 'правило истекло или удалено';
    const lines = [
      `From: ${clipForWhy(row.from_addr, WHY_FROM_MAX_LEN)}`,
      `Subject: ${clipForWhy(row.subject, WHY_SUBJECT_MAX_LEN)}`,
      `Получено: ${formatWhyTime(row.received_at)}`,
      '',
      `Заглушено правилом: ${ruleLine}`,
    ];
    // Explain *why* it's silenced — surfaces the outcome counts and active
    // auto-suppression so a wrongly-silenced sender is diagnosable from /why.
    if (result.feedback) {
      lines.push(...feedbackLines(result.feedback));
    }
    const embed = new EmbedBuilder()
      .setTitle('🙈 Suppressed by rule')
      .setDescription(lines.join('\n'));
    await (ixn as any).reply({
      flags: MessageFlags.Ephemeral,
      embeds: [embed],
    });
    return;
  }

  // kind === 'urgent'
  const row = result.row;
  const pingedAt =
    row.urgent_pinged_at != null && row.urgent_pinged_at > 0
      ? formatWhyHourMinute(row.urgent_pinged_at)
      : '—';
  const ruleLine = result.activeRule ? describeRule(result.activeRule) : '—';
  const lines = [
    `From: ${clipForWhy(row.from_addr, WHY_FROM_MAX_LEN)}`,
    `Subject: ${clipForWhy(row.subject, WHY_SUBJECT_MAX_LEN)}`,
    `Importance: ${row.importance}/5 — received ${formatWhyTime(row.received_at)} — pinged ${pingedAt}`,
    '',
    'Прошлые 7 дней с этого отправителя:',
    `  писем: ${result.history.pendings} — отправлено: ${result.history.sent} — отменено: ${result.history.cancelled} — ошибок: ${result.history.error}`,
    '',
    `Активное правило заглушения: ${ruleLine}`,
  ];
  if (result.feedback) {
    lines.push(...feedbackLines(result.feedback));
  }
  const embed = new EmbedBuilder()
    .setTitle('🔍 Why this is urgent')
    .setDescription(lines.join('\n'));
  await (ixn as any).reply({
    flags: MessageFlags.Ephemeral,
    embeds: [embed],
  });
}
