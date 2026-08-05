// Entry: bootstraps runtime roles from MERGEID_ROLES (see docs/architecture.md §4).
//
// Each role currently starts as a no-op that reports ready and registers a
// shutdown hook. The real implementations land in their own issues:
//   bot    → #7  (Discord client bootstrap + interaction framework)
//   api    → #10 (Fastify server + GET /oauth/callback)
//   worker → #28 (BullMQ worker + queue wiring)

import { startApi } from './api/server.js';
import { startBot } from './discord/client.js';
import { logger } from './lib/logger.js';
import { startWorker } from './sync/worker.js';
import type { RuntimeRole } from './lib/runtime.js';

const ROLE_STARTERS = {
  bot: startBot,
  api: startApi,
  worker: startWorker,
} as const;

type RoleName = keyof typeof ROLE_STARTERS;

const ALL_ROLES = Object.keys(ROLE_STARTERS) as RoleName[];

/** Milliseconds a graceful shutdown may take before the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Parses MERGEID_ROLES into a deduplicated, ordered role list.
 *
 * Deliberately minimal: full env parsing and validation is #2. This reads the
 * one variable the entrypoint cannot boot without.
 */
export function parseRoles(raw: string | undefined): RoleName[] {
  const requested = (raw ?? ALL_ROLES.join(','))
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);

  if (requested.length === 0) {
    throw new Error('MERGEID_ROLES is empty. Expected a subset of: bot, api, worker.');
  }

  const unknown = requested.filter(
    (value): value is string => !ALL_ROLES.includes(value as RoleName),
  );
  if (unknown.length > 0) {
    throw new Error(
      `MERGEID_ROLES contains unknown role(s): ${unknown.join(', ')}. Expected a subset of: ${ALL_ROLES.join(', ')}.`,
    );
  }

  // Preserve ALL_ROLES order so startup and shutdown ordering are deterministic
  // regardless of how the operator ordered the env var.
  return ALL_ROLES.filter((role) => requested.includes(role));
}

async function stopAll(started: RuntimeRole[]): Promise<void> {
  // Reverse order: the worker drains before the datastores it depends on go away.
  for (const role of [...started].reverse()) {
    try {
      await role.stop();
      logger.info({ role: role.name }, 'role stopped');
    } catch (error) {
      logger.error({ role: role.name, err: error }, 'role failed to stop cleanly');
    }
  }
}

async function main(): Promise<void> {
  const roles = parseRoles(process.env.MERGEID_ROLES);
  logger.info({ roles }, 'starting mergeid');

  const started: RuntimeRole[] = [];
  let shuttingDown = false;
  // Remembers the code the first shutdown reason asked for, so a signal
  // arriving mid-cleanup cannot downgrade a fatal exit to a clean one.
  let pendingExitCode = 0;

  // Holds the event loop open. A process signal listener does not keep Node
  // alive on its own, and the no-op roles own no handles yet — without this the
  // process reaches "ready" and immediately exits 0, so shutdown never runs.
  // Real roles bring their own refed handles (gateway socket, HTTP listener,
  // queue worker); drop this once one of them does.
  const keepAlive = setInterval(() => {}, 1 << 30);

  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) {
      // A second signal means the operator is out of patience. Keep whichever
      // code reports failure: a crash already under cleanup must not be
      // recorded as a clean stop just because SIGTERM landed on top of it.
      const finalCode = pendingExitCode || exitCode;
      logger.warn({ reason, exitCode: finalCode }, 'shutdown already in progress, forcing exit');
      process.exit(finalCode);
    }
    shuttingDown = true;
    pendingExitCode = exitCode;
    clearInterval(keepAlive);
    logger.info({ reason }, 'shutting down');

    const timer = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    await stopAll(started);
    clearTimeout(timer);
    process.exit(exitCode);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal, 0);
    });
  }

  process.on('unhandledRejection', (error) => {
    logger.fatal({ err: error }, 'unhandled rejection');
    void shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });

  try {
    for (const role of roles) {
      started.push(await ROLE_STARTERS[role]());
      logger.info({ role }, 'role ready');
    }
  } catch (error) {
    // A half-started process is worse than a stopped one: unwind what booted.
    logger.fatal({ err: error }, 'startup failed');
    await stopAll(started);
    process.exit(1);
  }

  logger.info({ roles }, 'mergeid ready');
}

await main();
