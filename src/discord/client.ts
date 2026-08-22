import {
  Client,
  Events,
  GatewayIntentBits,
  type ClientOptions,
  type Interaction,
} from 'discord.js';

import { logger } from '../lib/logger.js';
import type { RuntimeRole } from '../lib/runtime.js';
import { createRegistry, commands, type CommandDeps, type DiscordCommand } from './commands/index.js';
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
 * Connects with the `Guilds` intent only, routes application-command
 * interactions through the shared handler, and fails loudly if login is
 * rejected — destroying the half-built client before rethrowing so a failed
 * boot leaks no socket.
 *
 * Shutdown is idempotent: the client is destroyed at most once, whether that
 * happens through repeated `stop()` calls or after login-failure cleanup.
 */
export async function startBot(options?: StartBotOptions): Promise<RuntimeRole> {
  const config = options?.config ?? readDiscordConfig();
  // The wired registry closes over live services; tests may inject a fixed
  // commandList instead. Without commandDeps (e.g. a bare boot in isolation)
  // the fallback is the inert registry — dispatch would warn "unregistered
  // command" rather than crash, which is the safer failure.
  const commandList = options?.commandList ?? (options?.commandDeps ? createRegistry(options.commandDeps) : commands);
  const log = options?.log ?? logger;
  const clientFactory = options?.clientFactory ?? createClient;

  const handleInteraction = createInteractionHandler(commandList, log);
  const client = clientFactory({ intents: [GatewayIntentBits.Guilds] });

  // Both listeners must be attached before login so no early gateway event is
  // dropped between the handshake and handler registration.
  client.once(Events.ClientReady, () => {
    log.info({ event: 'discord.gateway.ready' }, 'Discord gateway connected');
  });
  client.on(Events.InteractionCreate, handleInteraction);
  client.on(Events.Error, (err) => {
    log.error({ err }, 'Discord gateway error');
  });

  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= Promise.resolve()
      .then(() => client.destroy())
      .catch((err: unknown) => {
        try {
          log.error({ err }, 'Failed to destroy Discord gateway client');
        } catch {
          // RuntimeRole.stop() is a no-throw boundary, including logger failures.
        }
      });
    return cleanupPromise;
  };

  try {
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
