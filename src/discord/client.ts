/**
 * Discord gateway client.
 *
 * M1: role acknowledgment only. Gateway login, intents, and command wiring
 * land in M2 (docs/roadmap.md) so a dummy DISCORD_TOKEN cannot crash boot
 * during local config checks.
 */

import type { Config } from '../config/index.js';
import type { Logger } from '../lib/logger.js';

export interface BotHandle {
  stop: () => Promise<void>;
}

export async function startBot(options: {
  config: Config;
  logger: Logger;
}): Promise<BotHandle> {
  const { logger } = options;
  logger.info({ role: 'bot' }, 'bot role loaded (gateway bootstrap deferred to M2)');
  return {
    stop: async () => {
      // nothing to tear down yet
    },
  };
}
