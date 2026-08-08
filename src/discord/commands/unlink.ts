import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

import { describeRoleOutcome, type LinkedRoleService } from '../roles.js';
import type { Logger } from '../../lib/logger.js';
import type { LinkService } from '../../services/index.js';

export const unlinkCommandData = new SlashCommandBuilder()
  .setName('unlink')
  .setDescription('Remove your GitHub link and revoke the stored token');

export async function executeUnlink(
  interaction: ChatInputCommandInteraction,
  deps: { logger: Logger; links: LinkService; linkedRoles: LinkedRoleService },
): Promise<void> {
  const result = await deps.links.unlink(interaction.user.id);
  if (!result.unlinked) {
    await interaction.reply({
      content: 'No GitHub account is linked to your Discord user.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // The link is already gone at this point. A role failure is reported, never
  // rethrown — we will not resurrect a link because Discord refused a role.
  const outcome = await deps.linkedRoles.revoke({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    member: interaction.member,
  });
  if (!outcome.ok) {
    deps.logger.warn(
      { outcome: outcome.kind, detail: outcome.detail, guildId: interaction.guildId },
      'linked role removal failed on /unlink',
    );
  }
  const note = describeRoleOutcome(outcome, 'revoke');

  await interaction.reply({
    content: [
      'Unlinked. Your GitHub token was revoked and local link data was deleted. Run `/link` to connect again.',
      ...(note ? ['', note] : []),
    ].join('\n'),
    flags: MessageFlags.Ephemeral,
  });
}
