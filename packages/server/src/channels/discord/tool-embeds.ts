import { EmbedBuilder } from 'discord.js';
import type { ToolCall } from '@r2/shared';

export type ToolCallState = 'running' | 'progress' | 'done' | 'error';

// 'router' is a synthetic tool emitted by the LLM router on ollama→claude
// escalation. The escalation is already signalled to the user by the
// `🔵 claude` prefix on the next assistant message; the embed would be
// redundant noise.
export const SILENT_TOOLS: readonly string[] = ['memory_search', 'memory_save', 'router'];

const COLORS = {
  gray: 0x9aa0a6,
  green: 0x22c55e,
  red: 0xef4444,
};

const DESCRIPTION_MAX = 3800;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export interface BuildToolCallEmbedOpts {
  state: ToolCallState;
  toolCall: ToolCall;
  progress?: string;
}

export function buildToolCallEmbed(opts: BuildToolCallEmbedOpts): EmbedBuilder | null {
  if (SILENT_TOOLS.includes(opts.toolCall.name)) return null;

  const embed = new EmbedBuilder();
  const isCodeTask = opts.toolCall.name === 'code_task';
  const taskText =
    typeof opts.toolCall.input.task === 'string' ? opts.toolCall.input.task : '';

  const iconByState: Record<ToolCallState, string> = {
    running: '🔧',
    progress: '🔧',
    done: '✅',
    error: '❌',
  };
  embed.setTitle(`${iconByState[opts.state]} ${opts.toolCall.name}`);

  const colorByState: Record<ToolCallState, number> = {
    running: COLORS.gray,
    progress: COLORS.gray,
    done: COLORS.green,
    error: COLORS.red,
  };
  embed.setColor(colorByState[opts.state]);

  if (opts.state === 'running') {
    embed.setDescription(
      isCodeTask && taskText
        ? truncate(`Task: "${taskText}"`, DESCRIPTION_MAX)
        : 'running…',
    );
    return embed;
  }

  if (opts.state === 'progress') {
    embed.setDescription(truncate(opts.progress ?? 'working…', DESCRIPTION_MAX));
    return embed;
  }

  if (opts.state === 'error') {
    const msg = opts.toolCall.result?.error ?? 'Unknown error';
    embed.setDescription(truncate(msg, DESCRIPTION_MAX));
    return embed;
  }

  if (isCodeTask) {
    const data = (opts.toolCall.result?.data ?? {}) as {
      commit?: string;
      mode?: string;
      files?: Array<{ path: string; added: number; removed: number }>;
      durationMs?: number;
    };
    if (taskText) {
      embed.addFields({ name: 'Task', value: truncate(`"${taskText}"`, 1024) });
    }
    if (data.commit) {
      const short = data.commit.slice(0, 7);
      const value = data.mode ? `\`${short}\` (${data.mode})` : `\`${short}\``;
      embed.addFields({ name: 'Commit', value });
    }
    if (data.files && data.files.length > 0) {
      const lines = data.files
        .slice(0, 15)
        .map((f) => `\`${f.path}\` +${f.added} -${f.removed}`);
      if (data.files.length > 15) lines.push(`…and ${data.files.length - 15} more`);
      embed.addFields({ name: 'Files', value: truncate(lines.join('\n'), 1024) });
    }
    if (data.durationMs) {
      const sec = Math.round(data.durationMs / 1000);
      const mins = Math.floor(sec / 60);
      const secs = sec % 60;
      embed.setFooter({ text: `duration: ${mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}` });
    }
    if ((embed.data.fields ?? []).length === 0) {
      embed.setDescription('done');
    }
    return embed;
  }

  const display = opts.toolCall.result?.display?.content;
  embed.setDescription(truncate(display ?? 'done', 500));
  return embed;
}

const DISCORD_UPLOAD_LIMIT_BYTES = 24 * 1024 * 1024;

export interface DiffAttachment {
  attachment: Buffer;
  name: string;
}

export interface DiffAttachmentOversize {
  oversize: true;
}

export function buildDiffAttachment(opts: {
  callId: string;
  fullDiff: string;
  commit?: string;
}): DiffAttachment | DiffAttachmentOversize | null {
  if (!opts.fullDiff) return null;
  const buf = Buffer.from(opts.fullDiff, 'utf-8');
  if (buf.byteLength > DISCORD_UPLOAD_LIMIT_BYTES) {
    return { oversize: true };
  }
  const nameKey = opts.commit ? opts.commit.slice(0, 7) : opts.callId;
  return {
    attachment: buf,
    name: `code_task_${nameKey}.diff`,
  };
}
