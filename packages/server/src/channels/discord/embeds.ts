import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import type { ComponentData, EmbedData } from '../../cognition/types.js';
import type { EmailPendingRow } from '../../emails/types.js';

export type ReminderState = 'ringing' | 'dismissed' | 'snoozed' | 'missed';

// Discord embed title hard limit is 256 chars. A user-authored reminder may
// legitimately exceed that (especially if the LLM generates a verbose one);
// setTitle throws RangeError past the limit, so truncate at render.
const EMBED_TITLE_LIMIT = 256;

export function buildReminderEmbed(opts: {
  id: number;
  text: string;
  state: ReminderState;
}): { embed: EmbedBuilder; components: ActionRowBuilder<ButtonBuilder>[] } {
  const rawTitle = `⏰ ${opts.text}`;
  const title =
    rawTitle.length > EMBED_TITLE_LIMIT
      ? rawTitle.slice(0, EMBED_TITLE_LIMIT - 1) + '…'
      : rawTitle;
  const embed = new EmbedBuilder().setTitle(title);

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
              .setEmoji('✅')
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
  const rawLines = opts.plan.split('\n');
  const chunks: string[] = [];
  let buf: string[] = [];
  let bufLen = 0;

  // Leave room for header line + fence overhead
  const firstChunkBudget = DISCORD_MESSAGE_LIMIT - 60 - CODE_FENCE_OVERHEAD;
  const restChunkBudget = DISCORD_MESSAGE_LIMIT - CODE_FENCE_OVERHEAD;

  // Hard-split any line longer than the smallest budget — a single >2000-char
  // line (e.g. minified JSON) would otherwise produce a chunk that exceeds
  // Discord's message limit and make the entire send fail with 50035.
  const lines: string[] = [];
  for (const line of rawLines) {
    if (line.length <= restChunkBudget) {
      lines.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += restChunkBudget) {
      lines.push(line.slice(i, i + restChunkBudget));
    }
  }

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

const URGENT_FIELD_VALUE_LIMIT = 1024;
const URGENT_SNIPPET_MAX = 200;

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Plain-data builder — returns the shape consumed by bot.ts (which converts
// to EmbedBuilder/ActionRowBuilder). Keeps the cognition handler free of
// discord.js types.
export function buildUrgentEmailEmbed(row: EmailPendingRow): {
  embed: EmbedData;
  components: ComponentData[];
} {
  const from = collapseWs(row.from_addr);
  const subject = collapseWs(row.subject) || '(no subject)';
  const snippetRaw = collapseWs(row.snippet);
  const snippet = truncate(snippetRaw, URGENT_SNIPPET_MAX);

  const fields = [
    { name: 'From', value: truncate(from, URGENT_FIELD_VALUE_LIMIT) },
    { name: 'Subject', value: truncate(subject, URGENT_FIELD_VALUE_LIMIT) },
  ];
  if (snippet.length > 0) {
    fields.push({ name: 'Snippet', value: truncate(snippet, URGENT_FIELD_VALUE_LIMIT) });
  }

  return {
    embed: {
      title: '🚨 Urgent email',
      fields,
    },
    components: [
      {
        type: 'row',
        buttons: [
          {
            customId: `email_draft:start:${row.id}`,
            label: 'Draft reply',
            style: 'primary',
          },
          {
            customId: `email_suppress:sender_start:${row.id}`,
            label: '🙈 Sender',
            style: 'secondary',
          },
          {
            customId: `email_suppress:subject_start:${row.id}`,
            label: '🙈 Subject',
            style: 'secondary',
          },
        ],
      },
    ],
  };
}

export interface PermissionsListReply {
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

const MAX_REVOKE_BUTTONS = 5;
// Discord embed description hard limit is 4096 — leave headroom for the
// truncation marker so a large ruleset doesn't throw RangeError.
const DESCRIPTION_LIMIT = 4000;
const REVOKE_CUSTOM_ID_PREFIX = 'perm_rule:revoke:';
const REVOKE_LABEL_PREFIX = 'Revoke ';
// Discord custom_id is capped at 100, button label at 80. Pick the stricter
// bound so rendering never fails on either.
const REVOKE_TOOL_NAME_MAX = Math.min(
  100 - REVOKE_CUSTOM_ID_PREFIX.length,
  80 - REVOKE_LABEL_PREFIX.length,
);

function truncateWithEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function buildPermissionsListReply(
  rules: Array<{ toolName: string; allowed: boolean }>,
): PermissionsListReply {
  if (rules.length === 0) {
    return { content: 'No saved permission rules.', embeds: [], components: [] };
  }

  const lines = rules.map((r) => `${r.allowed ? '✅' : '❌'} \`${r.toolName}\``);
  const embed = new EmbedBuilder()
    .setTitle('📋 Saved permission rules')
    .setDescription(truncateWithEllipsis(lines.join('\n'), DESCRIPTION_LIMIT));

  // Skip button rendering for tool names that would overflow Discord's
  // custom_id/label limits — truncating would break the revoke handler since
  // it can't reconstruct the original tool name from a shortened id.
  const buttonEligible = rules.filter((r) => r.toolName.length <= REVOKE_TOOL_NAME_MAX);
  const visible = buttonEligible.slice(0, MAX_REVOKE_BUTTONS);
  if (buttonEligible.length > MAX_REVOKE_BUTTONS) {
    embed.setFooter({
      text: `Showing ${MAX_REVOKE_BUTTONS} of ${buttonEligible.length}. Revoke some and re-open /permissions.`,
    });
  }

  const rows = visible.map((r) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${REVOKE_CUSTOM_ID_PREFIX}${r.toolName}`)
        .setLabel(`${REVOKE_LABEL_PREFIX}${r.toolName}`)
        .setStyle(ButtonStyle.Danger),
    ),
  );

  return { content: '', embeds: [embed], components: rows };
}
