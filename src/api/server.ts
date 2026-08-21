import { logger } from '../lib/logger.js';
import type { RuntimeRole } from '../lib/runtime.js';

/**
 * Boots the Fastify HTTP server.
 *
 * No-op until #10 (Fastify server + GET /oauth/callback). Deliberately does not
 * bind PORT yet: binding a port that serves nothing would make an unfinished
 * deployment look healthy to a load balancer.
 *
 * Not `async`: there is nothing to await until that listener exists. The
 * Promise-returning signature is the contract, so callers are unaffected.
 */
export function startApi(): Promise<RuntimeRole> {
  logger.debug('api role: no listener bound yet (#10)');

  return Promise.resolve({
    name: 'api',
    async stop() {
      // Will become server.close().
    },
  });
}
