import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Interaction,
  ModalSubmitInteraction,
} from 'discord.js';
import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { ReminderService } from '../../services/reminder-service.js';
import type { PermissionService } from '../../services/permission-service.js';
import type { PlanReviewService } from '../../services/plan-review-service.js';
import type { CommandService } from '../../services/command-service.js';
import type { CognitionService } from '../../cognition/service.js';
import type { MemoryConfirmService } from '../../services/memory-confirm-service.js';
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
      const initialValue = deps.memoryConfirmInitialValues?.get(callId) ?? '';
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

async function routeModalSubmit(
  ixn: ModalSubmitInteraction,
  deps: InteractionDeps,
): Promise<void> {
  const customId = ixn.customId;
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
  await (ixn as any).reply({
    flags: MessageFlags.Ephemeral,
    content: result.ok
      ? `✅ Approved with edit: ${field}="${value}"`
      : '⚠️ Expired',
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
