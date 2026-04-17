import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

export type ReminderState = 'ringing' | 'dismissed' | 'snoozed' | 'missed';

export function buildReminderEmbed(opts: {
  id: number;
  text: string;
  state: ReminderState;
}): { embed: EmbedBuilder; components: ActionRowBuilder<ButtonBuilder>[] } {
  const embed = new EmbedBuilder().setTitle(`⏰ ${opts.text}`);

  switch (opts.state) {
    case 'ringing':
      embed.setFooter({ text: 'now ringing' });
      return {
        embed,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`reminder:dismiss:${opts.id}`)
              .setLabel('Dismiss')
              .setEmoji('✓')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`reminder:snooze:${opts.id}`)
              .setLabel('Snooze 10m')
              .setEmoji('😴')
              .setStyle(ButtonStyle.Secondary),
          ),
        ],
      };
    case 'dismissed':
      embed.setFooter({ text: '✓ Dismissed' });
      return { embed, components: [] };
    case 'snoozed':
      embed.setFooter({ text: '😴 Snoozed 10m' });
      return { embed, components: [] };
    case 'missed':
      embed.setFooter({ text: '⏰ missed' });
      return { embed, components: [] };
  }
}

export type PermissionState =
  | 'pending'
  | 'allowed_once'
  | 'allowed_always'
  | 'denied'
  | 'expired';

export function buildPermissionEmbed(opts: {
  callId: string;
  toolName: string;
  argsSummary: string;
  state: PermissionState;
}): { embed: EmbedBuilder; components: ActionRowBuilder<ButtonBuilder>[] } {
  const embed = new EmbedBuilder()
    .setTitle('🔐 Permission request')
    .setDescription(`Tool: \`${opts.toolName}\`\n${opts.argsSummary}`);

  if (opts.state === 'pending') {
    return {
      embed,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`perm:allow_once:${opts.callId}`)
            .setLabel('Allow once')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`perm:allow_always:${opts.callId}`)
            .setLabel('Allow always')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`perm:deny:${opts.callId}`)
            .setLabel('Deny')
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    };
  }

  const footerByState: Record<Exclude<PermissionState, 'pending'>, string> = {
    allowed_once: '✓ Allowed once',
    allowed_always: '✓ Allowed always',
    denied: '✗ Denied',
    expired: '⚠️ expired',
  };
  embed.setFooter({ text: footerByState[opts.state] });
  return { embed, components: [] };
}
