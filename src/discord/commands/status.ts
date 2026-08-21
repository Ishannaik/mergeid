import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

import type { LinkService } from '../../services/index.js';

export const statusCommandData = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Show your GitHub link status and granted scopes');

export async function executeStatus(
  interaction: ChatInputCommandInteraction,
  deps: { links: LinkService },
): Promise<void> {
  const status = await deps.links.getStatus(interaction.user.id);
  if (!status.linked) {
    await interaction.reply({
      content: 'Not linked. Run `/link` to connect your GitHub account.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const scopes = status.scopes?.join(', ') || '(none recorded)';
  const linkedAt = status.linkedAt?.toISOString() ?? 'unknown';
  const lastVerified = status.lastVerifiedAt?.toISOString() ?? 'never';

  await interaction.reply({
    content: [
      `**GitHub:** @${status.githubLogin} (\`${status.githubUserId}\`)`,
      `**Scopes:** ${scopes}`,
      `**Linked at:** ${linkedAt}`,
      `**Last verified:** ${lastVerified}`,
    ].join('\n'),
    flags: MessageFlags.Ephemeral,
  });
}
