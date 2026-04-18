import { SlashCommandBuilder } from 'discord.js';

export const SLASH_COMMAND_DEFINITIONS = [
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear all chat history')
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show R2 status (model, reminders, pending permissions)')
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('reminders')
    .setDescription('List active reminders')
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('memory')
    .setDescription('List recent memory entries or search by query')
    .addStringOption((o) =>
      o.setName('query').setDescription('Optional search query').setRequired(false),
    )
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('permissions')
    .setDescription('View and revoke saved "Allow always" rules')
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('heartbeat')
    .setDescription('R2 cognition layer control')
    .setDMPermission(true)
    .addSubcommand((sub) => sub.setName('status').setDescription('Show heartbeat status'))
    .addSubcommand((sub) => sub.setName('pause').setDescription('Pause heartbeat'))
    .addSubcommand((sub) => sub.setName('resume').setDescription('Resume heartbeat')),
].map((b) => b.toJSON());
