import { logger } from '../lib/logger.js';
import type { RuntimeRole } from '../lib/runtime.js';

/**
 * Boots the BullMQ sync worker.
 *
 * No-op until #28 (worker + queue wiring). When it lands, `stop()` must let
 * in-flight jobs finish rather than killing them mid-verification — a job
 * interrupted between the GitHub check and the Discord role write is the one
 * that leaves state inconsistent.
 *
 * Not `async`: there is nothing to await until that wiring exists. The
 * Promise-returning signature is the contract, so callers are unaffected.
 */
export function startWorker(): Promise<RuntimeRole> {
  logger.debug('worker role: no queue wiring yet (#28)');

  return Promise.resolve({
    name: 'worker',
    async stop() {
      // Will become worker.close() — drains in-flight jobs.
    },
  });
}
