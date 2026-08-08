/**
 * Discord gateway client — intents Guilds only; slash-command UX is ephemeral.
 */

import { Client, GatewayIntentBits, Events } from 'discord.js';

import { deployCommands } from './deploy-commands.js';
import { registerInteractionHandler } from './events/interactionCreate.js';
import type { Config } from '../config/index.js';
import type { Logger } from '../lib/logger.js';
import type { OAuthStateStore } from '../oauth/index.js';
import type { LinkService } from '../services/index.js';
import type { LinkedRoleService } from './roles.js';

export interface BotHandle {
  client: Client;
  stop: () => Promise<void>;
}

export async function startBot(options: {
  config: Config;
  logger: Logger;
  oauthState: OAuthStateStore;
  linkedRoles: LinkedRoleService;
  links: LinkService;
}): Promise<BotHandle> {
  const { config, logger, oauthState, links, linkedRoles } = options;
  const log = logger.child({ role: 'bot' });

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  registerInteractionHandler(client, { config, logger: log, oauthState, links, linkedRoles });

  client.once(Events.ClientReady, (readyClient) => {
    log.info({ user: readyClient.user.tag }, 'discord gateway ready');
  });

  client.on(Events.Error, (err) => {
    log.error({ err }, 'discord client error');
  });

  await deployCommands(config, log);
  await client.login(config.DISCORD_TOKEN);

  return {
    client,
    stop: async () => {
      client.destroy();
    },
  };
}
