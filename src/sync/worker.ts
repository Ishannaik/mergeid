/**
 * The sync worker role — BullMQ consumer for rule re-verification (M5).
 *
 * Each job re-runs the verification engine for every linked member of one
 * rule's guild, scoped to that rule's cadence. Failures retry with
 * exponential backoff + jitter (set on the job template in scheduler.ts);
 * after `attempts` are exhausted the job lands in the failed set where
 * `/mergeid sync status` surfaces it.
 *
 * Shutdown drains: `worker.close()` lets in-flight jobs finish. Killing a job
 * between the GitHub check and the Discord role write is exactly how role
 * state diverges — so stop() waits rather than aborts (RuntimeRole contract).
 */

import { Worker } from 'bullmq';

import type { Job } from 'bullmq';

import { SYNC_QUEUE_NAME, syncQueueOptions, type RuleSyncJob } from './scheduler.js';
import type { RuntimeRole } from '../lib/runtime.js';
import type { PrismaClient } from '../lib/prisma.js';
import type { Logger } from '../lib/logger.js';
import type { VerificationEngine } from '../verification/engine.js';
import type { Config } from '../config/index.js';
import { SyncStatus } from '../generated/prisma/enums.js';

/** Result recorded per SyncRun row and returned to BullMQ as the job result. */
export interface RuleSyncResult {
  guildId: string;
  ruleId: string;
  checked: number;
  passed: number;
  failed: number;
  errored: number;
  granted: number;
  revoked: number;
}

/** Dependencies for `createSyncWorker` — all injectable for tests. */
export interface SyncWorkerDeps {
  prisma: PrismaClient;
  engine: VerificationEngine;
  config: Config;
  logger: Logger;
}

/** Per-guild cap on members verified per rule per run — bounds API spend. */
const MAX_MEMBERS_PER_RUN = 500;

/**
 * Verifies every linked member of one guild against one enabled rule.
 *
 * The engine verifies a whole user at a time; this loop maps rule-scoped jobs
 * onto user-scoped runs by filtering each user's summary to the rule that
 * scheduled the job. Membership results for other rules still refresh — that
 * is a feature, not waste: they were due anyway.
 */
async function verifyRuleMembers(
  job: Job<RuleSyncJob>,
  deps: SyncWorkerDeps,
): Promise<RuleSyncResult | null> {
  const { prisma, engine, logger } = deps;
  const { guildId, ruleId } = job.data;

  const rule = await prisma.verificationRule.findFirst({
    where: { id: ruleId, guildId, enabled: true },
  });
  if (!rule) {
    // Schedule outlived its rule (deleted/disabled). Nothing to do; the
    // scheduler entry is pruned on next reconcile. No SyncRun row — there was
    // no run.
    logger.debug({ ruleId, guildId }, 'sync job skipped: rule missing or disabled');
    return null;
  }

  // Members currently holding or recently checked against this rule — anyone
  // with a membership result row is "known to this rule". New links surface
  // through the OAuth callback path, not the worker.
  const results = await prisma.membershipResult.findMany({
    where: { ruleId },
    select: { link: { select: { discordUserId: true } } },
    take: MAX_MEMBERS_PER_RUN,
    orderBy: { checkedAt: 'asc' },
  });

  const summary = { checked: 0, passed: 0, failed: 0, errored: 0, granted: 0, revoked: 0 };

  for (const { link } of results) {
    try {
      const outcome = await engine.verifyUser({
        discordUserId: link.discordUserId,
        guildId,
      });
      if (outcome.notVerified === 'not_linked' || outcome.notVerified === 'token_unavailable') {
        // Link gone mid-run or token revoked: skip silently, keep the run alive.
        continue;
      }
      summary.checked += 1;
      summary.passed += outcome.passed;
      summary.failed += outcome.failed;
      summary.errored += outcome.errored;
      summary.granted += outcome.granted.length;
      summary.revoked += outcome.revoked.length;
    } catch (err) {
      // One member failing must not kill the run for everyone else.
      logger.warn(
        { err, userId: link.discordUserId, ruleId },
        'member verification failed during sync',
      );
      summary.errored += 1;
    }
  }

  return { guildId, ruleId, ...summary };
}

/** Persists one SyncRun row — the audit trail `/mergeid sync status` reads. */
async function recordSyncRun(
  prisma: SyncWorkerDeps['prisma'],
  result: RuleSyncResult,
  status: SyncStatus,
): Promise<void> {
  await prisma.syncRun.create({
    data: {
      ruleId: result.ruleId,
      startedAt: new Date(Date.now() - 1),
      finishedAt: new Date(),
      stats: result as unknown as import('../generated/prisma/client.js').Prisma.InputJsonValue,
      status,
    },
  });
}

/**
 * Builds the processor function separately from Worker construction so tests
 * can drive it directly without Redis.
 */
export function createRuleSyncProcessor(deps: SyncWorkerDeps) {
  return async function processRuleSync(job: Job<RuleSyncJob>): Promise<RuleSyncResult | null> {
    const { logger } = deps;
    const startedAt = Date.now();
    let result: RuleSyncResult | null;
    try {
      result = await verifyRuleMembers(job, deps);
    } catch (err) {
      logger.error({ err, jobId: job.id, data: job.data }, 'rule sync run crashed');
      await recordSyncRun(
        deps.prisma,
        {
          guildId: job.data.guildId,
          ruleId: job.data.ruleId,
          checked: 0,
          passed: 0,
          failed: 0,
          errored: 0,
          granted: 0,
          revoked: 0,
        },
        SyncStatus.FAILED,
      ).catch(() => undefined);
      throw err;
    }

    // Schedule outlived its rule — nothing ran, nothing to record.
    if (result === null) return null;

    // PARTIAL when any member check errored; all-error runs are also PARTIAL
    // (the run itself completed; the members did not).
    const status = result.errored > 0 ? SyncStatus.PARTIAL : SyncStatus.OK;

    await recordSyncRun(deps.prisma, result, status);

    // Structured metrics line — one per run, greppable, no secrets.
    logger.info(
      {
        queue: SYNC_QUEUE_NAME,
        jobId: job.id,
        guildId: result.guildId,
        ruleId: result.ruleId,
        durationMs: Date.now() - startedAt,
        checked: result.checked,
        passed: result.passed,
        failed: result.failed,
        errored: result.errored,
        granted: result.granted,
        revoked: result.revoked,
        status,
      },
      'rule sync completed',
    );
    return result;
  };
}

/**
 * Boots the worker role: consumes the sync queue until stopped.
 *
 * `stop()` is idempotent and never throws — the RuntimeRole contract.
 */
export async function startWorker(deps: SyncWorkerDeps): Promise<RuntimeRole> {
  const worker = new Worker<RuleSyncJob>(SYNC_QUEUE_NAME, createRuleSyncProcessor(deps), {
    ...syncQueueOptions(),
    // Verification involves GitHub round-trips; a stalled check at 30s
    // would falsely reap healthy jobs.
    stalledInterval: 120_000,
    lockDuration: 300_000,
    concurrency: 2,
  });

  worker.on('failed', (job, err) => {
    deps.logger.error(
      { err, jobId: job?.id, attemptsMade: job?.attemptsMade, data: job?.data },
      'rule sync job failed',
    );
  });

  return {
    name: 'worker',
    stop: async () => {
      await worker.close();
    },
  };
}
