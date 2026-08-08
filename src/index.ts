/**
 * Process entrypoint.
 *
 * Boots runtime roles listed in MERGEID_ROLES (docs/architecture.md §4).
 * Phase-1 MVP runs bot + api (+ deferred worker) in one process.
 */

import { loadConfig, loadDotenv } from './config/index.js';
import { createLogger } from './lib/logger.js';
import { createPrismaClient } from './lib/prisma.js';
import { createRedisClient } from './lib/redis.js';
import { createRedisOAuthStateStore } from './oauth/index.js';
import { createLinkService } from './services/index.js';
import { createLinkedRoleService } from './discord/roles.js';
import type { RuntimeRole } from './config/index.js';
import type { Client } from 'discord.js';

async function main(): Promise<void> {
  loadDotenv();
  const config = loadConfig();
  const logger = createLogger(config);

  const roles = new Set<RuntimeRole>(config.MERGEID_ROLES);
  logger.info({ roles: [...roles] }, 'starting mergeid');

  const needsDataPlane = roles.has('api') || roles.has('bot');
  const prisma = needsDataPlane ? createPrismaClient(config) : null;
  const redis = needsDataPlane ? createRedisClient(config, logger) : null;
  const oauthState = redis ? createRedisOAuthStateStore(redis) : null;
  const links = prisma && logger ? createLinkService({ prisma, config, logger }) : null;

  // Late-bound: the api role starts before the gateway client exists, and the
  // OAuth callback (api) is what applies the role after a link completes. The
  // holder is assigned when the bot role boots below; a link cannot complete
  // before then, because the authorize URL is handed out by the bot itself.
  let botClient: Client | null = null;
  const linkedRoles = createLinkedRoleService({
    config,
    logger,
    getClient: () => botClient,
  });

  if (config.MERGEID_LINKED_ROLE_ID && !roles.has('bot')) {
    logger.warn(
      { roleId: config.MERGEID_LINKED_ROLE_ID },
      'MERGEID_LINKED_ROLE_ID is set but this process does not run the bot role; ' +
        'role grants will be skipped here — run the bot and api roles together, ' +
        'or the linked role will never be applied',
    );
  }

  const shutdownHandlers: Array<() => Promise<void>> = [];

  if (roles.has('api')) {
    if (!oauthState || !links) {
      throw new Error('api role requires database and redis');
    }
    const { startApi } = await import('./api/server.js');
    const api = await startApi({ config, logger, oauthState, links, linkedRoles });
    shutdownHandlers.push(api.stop);
  }

  if (roles.has('bot')) {
    if (!oauthState || !links) {
      throw new Error('bot role requires database and redis');
    }
    const { startBot } = await import('./discord/client.js');
    const bot = await startBot({ config, logger, oauthState, links, linkedRoles });
    botClient = bot.client;
    shutdownHandlers.push(bot.stop);
  }

  if (roles.has('worker')) {
    logger.warn('worker role requested but not implemented until M5; ignoring');
  }

  shutdownHandlers.push(async () => {
    if (redis) {
      redis.disconnect();
    }
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    for (const stop of shutdownHandlers.reverse()) {
      try {
        await stop();
      } catch (err) {
        logger.error({ err }, 'error during shutdown');
      }
    }
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((err: unknown) => {
  console.error('fatal: failed to start mergeid', err);
  process.exit(1);
});
