/**
 * Slash-command registration (issue #7).
 *
 * Registers the command registry with Discord in exactly one scope: the dev
 * guild when `DISCORD_DEV_GUILD_ID` is configured — guild commands propagate
 * instantly, which is what you want while developing — otherwise globally.
 * `--scope=global` or `--scope=guild` overrides that choice.
 *
 * Discord shows global and guild commands side by side, so a set left behind
 * in the other scope surfaces as duplicate entries, or an outdated command
 * that still answers. Whenever both scopes are addressable (a dev guild is
 * configured) the scope not being deployed to is emptied in the same run.
 *
 * Every collaborator is injectable so the deployment contract is testable
 * without touching the network.
 */

import { pathToFileURL } from 'node:url';

import { REST, Routes, type RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';

import { logger } from '../lib/logger.js';
import { readDiscordConfig, type DiscordConfig } from './config.js';
import { commands } from './commands/index.js';

/**
 * The only part of a command definition that deployment cares about. Keeping it
 * structural decouples the deployer from the handler interface: registration
 * needs a REST body, not an `execute` implementation.
 */
interface DeployableCommand {
  readonly data: RESTPostAPIApplicationCommandsJSONBody;
}

/** The slice of `REST` used here, so a double can stand in for the real client. */
interface RestLike {
  put(
    route: string,
    options: { readonly body: readonly RESTPostAPIApplicationCommandsJSONBody[] },
  ): Promise<unknown>;
}

/** Where a registration lands. */
export type CommandScope = 'global' | 'guild';

/** Deployment summary. Carries no credentials and no guild identifier. */
interface DeploymentFields {
  readonly count: number;
  readonly scope: CommandScope;
  /** The other scope emptied in this run, when both scopes were addressable. */
  readonly cleared?: CommandScope;
}

type DeployLog = (fields: DeploymentFields, message?: string) => void;

interface DeployCommandsOptions {
  readonly config: DiscordConfig;
  readonly commandList: readonly DeployableCommand[];
  readonly rest?: RestLike;
  readonly log?: DeployLog;
  /** Overrides the scope implied by `config.devGuildId`. */
  readonly scope?: CommandScope;
}

interface RunDeployCommandsOptions {
  readonly deploy?: (options: DeployCommandsOptions) => Promise<void>;
  readonly readConfig?: () => DiscordConfig;
  readonly commandList?: readonly DeployableCommand[];
  /** Process arguments after the script path; defaults to `process.argv.slice(2)`. */
  readonly argv?: readonly string[];
}

interface DeployEntrypointOptions {
  readonly argv1?: string;
  readonly moduleUrl?: string;
  readonly run?: () => Promise<void>;
  readonly loadEnvironment?: () => void;
  readonly logError?: (fields: { readonly err: unknown }, message: string) => void;
  readonly setExitCode?: (code: number) => void;
}

const DEPLOYED_MESSAGE = 'Registered Discord application commands';

const SCOPE_FLAG = '--scope=';

/**
 * Picks the registration scope: the explicit override when given, otherwise
 * the dev guild when one is configured, otherwise global.
 *
 * @throws {Error} when `guild` is requested but no dev guild is configured —
 *   there is no guild to register to, and silently falling back to global
 *   would be the exact surprise the override exists to prevent.
 */
export function resolveScope(config: DiscordConfig, override?: CommandScope): CommandScope {
  if (override === 'guild' && config.devGuildId === undefined) {
    throw new Error('--scope=guild requires DISCORD_DEV_GUILD_ID to be set.');
  }

  return override ?? (config.devGuildId === undefined ? 'global' : 'guild');
}

/**
 * Reads `--scope=global|guild` from the CLI arguments.
 *
 * @throws {Error} on any other `--scope` value, so a typo fails instead of
 *   quietly deploying to the default scope.
 */
export function parseScopeArgument(argv: readonly string[]): CommandScope | undefined {
  const flag = argv.find((argument) => argument.startsWith(SCOPE_FLAG));
  if (flag === undefined) {
    return undefined;
  }

  const value = flag.slice(SCOPE_FLAG.length);
  if (value === 'global' || value === 'guild') {
    return value;
  }

  throw new Error(`Unknown ${SCOPE_FLAG} value; expected "global" or "guild".`);
}

/**
 * Bulk-registers `commandList` with Discord.
 *
 * A single bulk PUT replaces the entire command set for the chosen scope. An
 * empty registry is a legitimate payload rather than a no-op: it clears every
 * command previously registered in that scope.
 *
 * When a dev guild is configured, the scope *not* deployed to is emptied with
 * a second bulk PUT so the two registries cannot drift apart. Without a dev
 * guild only the global scope is addressable, and nothing else is touched.
 */
export async function deployCommands({
  config,
  commandList,
  rest,
  log,
  scope: requestedScope,
}: DeployCommandsOptions): Promise<void> {
  // `REST` already satisfies `RestLike` structurally, so the real client and an
  // injected double reach the same call site without a cast.
  const client: RestLike = rest ?? new REST({ version: '10' }).setToken(config.token);

  const { applicationId, devGuildId } = config;
  const scope = resolveScope(config, requestedScope);
  const body = commandList.map((command) => command.data);

  const globalRoute = Routes.applicationCommands(applicationId);
  const guildRoute =
    devGuildId === undefined
      ? undefined
      : Routes.applicationGuildCommands(applicationId, devGuildId);

  // `resolveScope` only yields `guild` when a dev guild exists, so the fallback
  // to the global route here is unreachable; it keeps the type narrow.
  const target = scope === 'guild' && guildRoute !== undefined ? guildRoute : globalRoute;
  await client.put(target, { body });

  let cleared: CommandScope | undefined;
  if (guildRoute !== undefined) {
    const other = scope === 'guild' ? globalRoute : guildRoute;
    await client.put(other, { body: [] });
    cleared = scope === 'guild' ? 'global' : 'guild';
  }

  const fields: DeploymentFields = {
    count: body.length,
    scope,
    ...(cleared === undefined ? {} : { cleared }),
  };

  // Defaults to the shared logger, invoked as a method so pino keeps its binding.
  if (log) {
    log(fields, DEPLOYED_MESSAGE);
  } else {
    logger.info(fields, DEPLOYED_MESSAGE);
  }
}

/**
 * Deploys the shared command registry using runtime configuration.
 *
 * The seams are injectable so entrypoint wiring is testable without Discord
 * credentials or network access.
 */
export async function runDeployCommands({
  deploy = deployCommands,
  readConfig = readDiscordConfig,
  commandList = commands,
  argv = process.argv.slice(2),
}: RunDeployCommandsOptions = {}): Promise<void> {
  const scope = parseScopeArgument(argv);
  await deploy({ config: readConfig(), commandList, ...(scope === undefined ? {} : { scope }) });
}

function loadLocalEnvironment(): void {
  try {
    process.loadEnvFile('.env');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

/**
 * Runs deployment only when this module is the process entry point.
 *
 * The process boundaries are injectable so the real ESM guard, success path,
 * and failure exit behavior can be exercised without network access.
 */
export async function runDeployEntrypoint({
  argv1 = process.argv[1],
  moduleUrl = import.meta.url,
  run = runDeployCommands,
  logError = (fields, message) => logger.error(fields, message),
  loadEnvironment = loadLocalEnvironment,
  setExitCode = (code) => {
    process.exitCode = code;
  },
}: DeployEntrypointOptions = {}): Promise<void> {
  if (argv1 === undefined || pathToFileURL(argv1).href !== moduleUrl) {
    return;
  }

  try {
    loadEnvironment();
    await run();
  } catch (err) {
    logError({ err }, 'Failed to register Discord application commands');
    setExitCode(1);
  }
}

await runDeployEntrypoint();
