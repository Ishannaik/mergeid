import type {
  ChatInputCommandInteraction,
  RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';

/**
 * A single slash command: the raw REST body Discord registers, plus the
 * handler the interaction router dispatches to.
 *
 * `data` is the already-serialised body (`SlashCommandBuilder.toJSON()`), which
 * is exactly what `deployCommands` bulk-PUTs, so the deployed surface and the
 * dispatch table can never drift apart.
 */
export interface DiscordCommand {
  readonly data: RESTPostAPIApplicationCommandsJSONBody;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

/**
 * The shared command registry — the single source of truth for both
 * deployment and dispatch.
 *
 * Intentionally empty: #7 lands the client bootstrap and interaction
 * framework only. The concrete commands arrive with their own issues and are
 * appended here, at which point they become deployable and dispatchable
 * without touching either the deployer or the router.
 */
export const commands: readonly DiscordCommand[] = [];
