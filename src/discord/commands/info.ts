import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';

import type { DiscordCommand } from './index.js';

const REPOSITORY_URL = 'https://github.com/Ishannaik/mergeid';
const SUPPORT_DISCORD_URL = 'https://discord.gg/xpgQ2WxRNJ';

const INFO_EMBED = new EmbedBuilder()
  .setColor(0x5865f2)
  .setTitle('MergeID')
  .setURL(REPOSITORY_URL)
  .setDescription(
    'MergeID is a privacy-first Discord bot that links Discord members to GitHub accounts, verifies organization, repository, and team membership, and assigns Discord roles.',
  )
  .addFields({
    name: 'GitHub',
    value: `[View MergeID on GitHub](${REPOSITORY_URL})`,
    inline: false,
  })
  .addFields({
    name: 'Support Discord',
    value: `[Join the MergeID support server](${SUPPORT_DISCORD_URL})`,
    inline: false,
  })
  .toJSON();

export const infoCommand = {
  data: new SlashCommandBuilder()
    .setName('info')
    .setDescription('Show information about MergeID and its GitHub repository.')
    .toJSON(),

  async execute(interaction) {
    await interaction.editReply({ embeds: [INFO_EMBED] });
  },
} satisfies DiscordCommand;
