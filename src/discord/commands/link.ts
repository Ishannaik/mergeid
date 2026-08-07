import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

import { buildAuthorizeUrl } from '../../github/index.js';
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
  },
): Promise<void> {
  const { config, oauthState, links } = deps;
  const discordUserId = interaction.user.id;

  const status = await links.getStatus(discordUserId);
  if (status.linked) {
    await interaction.reply({
      content: `Already linked to GitHub **@${status.githubLogin}**. Use \`/unlink\` first to switch accounts.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const issued = await oauthState.issue({ discordUserId });
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
