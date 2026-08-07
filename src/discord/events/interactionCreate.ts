/**
 * interactionCreate handler — routes chat input commands.
 */

import { Events, MessageFlags } from 'discord.js';
import type { Client } from 'discord.js';

import { handleChatCommand, type CommandDeps } from '../commands/index.js';
import type { Logger } from '../../lib/logger.js';

export function registerInteractionHandler(
  client: Client,
  deps: CommandDeps & { logger: Logger },
): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      await handleChatCommand(interaction, deps);
    } catch (err) {
      deps.logger.error({ err, command: interaction.commandName }, 'command failed');
      const payload = {
        content: 'Something went wrong running that command. Try again in a moment.',
        flags: MessageFlags.Ephemeral as number,
      };
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(payload);
        } else {
          await interaction.reply(payload);
        }
      } catch (replyErr) {
        deps.logger.error({ err: replyErr }, 'failed to send error reply');
      }
    }
  });
}
