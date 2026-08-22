/**
 * Structured logging with secret redaction.
 *
 * Two consumers exist:
 *  - the singleton `logger` for entrypoint-level boot logs (main line)
 *  - `createLogger(config)` for DI-style services (M2/M3 services)
 *
 * Tokens, encryption keys, and OAuth secrets must never appear in logs
 * (docs/security-model.md §2 threat 10).
 */

import pino from 'pino';

import type { Config } from '../config/index.js';

// Redaction paths are intentionally minimal on the singleton — the full set is
// derived from the real field names once tokens actually flow (#36).
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['req.headers.authorization', '*.token', '*.accessToken', '*.clientSecret'],
    censor: '[redacted]',
  },
});

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

/** Structural pino type shared by services that receive a logger via DI. */
export type Logger = pino.Logger;

/** Config-driven logger with full redaction and service base fields. */
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
