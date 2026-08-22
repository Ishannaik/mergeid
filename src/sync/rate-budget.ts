/**
 * GitHub API rate budgeter with exponential backoff + jitter (M5 #3).
 *
 * The verification engine calls GitHub with each member's own token, so the
 * binding limit is per-user (5000/h) rather than one shared app budget — but a
 * sync run touching hundreds of members still needs to behave when tokens DO
 * hit their limit: slow down, back off with jitter, and never stampede.
 *
 * Two pieces:
 *  - `RateBudget`: token-bucket over Redis for cross-process budgets
 *    (`MERGEID_RATE_*` env). Best-effort: if Redis is down we fail OPEN,
 *    because blocking verification entirely is worse than an occasional
 *    burst. GitHub's own secondary limits remain the hard stop.
 *  - `computeBackoff`: pure exponential backoff + full jitter, used by the
 *    BullMQ job template (attempts/backoff) and by callers that retry inline.
 *
 * No network I/O here — this module computes delays and checks buckets; the
 * callers decide what to do.
 */

import type { Redis } from 'ioredis';

import type { Logger } from '../lib/logger.js';

/** Bucket parameters: default allows ~90 checks/min sustained per process. */
export interface RateBudgetOptions {
  /** Max tokens in the bucket. */
  capacity: number;
  /** Tokens refilled per second. */
  refillPerSecond: number;
  /** Redis key. One bucket per logical budget. */
  key: string;
}

export const DEFAULT_BUDGET: RateBudgetOptions = {
  capacity: 90,
  refillPerSecond: 1.5,
  key: 'mergeid:ratebudget:github',
};

/** Result of asking the bucket for one token. */
export interface BudgetDecision {
  allowed: boolean;
  /** Milliseconds to wait before retrying when not allowed. */
  retryAfterMs: number;
  /** Tokens remaining at decision time (for metrics). */
  remaining: number;
}

/**
 * Lua script: atomic token bucket.
 *
 * KEYS[1] = bucket key; ARGV: capacity, refill*1000 (milli-tokens/s), now_ms,
 * cost. Stores [tokens*1000, last_refill_ms]. Returns remaining*1000 or -1.
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_milli = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity * 1000
local ts = tonumber(state[2]) or now
if tokens < capacity * 1000 then
  local elapsed = math.max(now - ts, 0)
  tokens = math.min(tokens + math.floor(elapsed * refill_milli / 1000), capacity * 1000)
end
if tokens >= cost * 1000 then
  tokens = tokens - cost * 1000
  redis.call('HSET', key, 'tokens', tokens, 'ts', now)
  redis.call('PEXPIRE', key, 7200000)
  return tokens
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
return -1
`;

/**
 * Creates a best-effort distributed token bucket over Redis.
 *
 * Fail-open policy: any Redis error logs once and allows the call. A rate
 * limiter that can take down verification is worse than no limiter — GitHub's
 * real 403/429s are handled by the engine's ERROR path regardless.
 */
export function createRateBudget(
  redis: Redis | null,
  logger: Logger,
  options: RateBudgetOptions = DEFAULT_BUDGET,
) {
  let warnedDown = false;

  async function tryAcquire(cost = 1): Promise<BudgetDecision> {
    if (!redis) {
      return { allowed: true, retryAfterMs: 0, remaining: options.capacity };
    }
    try {
      const result = (await redis.eval(
        TOKEN_BUCKET_LUA,
        1,
        options.key,
        String(options.capacity),
        String(Math.round(options.refillPerSecond * 1000)),
        String(Date.now()),
        String(cost),
      )) as number;
      warnedDown = false;
      const remaining = Math.floor(result / 1000);
      if (result < 0) {
        // Empty: wait long enough for one token to refill (plus slack).
        const retryAfterMs = Math.ceil((1000 * cost) / options.refillPerSecond) + 250;
        return { allowed: false, retryAfterMs, remaining };
      }
      return { allowed: true, retryAfterMs: 0, remaining };
    } catch (err) {
      if (!warnedDown) {
        logger.warn({ err }, 'rate budget store unavailable — failing open');
        warnedDown = true;
      }
      return { allowed: true, retryAfterMs: 0, remaining: options.capacity };
    }
  }

  return { tryAcquire };
}

/**
 * Exponential backoff with full jitter (AWS-style).
 *
 * attempt 0 → [0, base); attempt n → [0, min(base·2^n, max)). Full jitter
 * beats equal jitter here: sync jobs for unrelated guilds should spread as
 * widely as possible after a shared failure (e.g. GitHub brownout).
 */
export function computeBackoff(attempt: number, baseMs = 30_000, maxMs = 15 * 60_000): number {
  const ceiling = Math.min(baseMs * 2 ** Math.max(attempt, 0), maxMs);
  return Math.floor(Math.random() * ceiling);
}
