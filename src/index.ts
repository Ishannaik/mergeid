/**
 * Process entrypoint.
 *
 * Boots runtime roles listed in MERGEID_ROLES (docs/architecture.md §4).
 * Phase-1 MVP runs bot + api + worker in one process; later deploys split them.
 */

import { loadConfig, loadDotenv } from './config/index.js';
import { createLogger } from './lib/logger.js';
import type { RuntimeRole } from './config/index.js';

async function main(): Promise<void> {
  loadDotenv();
  const config = loadConfig();
  const logger = createLogger(config);

  const roles = new Set<RuntimeRole>(config.MERGEID_ROLES);
  logger.info({ roles: [...roles] }, 'starting mergeid');

  const shutdownHandlers: Array<() => Promise<void>> = [];

  if (roles.has('api')) {
    const { startApi } = await import('./api/server.js');
    const api = await startApi({ config, logger });
    shutdownHandlers.push(api.stop);
  }

  if (roles.has('bot')) {
    const { startBot } = await import('./discord/client.js');
    const bot = await startBot({ config, logger });
    shutdownHandlers.push(bot.stop);
  }

  if (roles.has('worker')) {
    // Sync worker lands in M5 — acknowledge the role so misconfigured deploys
    // are visible in logs without crashing the process.
    logger.warn('worker role requested but not implemented until M5; ignoring');
  }

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
  // Use console here — logger may not exist if config validation failed.
  console.error('fatal: failed to start mergeid', err);
  process.exit(1);
});
