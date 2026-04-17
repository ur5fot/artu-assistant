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
