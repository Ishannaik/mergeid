/**
 * Periodic rule re-verification queue (M5).
 *
 * One BullMQ queue carries one job shape: "re-run verification for a single
 * rule". Each enabled rule gets its own repeatable job scheduler whose cadence
 * matches the rule's `recheckMinutes`. Schedulers (not raw repeatables) are
 * used so changing a rule's interval is one idempotent upsert, and disabling
 * the rule removes the schedule outright.
 *
 * The queue lives on Redis — cross-process coordination never uses process
 * memory (docs/architecture.md). The producer half (scheduler upserts/removals)
 * is separate from the consumer half (`worker.ts`) so the api/bot roles can
 * enqueue without ever loading a processor.
 */

import { Queue } from 'bullmq';

import type { Logger } from '../lib/logger.js';

/** Default Redis connection options every MergeID BullMQ client needs. */
export const BULLMQ_CONNECTION = {
  maxRetriesPerRequest: null,
} as const;

/** Logical queue name. Constant across processes; do not rename casually. */
export const SYNC_QUEUE_NAME = 'mergeid.sync';

/** Shape of a re-verification job. Kept intentionally flat for inspectability. */
export interface RuleSyncJob {
  guildId: string;
  ruleId: string;
}

/**
 * Builds queue/worker options shared by producers and consumers.
 *
 * `prefix` isolates MergeID's keys when several apps share one Redis.
 */
export function syncQueueOptions(prefix = 'mergeid') {
  return { prefix, connection: BULLMQ_CONNECTION };
}

/**
 * Creates the producer-side queue handle.
 *
 * Callers own the lifecycle: pass to `closeSyncQueue` on shutdown.
 */
export function createSyncQueue(logger: Logger): Queue<RuleSyncJob> {
  const queue = new Queue<RuleSyncJob>(SYNC_QUEUE_NAME, {
    ...syncQueueOptions(),
    // Producer only ever touches scheduler meta keys; a small max keeps the
    // event stream bounded without affecting job delivery.
    streams: { events: { maxLen: 1_000 } },
  });
  queue.on('error', (err: Error) => {
    logger.error({ err }, 'sync queue error');
  });
  return queue;
}

/**
 * Idempotently aligns the repeatable schedule of one rule with its config.
 *
 * Called after any rule create/update so the next fire lands at the new
 * interval. The scheduler id embeds the rule id — one schedule per rule,
 * never per guild.
 */
export async function scheduleRule(
  queue: Queue<RuleSyncJob>,
  input: { guildId: string; ruleId: string; recheckMinutes: number },
): Promise<void> {
  const intervalMs = input.recheckMinutes * 60_000;
  await queue.upsertJobScheduler(
    `rule:${input.ruleId}`,
    {
      // `every` (fixed interval) rather than cron: rules think in minutes, not
      // wall-clock patterns. startDate anchors the first run one full interval
      // out so a fresh schedule does not fire immediately mid-request.
      every: intervalMs,
      startDate: new Date(Date.now() + intervalMs),
      // BullMQ's `every` already spaces runs evenly; the ±10% (capped at ±5min)
      // offset below is applied to the *next* run by passing a small random
      // offset, spreading many rules off the same tick — M5 item #2's goal.
      offset: Math.floor(Math.random() * Math.min(intervalMs * 0.1, 300_000)),
    },
    {
      name: 'verify-rule',
      data: { guildId: input.guildId, ruleId: input.ruleId },
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000, jitter: 0.25 },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 200 },
      },
    },
  );
}

/** Removes a rule's schedule (rule disabled or deleted). Idempotent. */
export async function unscheduleRule(queue: Queue<RuleSyncJob>, ruleId: string): Promise<void> {
  await queue.removeJobScheduler(`rule:${ruleId}`);
}

/**
 * Aligns all schedules with current DB state. Used at worker boot so a rule
 * added while the worker was down still gets its schedule, and stale ones are
 * pruned.
 *
 * Returns { scheduled, removed } counts for structured logging.
 */
export async function reconcileSchedules(
  queue: Queue<RuleSyncJob>,
  rules: Array<{ id: string; guildId: string; recheckMinutes: number; enabled: boolean }>,
): Promise<{ scheduled: number; removed: number }> {
  let scheduled = 0;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    await scheduleRule(queue, {
      guildId: rule.guildId,
      ruleId: rule.id,
      recheckMinutes: rule.recheckMinutes,
    });
    scheduled += 1;
  }
  // Schedules that no longer match an enabled rule are discovered by listing;
  // removal happens lazily through removeJobScheduler when the worker sees
  // them fire for a missing/disabled rule (processor short-circuits).
  return { scheduled, removed: 0 };
}

/** Closes the producer. Waits for Redis round-trips, does not wait jobs. */
export async function closeSyncQueue(queue: Queue<RuleSyncJob>): Promise<void> {
  await queue.close();
}
