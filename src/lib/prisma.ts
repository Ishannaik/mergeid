/**
 * Prisma client singleton.
 *
 * Prisma 7 requires a driver adapter — we use @prisma/adapter-pg against
 * node-postgres. DATABASE_URL is already validated by src/config before this
 * module is constructed at boot.
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

import type { Config } from '../config/index.js';

export type { PrismaClient };

export function createPrismaClient(config: Pick<Config, 'DATABASE_URL'>): PrismaClient {
  const adapter = new PrismaPg({ connectionString: config.DATABASE_URL });
  return new PrismaClient({ adapter });
}
