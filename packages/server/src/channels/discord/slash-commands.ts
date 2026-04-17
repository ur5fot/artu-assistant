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
].map((b) => b.toJSON());
