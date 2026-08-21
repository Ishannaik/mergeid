/**
 * Slash-command registration (issue #7).
 *
 * Registers the command registry with Discord in exactly one scope: the dev
 * guild when `DISCORD_DEV_GUILD_ID` is configured — guild commands propagate
 * instantly, which is what you want while developing — otherwise globally.
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

/** Deployment summary. Carries no credentials and no guild identifier. */
interface DeploymentFields {
  readonly count: number;
  readonly scope: 'global' | 'guild';
}

type DeployLog = (fields: DeploymentFields, message?: string) => void;

interface DeployCommandsOptions {
  readonly config: DiscordConfig;
  readonly commandList: readonly DeployableCommand[];
  readonly rest?: RestLike;
  readonly log?: DeployLog;
}

interface RunDeployCommandsOptions {
  readonly deploy?: (options: DeployCommandsOptions) => Promise<void>;
  readonly readConfig?: () => DiscordConfig;
  readonly commandList?: readonly DeployableCommand[];
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

/**
 * Bulk-registers `commandList` with Discord.
 *
 * A single bulk PUT replaces the entire command set for the chosen scope. An
 * empty registry is a legitimate payload rather than a no-op: it clears every
 * command previously registered in that scope.
 */
export async function deployCommands({
  config,
  commandList,
  rest,
  log,
}: DeployCommandsOptions): Promise<void> {
  // `REST` already satisfies `RestLike` structurally, so the real client and an
  // injected double reach the same call site without a cast.
  const client: RestLike = rest ?? new REST({ version: '10' }).setToken(config.token);

  const { applicationId, devGuildId } = config;
  const body = commandList.map((command) => command.data);

  const route =
    devGuildId === undefined
      ? Routes.applicationCommands(applicationId)
      : Routes.applicationGuildCommands(applicationId, devGuildId);

  await client.put(route, { body });

  const fields: DeploymentFields = {
    count: body.length,
    scope: devGuildId === undefined ? 'global' : 'guild',
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
}: RunDeployCommandsOptions = {}): Promise<void> {
  await deploy({ config: readConfig(), commandList });
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
