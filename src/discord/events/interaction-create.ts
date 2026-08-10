import { MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction, Interaction } from 'discord.js';

import type { DiscordCommand } from '../commands/index.js';

/**
 * The slice of a structured logger this module needs.
 *
 * Deliberately tiny and declared here rather than imported from pino: a real
 * pino instance satisfies it, and so does a plain `{ debug, info, warn, error }`
 * test double, which keeps the router injectable without dragging the logging
 * implementation into its type surface. Calls follow the pino convention of
 * `(bindings, message)`.
 */
export interface InteractionLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** The listener shape `Events.InteractionCreate` is wired to. */
export type InteractionHandler = (interaction: Interaction) => Promise<void>;

/**
 * User-visible copy. Both strings are fixed and carry no diagnostic detail:
 * whatever went wrong belongs in the logs, not in a Discord message, so a
 * stack trace or an internal identifier can never leak to a channel.
 */
const UNKNOWN_COMMAND_MESSAGE = 'Unknown command.';
const COMMAND_FAILURE_MESSAGE = 'Something went wrong while running this command.';

/** The identifiers attached to every log line this router emits. */
interface InteractionContext {
  readonly commandName: string;
  readonly userId: string;
  readonly guildId: string | null;
}

function contextOf(interaction: ChatInputCommandInteraction): InteractionContext {
  return {
    commandName: interaction.commandName,
    userId: interaction.user.id,
    guildId: interaction.guildId,
  };
}

/**
 * Sends one of the fixed safe messages, choosing the only endpoint Discord
 * accepts for the interaction's current state: `reply` while it is still
 * unacknowledged, `followUp` once a handler has replied or deferred.
 *
 * A failure here is terminal for the user — the interaction token may have
 * expired, or the gateway may be unreachable — but it must not be swallowed,
 * so it is reported as a second structured error. It is never surfaced to
 * Discord: retrying a send with the send error's text would both leak internals
 * and, in the common expired-token case, fail again.
 */
async function sendSafeResponse(
  interaction: ChatInputCommandInteraction,
  content: string,
  context: InteractionContext,
  log: InteractionLogger,
): Promise<void> {
  const acknowledged = interaction.replied || interaction.deferred;

  try {
    if (acknowledged) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    log.error({ ...context, err }, 'failed to deliver interaction response');
  }
}

/**
 * Builds the `InteractionCreate` listener for a command registry.
 *
 * The name lookup is built once, here, rather than on every interaction: the
 * registry is fixed for the lifetime of the process, so rebuilding it per event
 * would burn an allocation and a full scan on the hot path for no gain.
 */
export function createInteractionHandler(
  registry: readonly DiscordCommand[],
  log: InteractionLogger,
): InteractionHandler {
  // A null-prototype record: the key is an attacker-supplied command name, so a
  // plain object literal would resolve `constructor` or `toString` to an
  // inherited member and dispatch to something that is not a command.
  const byName = Object.create(null) as Record<string, DiscordCommand>;
  for (const command of registry) {
    byName[command.data.name] = command;
  }

  return async function handleInteraction(interaction: Interaction): Promise<void> {
    // Buttons, modals, autocomplete and friends are not this router's business;
    // ignoring them silently keeps the logs free of noise from every component
    // interaction the bot will eventually handle elsewhere.
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const context = contextOf(interaction);
    const command = byName[interaction.commandName];

    if (command === undefined) {
      // Not an error: this is normally a stale command left over in a guild
      // from a previous deployment, so it is a warning without an `err`.
      log.warn(context, 'received an unregistered command');
      await sendSafeResponse(interaction, UNKNOWN_COMMAND_MESSAGE, context, log);
      return;
    }

    try {
      await command.execute(interaction);
    } catch (err) {
      // The original error is attached verbatim so the serialiser keeps its
      // message, stack and cause chain.
      log.error({ ...context, err }, 'command execution failed');
      await sendSafeResponse(interaction, COMMAND_FAILURE_MESSAGE, context, log);
    }
  };
}
