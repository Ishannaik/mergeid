import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';

import { linkCommandData, executeLink } from './link.js';
import { unlinkCommandData, executeUnlink } from './unlink.js';
import { statusCommandData, executeStatus } from './status.js';
import type { Config } from '../../config/index.js';
import type { Logger } from '../../lib/logger.js';
import type { OAuthStateStore } from '../../oauth/index.js';
import type { LinkService } from '../../services/index.js';

export const commandData = [linkCommandData, unlinkCommandData, statusCommandData];

export type CommandDeps = {
  config: Config;
  logger: Logger;
  oauthState: OAuthStateStore;
  links: LinkService;
};

export async function handleChatCommand(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  switch (interaction.commandName) {
    case 'link':
      await executeLink(interaction, deps);
      break;
    case 'unlink':
      await executeUnlink(interaction, deps);
      break;
    case 'status':
      await executeStatus(interaction, deps);
      break;
    default:
      await interaction.reply({
        content: 'Unknown command.',
        flags: MessageFlags.Ephemeral,
      });
  }
}
