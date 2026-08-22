import { describe, expect, it, vi } from 'vitest';

import { computeBackoff, createRateBudget, DEFAULT_BUDGET } from '../../src/sync/rate-budget.js';
import { makeLogger } from '../discord/fixtures.js';

describe('computeBackoff', () => {
  it('stays within [0, base) for attempt 0 (full jitter)', () => {
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoff(0, 30_000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(30_000);
    }
  });

  it('grows exponentially but never exceeds the cap', () => {
    // attempt 5 → min(30000·32, 900000)=900000; sample many draws.
    for (let i = 0; i < 100; i++) {
      const delay = computeBackoff(5, 30_000, 900_000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(900_000);
    }
    // attempt 20 is far past the cap: always below maxMs.
    expect(computeBackoff(20, 30_000, 60_000)).toBeLessThan(60_000);
  });

  it('never returns a negative delay', () => {
    expect(computeBackoff(-3)).toBeGreaterThanOrEqual(0);
  });
});

describe('createRateBudget — fail-open without Redis', () => {
  it('allows everything when redis is null', async () => {
    const budget = createRateBudget(null, makeLogger());
    const decision = await budget.tryAcquire();
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(DEFAULT_BUDGET.capacity);
  });

  it('fails open when redis errors mid-flight', async () => {
    const failingRedis = {
      eval: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as never as Parameters<typeof createRateBudget>[0];
    const logger = makeLogger();
    const budget = createRateBudget(failingRedis, logger);

    const decision = await budget.tryAcquire();
    expect(decision.allowed).toBe(true);
    // Warns once, not on every call.
    await budget.tryAcquire();
    await budget.tryAcquire();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('denies with a retry window when the bucket is empty', async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue(-1),
    } as never as Parameters<typeof createRateBudget>[0];
    const budget = createRateBudget(redis, makeLogger());

    const decision = await budget.tryAcquire(1);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBeGreaterThan(0);
    expect(decision.retryAfterMs).toBeLessThanOrEqual(1250);
  });

  it('passes capacity/refill/key/cost to the lua script', async () => {
    const evalMock = vi.fn().mockResolvedValue(89_000); // 89 tokens remaining
    const redis = { eval: evalMock } as never as Parameters<typeof createRateBudget>[0];
    const budget = createRateBudget(redis, makeLogger(), {
      capacity: 90,
      refillPerSecond: 1.5,
      key: 'test:budget',
    });

    const decision = await budget.tryAcquire(2);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(89);
    expect(evalMock).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'test:budget',
      '90',
      '1500',
      expect.stringMatching(/^\d+$/),
      '2',
    );
  });
});
