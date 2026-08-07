import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

import type { Logger } from '../../lib/logger.js';
import type { LinkService } from '../../services/index.js';

export const unlinkCommandData = new SlashCommandBuilder()
  .setName('unlink')
  .setDescription('Remove your GitHub link and revoke the stored token');

export async function executeUnlink(
  interaction: ChatInputCommandInteraction,
  deps: { logger: Logger; links: LinkService },
): Promise<void> {
  const result = await deps.links.unlink(interaction.user.id);
  if (!result.unlinked) {
    await interaction.reply({
      content: 'No GitHub account is linked to your Discord user.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content:
      'Unlinked. Your GitHub token was revoked and local link data was deleted. Run `/link` to connect again.',
    flags: MessageFlags.Ephemeral,
  });
}
