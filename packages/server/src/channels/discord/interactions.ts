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

export interface InteractionDeps {
  whitelist: Set<string>;
  reminderService: ReminderService;
  permissionService: PermissionService;
  planReviewService: PlanReviewService;
  commandService: CommandService;
}

export async function routeInteraction(
  interaction: Interaction,
  deps: InteractionDeps,
): Promise<void> {
  if (!deps.whitelist.has(interaction.user.id)) {
    if ('reply' in interaction && typeof (interaction as any).reply === 'function') {
      await (interaction as any).reply({ content: 'Not authorized.', ephemeral: true, flags: MessageFlags.Ephemeral });
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
      const { embed } = buildPermissionEmbed({
        callId,
        toolName: '',
        argsSummary: '',
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
    const { embed } = buildPermissionEmbed({
      callId,
      toolName: msgEmbed?.title ?? '',
      argsSummary: msgEmbed?.description ?? '',
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
}

async function routeSlashCommand(
  ixn: ChatInputCommandInteraction,
  _deps: InteractionDeps,
): Promise<void> {
  // implemented in Task 17
  await (ixn as any).reply({ content: 'Not yet implemented', ephemeral: true, flags: MessageFlags.Ephemeral });
}
