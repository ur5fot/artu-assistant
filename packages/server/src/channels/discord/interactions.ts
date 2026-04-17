import type { ButtonInteraction, ChatInputCommandInteraction, Interaction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { ReminderService } from '../../services/reminder-service.js';
import type { PermissionService } from '../../services/permission-service.js';
import type { PlanReviewService } from '../../services/plan-review-service.js';
import type { CommandService } from '../../services/command-service.js';
import {
  buildReminderEmbed,
  buildPermissionEmbed,
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
    const added = (out.length === 0 ? 0 : 1) + line.length;
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

  if (interaction.isChatInputCommand()) {
    await routeSlashCommand(interaction, deps);
    return;
  }
}

async function routeButton(
  ixn: ButtonInteraction,
  deps: InteractionDeps,
): Promise<void> {
  const [domain, action, rawId] = ixn.customId.split(':');

  if (domain === 'reminder') {
    const id = Number(rawId);
    if (!Number.isInteger(id)) return;
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
    if (!deps.permissionService.hasPending(callId)) {
      const msgEmbed = (ixn as any).message?.embeds?.[0];
      const { toolName, argsSummary } = parsePermissionDescription(
        msgEmbed?.description ?? '',
      );
      const { embed } = buildPermissionEmbed({
        callId,
        toolName,
        argsSummary,
        state: 'expired',
      });
      await (ixn as any).update({ embeds: [embed], components: [] });
      return;
    }
    let allowed = false;
    let remember = false;
    let finalState: 'allowed_once' | 'allowed_always' | 'denied' = 'denied';
    if (action === 'allow_once') { allowed = true; finalState = 'allowed_once'; }
    else if (action === 'allow_always') { allowed = true; remember = true; finalState = 'allowed_always'; }
    else if (action === 'deny') { allowed = false; finalState = 'denied'; }
    else return;
    deps.permissionService.resolveConfirm(callId, allowed, remember);
    const msgEmbed = (ixn as any).message?.embeds?.[0];
    const { toolName, argsSummary } = parsePermissionDescription(
      msgEmbed?.description ?? '',
    );
    const { embed } = buildPermissionEmbed({
      callId,
      toolName,
      argsSummary,
      state: finalState,
    });
    await (ixn as any).update({ embeds: [embed], components: [] });
    return;
  }

  if (domain === 'plan') {
    const callId = rawId ?? '';
    if (!deps.planReviewService.hasPending(callId)) {
      await (ixn as any).update({ components: [], content: '⚠️ expired' });
      return;
    }
    const approved = action === 'approve';
    deps.planReviewService.resolveReview(callId, approved);
    await (ixn as any).update({
      components: [],
      content: approved ? '✓ approved' : '✗ rejected',
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
  if (name === 'memory') {
    const query = (ixn as any).options.getString('query') ?? undefined;
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
    await (ixn as any).reply({ flags: MessageFlags.Ephemeral, content });
    return;
  }
}
