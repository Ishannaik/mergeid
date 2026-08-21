import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';

import { linkCommandData, executeLink } from './link.js';
import { unlinkCommandData, executeUnlink } from './unlink.js';
import { statusCommandData, executeStatus } from './status.js';
import { verifyCommandData, executeVerify } from './verify.js';
import { mergeidCommandData, executeMergeid } from './mergeid.js';
import type { LinkedRoleService } from '../roles.js';
import type { Config } from '../../config/index.js';
import type { Logger } from '../../lib/logger.js';
import type { OAuthStateStore } from '../../oauth/index.js';
import type { LinkService, RulesService } from '../../services/index.js';
import type { VerificationEngine } from '../../verification/engine.js';

export const commandData = [
  linkCommandData,
  unlinkCommandData,
  statusCommandData,
  verifyCommandData,
  mergeidCommandData,
];

export type CommandDeps = {
  config: Config;
  logger: Logger;
  oauthState: OAuthStateStore;
  links: LinkService;
  linkedRoles: LinkedRoleService;
  rules: RulesService;
  engine: VerificationEngine;
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
    case 'verify':
      await executeVerify(interaction, deps);
      break;
    case 'mergeid':
      await executeMergeid(interaction, deps);
      break;
    default:
      await interaction.reply({
        content: 'Unknown command.',
        flags: MessageFlags.Ephemeral,
      });
  }
}
