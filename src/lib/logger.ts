/**
 * Structured logging with secret redaction.
 *
 * Tokens, encryption keys, and OAuth secrets must never appear in logs
 * (docs/security-model.md §2 threat 10). Paths below cover both flat env-style
 * keys and nested objects returned by GitHub/Discord SDKs.
 */

import pino from 'pino';

import type { Config } from '../config/index.js';

const REDACT_PATHS = [
  'DISCORD_TOKEN',
  'GITHUB_CLIENT_SECRET',
  'TOKEN_ENCRYPTION_KEY',
  'DATABASE_URL',
  'REDIS_URL',
  'access_token',
  'accessToken',
  'token',
  'token_encrypted',
  'tokenEncrypted',
  'authorization',
  'Authorization',
  'code_verifier',
  'codeVerifier',
  'client_secret',
  'clientSecret',
  '*.access_token',
  '*.accessToken',
  '*.token',
  '*.authorization',
  '*.client_secret',
  '*.code_verifier',
] as const;

export type Logger = pino.Logger;

export function createLogger(config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return pino({
    level: config.LOG_LEVEL,
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[Redacted]',
    },
    base: { service: 'mergeid', env: config.NODE_ENV },
  });
}
