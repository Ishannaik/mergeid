/**
 * Environment loading and validation.
 *
 * Fail-fast at boot: a missing or malformed variable throws ConfigError with
 * the offending name. Secrets never leave this module as logs — callers must
 * pass the typed Config object around instead of re-reading process.env.
 *
 * Prisma 7 does not auto-load `.env`; call `loadDotenv()` before `loadConfig()`
 * in the process entrypoint (see docs/configuration.md).
 */

import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

const RUNTIME_ROLES = ['bot', 'api', 'worker'] as const;
export type RuntimeRole = (typeof RUNTIME_ROLES)[number];

/** 32-byte key encoded as 64 lowercase/uppercase hex characters. */
const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  DISCORD_DEV_GUILD_ID: z.string().min(1).optional(),

  GITHUB_CLIENT_ID: z.string().min(1, 'GITHUB_CLIENT_ID is required'),
  GITHUB_CLIENT_SECRET: z.string().min(1, 'GITHUB_CLIENT_SECRET is required'),
  GITHUB_BASE_SCOPES: z
    .string()
    .default('read:user,read:org')
    .transform((value) =>
      value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().min(1)).min(1)),

  OAUTH_REDIRECT_URI: z.url('OAUTH_REDIRECT_URI must be a valid URL'),
  PUBLIC_BASE_URL: z.url('PUBLIC_BASE_URL must be a valid URL'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /**
   * Optional in single-process local setups per docs/configuration.md.
   * OAuth state and BullMQ still need Redis at runtime when those roles start.
   */
  REDIS_URL: z.string().min(1).optional(),

  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(HEX_32_BYTES, 'TOKEN_ENCRYPTION_KEY must be 32 bytes hex (64 hex chars)'),
  /** Key version embedded in ciphertext; bump when rotating TOKEN_ENCRYPTION_KEY. */
  TOKEN_ENCRYPTION_KEY_VERSION: z.string().min(1).default('1'),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  MERGEID_ROLES: z
    .string()
    .default('bot,api,worker')
    .transform((value) =>
      value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(z.enum(RUNTIME_ROLES))
        .min(1, 'MERGEID_ROLES must include at least one role')
        .refine((roles) => new Set(roles).size === roles.length, {
          message: 'MERGEID_ROLES must not contain duplicates',
        }),
    ),
});

export type Config = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parse and validate process environment (or an injected map for tests).
 * Returns a typed Config; never mutates the input.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'config';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    throw new ConfigError(`Invalid environment configuration — ${details}`);
  }
  return result.data;
}

/**
 * Load `.env` into process.env when present. Safe to call multiple times.
 * Does nothing if the file is missing (production often injects env directly).
 */
export function loadDotenv(envPath = '.env'): void {
  // dotenv never overrides existing process.env keys — CI/prod wins over file.
  dotenvConfig({ path: envPath, quiet: true });
}
