/**
 * HTTP API role — OAuth callback + health (docs/architecture.md §3).
 * M1 skeleton: listen and expose /healthz only. OAuth route lands in M2.
 */

import Fastify from 'fastify';

import type { Config } from '../config/index.js';
import type { Logger } from '../lib/logger.js';

export interface ApiHandle {
  stop: () => Promise<void>;
}

export async function startApi(options: {
  config: Config;
  logger: Logger;
}): Promise<ApiHandle> {
  const { config, logger } = options;
  const app = Fastify({
    loggerInstance: logger.child({ role: 'api' }),
  });

  app.get('/healthz', async () => ({ ok: true, roles: config.MERGEID_ROLES }));

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'api listening');

  return {
    stop: async () => {
      await app.close();
    },
  };
}
