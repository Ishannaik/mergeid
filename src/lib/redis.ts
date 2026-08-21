/**
 * Redis client factory.
 *
 * Used for OAuth state (M2), rate budgets and BullMQ (M5). Required when the
 * bot or api role runs — configuration.md allows REDIS_URL to be optional at
 * the env layer, but account linking cannot proceed without it.
 */

import { Redis } from 'ioredis';

import { AppError } from './errors.js';
import type { Config } from '../config/index.js';
import type { Logger } from './logger.js';

export function createRedisClient(config: Config, logger: Logger): Redis {
  if (!config.REDIS_URL) {
    throw new AppError('REDIS_URL is required for bot/api roles (OAuth state store)', {
      code: 'redis_url_missing',
      statusCode: 500,
      expose: false,
    });
  }

  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  redis.on('error', (err: Error) => {
    logger.error({ err }, 'redis error');
  });

  return redis;
}
