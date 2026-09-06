import {
  Client,
  Events,
  GatewayIntentBits,
  type ClientOptions,
  type Interaction,
} from 'discord.js';
import { Agent } from 'undici';

import { logger } from '../lib/logger.js';
import type { RuntimeRole } from '../lib/runtime.js';
import {
  createRegistry,
  commands,
  type CommandDeps,
  type DiscordCommand,
} from './commands/index.js';
import { createInteractionHandler, type InteractionLogger } from './events/interaction-create.js';
import { readDiscordConfig } from './config.js';

/** Discord bot credentials and scope, as resolved from the environment. */
interface DiscordConfig {
  readonly token: string;
  readonly applicationId: string;
  readonly devGuildId?: string;
}

/**
 * Structural subset of the discord.js `Client` surface this module touches.
 *
 * Declaring the seam structurally keeps the gateway lifecycle testable without
 * standing up a real websocket connection.
 */
interface GatewayClient {
  once(event: Events.ClientReady, listener: () => void): unknown;
  on(
    event: Events.InteractionCreate,
    listener: (interaction: Interaction) => void | Promise<void>,
  ): unknown;
  on(event: Events.Error, listener: (error: Error) => void): unknown;
  login(token: string): Promise<string>;
  destroy(): Promise<void> | void;
}

/** Injection seam for the gateway bootstrap. */
export interface StartBotOptions {
  readonly config?: DiscordConfig;
  /** Pre-built command registry. Overrides `commandDeps` when both are given. */
  readonly commandList?: readonly DiscordCommand[];
  /** Live services used to build the wired registry when `commandList` is absent. */
  readonly commandDeps?: CommandDeps;
  readonly clientFactory?: (options: ClientOptions) => GatewayClient;
  readonly log?: InteractionLogger;
}

/** Default factory: a real gateway client with no privileged intents. */
const createClient = (options: ClientOptions): GatewayClient => new Client(options);

/**
 * Keep Discord REST connections alive well past the observed idle interval so
 * a later interaction acknowledgement can reuse its established transport.
 */
const discordRestAgentOptions = {
  keepAliveTimeout: 5 * 60_000,
  keepAliveMaxTimeout: 15 * 60_000,
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 250,
} as const;

/**
 * The gateway client of the most recently booted bot role, if any.
 *
 * Role services (linked-role grant, rule-role sync) run inside command
 * handlers that fire after boot, so a module-level holder is enough — no
 * service needs the client at construction time.
 */
let activeClient: Client | null = null;

/** Returns the booted Discord gateway client, or null before bot boot. */
export function getGatewayClient(): Client | null {
  return activeClient;
}

/**
 * Boots the Discord gateway client.
 *
 * Installs a client-owned Discord REST dispatcher before login so connection
 * reuse remains available when the gateway later delivers an interaction.
 * Connects with the `Guilds` intent only, routes application-command
 * interactions through the shared handler, and destroys the half-built
 * client and its dispatcher if startup fails.
 *
 * Shutdown is idempotent: the client and dispatcher close at most once,
 * whether that happens through repeated `stop()` calls or failed startup.
 */
export async function startBot(options?: StartBotOptions): Promise<RuntimeRole> {
  const config = options?.config ?? readDiscordConfig();
  // The wired registry closes over live services; tests may inject a fixed
  // commandList instead. Without commandDeps (e.g. a bare boot in isolation)
  // the fallback is the inert registry — dispatch would warn "unregistered
  // command" rather than crash, which is the safer failure.
  const commandList =
    options?.commandList ?? (options?.commandDeps ? createRegistry(options.commandDeps) : commands);
  const log = options?.log ?? logger;
  const clientFactory = options?.clientFactory ?? createClient;
  const dispatcher = new Agent(discordRestAgentOptions);
  const handleInteraction = createInteractionHandler(commandList, log);
  let client: GatewayClient | undefined;
  let cleanupPromise: Promise<void> | undefined;

  const logCleanupFailure = (err: unknown, message: string): void => {
    try {
      log.error({ err }, message);
    } catch {
      // RuntimeRole.stop() is a no-throw boundary, including logger failures.
    }
  };

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= Promise.all([
      Promise.resolve()
        .then(() => client?.destroy())
        .catch((err: unknown) => {
          logCleanupFailure(err, 'Failed to destroy Discord gateway client');
        }),
      Promise.resolve()
        .then(() => dispatcher.close())
        .catch((err: unknown) => {
          logCleanupFailure(err, 'Failed to close Discord REST dispatcher');
        }),
    ]).then(() => undefined);
    return cleanupPromise;
  };

  try {
    client = clientFactory({
      intents: [GatewayIntentBits.Guilds],
      rest: { agent: dispatcher },
    });

    // Both listeners must be attached before login so no early gateway event is
    // dropped between the handshake and handler registration.
    client.once(Events.ClientReady, () => {
      log.info({ event: 'discord.gateway.ready' }, 'Discord gateway connected');
    });
    client.on(Events.InteractionCreate, handleInteraction);
    client.on(Events.Error, (err) => {
      log.error({ err }, 'Discord gateway error');
    });

    await client.login(config.token);
    activeClient = client as Client;
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    name: 'bot',
    stop: async () => {
      await cleanup();
      activeClient = null;
    },
  };
}
