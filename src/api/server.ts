/**
 * HTTP API role — Fastify server hosting /healthz and /oauth/callback.
 */

import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';

import { registerOAuthRoutes } from './routes/oauth.js';
import type { RuntimeRole } from '../lib/runtime.js';
import type { Config } from '../config/index.js';
import type { Logger } from '../lib/logger.js';
import type { OAuthStateStore } from '../oauth/index.js';
import type { LinkService } from '../services/index.js';
import type { VerificationEngine } from '../verification/engine.js';
import type { LinkedRoleService } from '../discord/roles.js';
import type { Redis } from 'ioredis';

/**
 * Boots the API role: binds PORT and serves health + OAuth callback routes.
 *
 * Uses Fastify's own logger adapter rather than passing the pino instance
 * directly — avoids FastifyBaseLogger vs pino.Logger structural mismatches.
 */
export async function startApi(options: {
  config: Config;
  logger: Logger;
  oauthState: OAuthStateStore;
  links: LinkService;
  linkedRoles: LinkedRoleService;
  engine: VerificationEngine | null;
  redis: Redis;
}): Promise<RuntimeRole> {
  const { config, logger, oauthState, links, linkedRoles, engine, redis } = options;
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: ['req.headers.authorization', 'access_token', 'code_verifier'],
        censor: '[Redacted]',
      },
    },
  });

  await app.register(rateLimit, {
    global: false,
    redis,
    nameSpace: 'mergeid:rate-limit:',
  });

  app.get('/healthz', () => Promise.resolve({ ok: true }));
  registerOAuthRoutes(app, { config, logger, oauthState, links, linkedRoles, engine });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'api listening');

  return {
    name: 'api',
    stop: async () => {
      await app.close();
    },
  };
}
