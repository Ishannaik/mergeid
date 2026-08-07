/**
 * HTTP API role — OAuth callback + health (docs/architecture.md §3).
 */

import Fastify from 'fastify';

import { registerOAuthRoutes } from './routes/oauth.js';
import type { Config } from '../config/index.js';
import type { Logger } from '../lib/logger.js';
import type { OAuthStateStore } from '../oauth/index.js';
import type { LinkService } from '../services/index.js';

export interface ApiHandle {
  stop: () => Promise<void>;
}

export async function startApi(options: {
  config: Config;
  logger: Logger;
  oauthState: OAuthStateStore;
  links: LinkService;
}): Promise<ApiHandle> {
  const { config, logger, oauthState, links } = options;
  // Use Fastify's own logger adapter rather than passing the pino instance
  // directly — avoids FastifyBaseLogger vs pino.Logger structural mismatches.
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: ['req.headers.authorization', 'access_token', 'code_verifier'],
        censor: '[Redacted]',
      },
    },
  });

  app.get('/healthz', async () => ({ ok: true, roles: config.MERGEID_ROLES }));
  registerOAuthRoutes(app, { config, logger, oauthState, links });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'api listening');

  return {
    stop: async () => {
      await app.close();
    },
  };
}
