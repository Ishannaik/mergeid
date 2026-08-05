import { logger } from '../lib/logger.js';
import type { RuntimeRole } from '../lib/runtime.js';

/**
 * Boots the Discord gateway client.
 *
 * No-op until #7 (client bootstrap + interaction framework). It exists now so
 * MERGEID_ROLES dispatch and graceful shutdown are testable ahead of the
 * gateway connection.
 */
export async function startBot(): Promise<RuntimeRole> {
  logger.debug('bot role: no gateway connection yet (#7)');

  return {
    name: 'bot',
    async stop() {
      // Will become client.destroy().
    },
  };
}
