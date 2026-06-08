import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import type { ButtonData, ComponentData, EmbedData } from '../../cognition/types.js';
import type { EmailPendingRow } from '../../emails/types.js';
import type { OpenAction } from '../../topics/store.js';

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

// Plain-data shape consumed by bot.ts. SwitchEvent is re-declared structurally
// here (rather than imported from the observers layer) so the discord channel
// stays decoupled from the observation infra.
export interface WindowRestoreEvent {
  away_app: string;
  away_session_started_at: number;
  away_session_ended_at: number;
  current_app: string;
}

// Privacy-by-default — the embed shows ONLY the summary (app + duration). Window
// titles can leak sensitive context (PDF filenames, DM partner names, banking
// URLs) to anyone glancing at the screen, so they never appear here; the user
// must click "Show titles" to fetch them as an ephemeral message. See the
// plan's "Why no titles in default embed" note. Do not add a titles field.
// Discord caps a button custom_id at 100 chars. The away-app name is an
// external macOS process name embedded verbatim, and the title lookup matches
// it exactly (listTitlesInSession WHERE app_name = ?), so it can't be
// truncated. For the rare app whose name pushes the id over 100, drop the
// button rather than let setCustomId throw and fail the whole publish — the
// summary embed still renders; only the optional "Show titles" affordance is
// lost. Mirrors the overflow guard in buildPermissionsListReply.
const CUSTOM_ID_LIMIT = 100;

// Length budgets for the distraction nudge body. Discord caps a message at 2000
// chars; bot.ts also prefixes "💭 _from distractionPullback_\n" (~30 chars), so
// keep a comfortable margin. The per-field caps keep the line readable while the
// overall cap is a hard backstop.
const NUDGE_TITLE_MAX = 150;
const NUDGE_WORK_MAX = 400;
const NUDGE_CONTENT_MAX = 1900;

export function buildWindowRestoreEmbed(
  event: WindowRestoreEvent,
  durationMin: number,
): { embed: EmbedData; components: ComponentData[] } {
  const customId = `window:show:${event.away_app}:${event.away_session_started_at}:${event.away_session_ended_at}`;
  const components: ComponentData[] =
    customId.length <= CUSTOM_ID_LIMIT
      ? [
          {
            type: 'row',
            buttons: [
              {
                customId,
                label: 'Show titles',
                style: 'primary',
              },
            ],
          },
        ]
      : [];
  return {
    embed: {
      title: '🔁 Restore context?',
      fields: [
        { name: 'Was on', value: event.away_app, inline: true },
        { name: 'For', value: `~${durationMin}min`, inline: true },
        { name: 'Now on', value: event.current_app, inline: true },
      ],
    },
    components,
  };
}

// Plain-data shape consumed by the distraction handler / bot.ts. The handler
// composes this from the judge's verdict (app, current title, dwell length,
// work summary) plus the dwell key (runStart) and the configured snooze window.
export interface DistractionNudgeEvent {
  app: string;
  title: string;
  dwellMin: number;
  workSummary: string;
  /** = runStart — the dwell key the button handlers write feedback against. */
  runStart: number;
  /** Snooze window in minutes — rendered into the "Отстань на Nм" label. */
  snoozeMin: number;
}

// Builds the proactive pullback ping: a short "you've been stuck N min" line +
// four buttons (back / it's-work / done / snooze). Mirrors buildWindowRestoreEmbed's
// custom_id overflow guard — the `work`/`done`/`snooze` ids embed the app name
// verbatim (the feedback lookup matches it exactly via recordFeedback), so for
// a pathologically long app name those buttons are dropped rather than letting
// setCustomId throw and fail the whole publish; the "Возвращаюсь" ack (no app
// in its id) and the text always survive.
export function buildDistractionNudge(event: DistractionNudgeEvent): {
  content: string;
  components: ComponentData[];
} {
  // Clamp the free-text parts (window title can be arbitrarily long; work
  // summary comes from the LLM judge) so the body never approaches Discord's
  // 2000-char message cap. An over-limit send would throw, and because the
  // nudge carries components it's sent directly (not via the splitter) — a
  // throw there skips onPublished, so the eval is never recorded and the filter
  // re-wakes the judge every tick. The final cap is a backstop for a long app.
  const titlePart = event.title ? `: ${truncateWithEllipsis(event.title, NUDGE_TITLE_MAX)}` : '';
  const workPart = event.workSummary
    ? ` До этого: ${truncateWithEllipsis(event.workSummary, NUDGE_WORK_MAX)}.`
    : '';
  const content = truncateWithEllipsis(
    `🧲 Ты ~${event.dwellMin} мин в ${event.app}${titlePart}.${workPart} Вернёшься?`,
    NUDGE_CONTENT_MAX,
  );

  const workId = `distract:work:${event.app}:${event.runStart}`;
  const doneId = `distract:done:${event.app}:${event.runStart}`;
  const snoozeId = `distract:snooze:${event.app}:${event.runStart}`;
  const buttons: ButtonData[] = [
    { customId: `distract:back:${event.runStart}`, label: 'Возвращаюсь', style: 'success' },
  ];
  if (workId.length <= CUSTOM_ID_LIMIT) {
    buttons.push({ customId: workId, label: 'Это по работе', style: 'secondary' });
  }
  if (doneId.length <= CUSTOM_ID_LIMIT) {
    buttons.push({ customId: doneId, label: '✅ Закончил', style: 'secondary' });
  }
  if (snoozeId.length <= CUSTOM_ID_LIMIT) {
    buttons.push({ customId: snoozeId, label: `Отстань на ${event.snoozeMin}м`, style: 'danger' });
  }
  return { content, components: [{ type: 'row', buttons }] };
}

// One-tap "✓ Готово" buttons for the morning brief's open pending actions. Each
// action (a finalized topic whose owner still owes an external step) gets a
// success button whose customId `followup:done:<topicId>` the interaction handler
// reads to dismiss it. Capped at a single Discord row (5 buttons) — the brief
// prose lists the same set, so the cap is shared. Empty input → no components
// (text-only brief, exactly as before this feature). The label is truncated to
// Discord's 80-char button cap (minus the "✓ " prefix); topicId is a small
// integer so the customId never approaches the 100-char id limit.
// Discord caps a button row at 5, so at most this many actions get a tap-button
// per message. Exported so auto-close handlers cap how many actions they
// dismiss per notice — never dismiss an action we can't render a reopen button
// for (that would break the soft + reversible contract).
export const PENDING_ACTIONS_MAX = 5;
const PENDING_ACTION_LABEL_MAX = 78;

export function buildPendingActionsComponents(actions: OpenAction[]): ComponentData[] {
  const visible = actions.slice(0, PENDING_ACTIONS_MAX);
  if (visible.length === 0) return [];
  return [
    {
      type: 'row',
      buttons: visible.map((a) => ({
        customId: `followup:done:${a.topicId}`,
        label: `✓ ${truncate(a.action, PENDING_ACTION_LABEL_MAX)}`,
        style: 'success',
      })),
    },
  ];
}

// One-tap "↩ Вернуть" buttons for actions the emailActionMatch handler
// auto-closed off a confirmation email. Each gets a secondary button whose
// customId `followup:reopen:<topicId>` the interaction handler reads to clear
// the dismiss timestamp (resurfacing the action in the next brief). Same caps
// and empty-input behaviour as buildPendingActionsComponents — auto-close
// notices list at most PENDING_ACTIONS_MAX closed actions per message.
export function buildActionReopenComponents(actions: OpenAction[]): ComponentData[] {
  const visible = actions.slice(0, PENDING_ACTIONS_MAX);
  if (visible.length === 0) return [];
  return [
    {
      type: 'row',
      buttons: visible.map((a) => ({
        customId: `followup:reopen:${a.topicId}`,
        label: `↩ ${truncate(a.action, PENDING_ACTION_LABEL_MAX)}`,
        style: 'secondary',
      })),
    },
  ];
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
