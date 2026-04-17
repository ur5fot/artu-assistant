import { EmbedBuilder } from 'discord.js';
import type { ToolCall } from '@r2/shared';

export type ToolCallState = 'running' | 'progress' | 'done' | 'error';

export const SILENT_TOOLS: readonly string[] = ['memory_search', 'memory_save'];

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

  if (opts.state === 'running') {
    embed
      .setTitle(`🔧 ${opts.toolCall.name}`)
      .setDescription('running…')
      .setColor(COLORS.gray);
    return embed;
  }

  // Other states added in a later task.
  return embed;
}
