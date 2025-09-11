import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const token = process.env.DISCORD_TOKEN!;
const clientId = process.env.CLIENT_ID!;
const guildId = process.env.GUILD_ID!;

if (!token || !clientId || !guildId) {
  throw new Error('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env');
}

const commands = [
  new SlashCommandBuilder()
    .setName('social_activity')
    .setDescription('Show message counts for members with the Social Member role in THIS channel.')
    .addIntegerOption(opt =>
      opt.setName('days')
        .setDescription('How many days back to count (1–90)')
        .setMinValue(1)
        .setMaxValue(90)
    )
    .addIntegerOption(opt =>
      opt.setName('top')
        .setDescription('How many users to display (1–50)')
        .setMinValue(1)
        .setMaxValue(50)
    )
    .addBooleanOption(opt =>
      opt.setName('ephemeral')
        .setDescription('Show only to you (default: false)')
    )
    .toJSON()
];

(async () => {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log('✅ Slash command registered in guild:', guildId);
})();
