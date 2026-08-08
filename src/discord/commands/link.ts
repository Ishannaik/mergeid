import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

import { buildAuthorizeUrl } from '../../github/index.js';
import { describeRoleOutcome, type LinkedRoleService } from '../roles.js';
import type { Config } from '../../config/index.js';
import type { Logger } from '../../lib/logger.js';
import type { OAuthStateStore } from '../../oauth/index.js';
import type { LinkService } from '../../services/index.js';

export const linkCommandData = new SlashCommandBuilder()
  .setName('link')
  .setDescription('Link your Discord account to GitHub via OAuth');

export async function executeLink(
  interaction: ChatInputCommandInteraction,
  deps: {
    config: Config;
    logger: Logger;
    oauthState: OAuthStateStore;
    links: LinkService;
    linkedRoles: LinkedRoleService;
  },
): Promise<void> {
  const { config, oauthState, links, linkedRoles } = deps;
  const discordUserId = interaction.user.id;

  const status = await links.getStatus(discordUserId);
  if (status.linked) {
    // Already-linked users are the reconciliation path: they may have joined
    // this server after linking, or an admin may have stripped the role. A
    // re-grant on an existing holder is a no-op, so this is safe to run every
    // time /link is invoked.
    const outcome = await linkedRoles.grant({
      guildId: interaction.guildId,
      userId: discordUserId,
      member: interaction.member,
    });
    const note = describeRoleOutcome(outcome, 'grant');
    if (!outcome.ok) {
      deps.logger.warn(
        { outcome: outcome.kind, detail: outcome.detail, guildId: interaction.guildId },
        'linked role reconcile failed on /link',
      );
    }

    await interaction.reply({
      content: [
        `Already linked to GitHub **@${status.githubLogin}**. Use \`/unlink\` first to switch accounts.`,
        ...(note ? ['', note] : []),
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Record the invoking guild so the OAuth callback, which has no interaction
  // of its own, knows where to apply the linked role. Null in DMs.
  const issued = await oauthState.issue({ discordUserId, guildId: interaction.guildId });
  const url = buildAuthorizeUrl(config, {
    state: issued.state,
    codeChallenge: issued.codeChallenge,
  });

  await interaction.reply({
    content: [
      'Click the link below to authorize MergeID with GitHub.',
      'This link is personal, expires in 10 minutes, and is only visible to you.',
      '',
      url,
    ].join('\n'),
    flags: MessageFlags.Ephemeral,
  });
}
