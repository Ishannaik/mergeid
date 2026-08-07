/**
 * OAuth `state` store — single-use nonce bound to the Discord user + PKCE verifier.
 *
 * Redis key: `oauth:state:{state}` → JSON `{ discordUserId, codeVerifier }`
 * with TTL 600s and single-use via GETDEL (docs/oauth-flow.md).
 *
 * A memory backend is provided for unit tests (injectable clock for TTL).
 */

import type { Redis } from 'ioredis';

import { createCodeChallenge, generateCodeVerifier, generateOAuthState } from './pkce.js';

export const OAUTH_STATE_TTL_SECONDS = 600;
const KEY_PREFIX = 'oauth:state:';

export interface OAuthStateRecord {
  discordUserId: string;
  codeVerifier: string;
}

export interface IssuedOAuthState {
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthStateError';
  }
}

export interface OAuthStateStore {
  issue(input: { discordUserId: string; codeVerifier?: string }): Promise<IssuedOAuthState>;
  consume(state: string): Promise<OAuthStateRecord>;
}

interface MemoryEntry {
  record: OAuthStateRecord;
  expiresAtMs: number;
}

export function createMemoryOAuthStateStore(options?: {
  ttlSeconds?: number;
  now?: () => number;
}): OAuthStateStore {
  const ttlSeconds = options?.ttlSeconds ?? OAUTH_STATE_TTL_SECONDS;
  const now = options?.now ?? Date.now;
  const map = new Map<string, MemoryEntry>();

  return {
    async issue(input) {
      const codeVerifier = input.codeVerifier ?? generateCodeVerifier();
      const state = generateOAuthState();
      map.set(state, {
        record: { discordUserId: input.discordUserId, codeVerifier },
        expiresAtMs: now() + ttlSeconds * 1000,
      });
      return {
        state,
        codeChallenge: createCodeChallenge(codeVerifier),
        codeChallengeMethod: 'S256',
      };
    },

    async consume(state) {
      const entry = map.get(state);
      map.delete(state);
      if (!entry) {
        throw new OAuthStateError('OAuth state is invalid, expired, or already used');
      }
      if (now() > entry.expiresAtMs) {
        throw new OAuthStateError('OAuth state is invalid, expired, or already used');
      }
      return entry.record;
    },
  };
}

export function createRedisOAuthStateStore(redis: Redis): OAuthStateStore {
  return {
    async issue(input) {
      const codeVerifier = input.codeVerifier ?? generateCodeVerifier();
      const state = generateOAuthState();
      const key = `${KEY_PREFIX}${state}`;
      const payload = JSON.stringify({
        discordUserId: input.discordUserId,
        codeVerifier,
      } satisfies OAuthStateRecord);

      // NX + EX: refuse overwrite if a collision ever happened; TTL caps volume.
      const ok = await redis.set(key, payload, 'EX', OAUTH_STATE_TTL_SECONDS, 'NX');
      if (ok !== 'OK') {
        throw new OAuthStateError('failed to persist OAuth state');
      }

      return {
        state,
        codeChallenge: createCodeChallenge(codeVerifier),
        codeChallengeMethod: 'S256',
      };
    },

    async consume(state) {
      const key = `${KEY_PREFIX}${state}`;
      const raw = await redis.getdel(key);
      if (!raw) {
        throw new OAuthStateError('OAuth state is invalid, expired, or already used');
      }
      const parsed = JSON.parse(raw) as OAuthStateRecord;
      if (!parsed.discordUserId || !parsed.codeVerifier) {
        throw new OAuthStateError('OAuth state payload is corrupt');
      }
      return parsed;
    },
  };
}
