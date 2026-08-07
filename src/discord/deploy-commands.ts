/**
 * Register slash commands with Discord (global or dev-guild).
 */

import { REST, Routes } from 'discord.js';

import { commandData } from './commands/index.js';
import type { Config } from '../config/index.js';
import type { Logger } from '../lib/logger.js';

export async function deployCommands(config: Config, logger: Logger): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
  const body = commandData.map((command) => command.toJSON());

  if (config.DISCORD_DEV_GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_DEV_GUILD_ID),
      { body },
    );
    logger.info(
      { guildId: config.DISCORD_DEV_GUILD_ID, count: body.length },
      'registered guild slash commands',
    );
    return;
  }

  await rest.put(Routes.applicationCommands(config.DISCORD_CLIENT_ID), { body });
  logger.info({ count: body.length }, 'registered global slash commands');
}
