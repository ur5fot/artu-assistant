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

export interface PlanReviewChunk {
  content?: string;
  components?: ActionRowBuilder<ButtonBuilder>[];
}

const DISCORD_MESSAGE_LIMIT = 2000;
const CODE_FENCE_OVERHEAD = 8; // ``` + \n, twice
const MAX_CHUNKS = 20;

export function buildPlanReviewChunks(opts: {
  callId: string;
  plan: string;
}): PlanReviewChunk[] {
  const lines = opts.plan.split('\n');
  const chunks: string[] = [];
  let buf: string[] = [];
  let bufLen = 0;

  // Leave room for header line + fence overhead
  const firstChunkBudget = DISCORD_MESSAGE_LIMIT - 60 - CODE_FENCE_OVERHEAD;
  const restChunkBudget = DISCORD_MESSAGE_LIMIT - CODE_FENCE_OVERHEAD;

  const flush = () => {
    if (buf.length === 0) return;
    chunks.push(buf.join('\n'));
    buf = [];
    bufLen = 0;
  };

  for (const line of lines) {
    const budget = chunks.length === 0 ? firstChunkBudget : restChunkBudget;
    // +1 for the newline joiner
    const added = line.length + 1;
    if (bufLen + added > budget && buf.length > 0) {
      flush();
    }
    buf.push(line);
    bufLen += added;
    if (chunks.length >= MAX_CHUNKS - 1 && bufLen >= restChunkBudget * 0.9) {
      flush();
      break; // stop collecting further lines
    }
  }
  flush();

  let truncated = false;
  if (chunks.length > MAX_CHUNKS) {
    chunks.length = MAX_CHUNKS;
    truncated = true;
  }
  if (chunks.length === MAX_CHUNKS && lines.length > 0) {
    // Rough check: we still had lines that did not fit — mark truncated
    const totalRendered = chunks.join('\n').split('\n').length;
    if (totalRendered < lines.length) truncated = true;
  }

  const total = chunks.length;
  const out: PlanReviewChunk[] = chunks.map((body, i) => {
    const header = i === 0 ? `📋 Plan review (${i + 1}/${total})\n` : '';
    let suffix = '';
    if (truncated && i === total - 1) {
      suffix = '\n⚠️ plan truncated';
    }
    return {
      content: `${header}\`\`\`\n${body}\n\`\`\`${suffix}`,
      components: [],
    };
  });

  out.push({
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`plan:approve:${opts.callId}`)
          .setLabel('Approve')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`plan:reject:${opts.callId}`)
          .setLabel('Reject')
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  });

  return out;
}
