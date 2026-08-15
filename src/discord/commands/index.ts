import type {
  ChatInputCommandInteraction,
  RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';

import { infoCommand } from './info.js';

/**
 * A single slash command: the raw REST body Discord registers, plus the
 * handler the interaction router dispatches to.
 *
 * `data` is the already-serialised body (`SlashCommandBuilder.toJSON()`), which
 * is exactly what `deployCommands` bulk-PUTs, so the deployed surface and the
 * dispatch table can never drift apart.
 *
 * The router defers every known command ephemerally before dispatch. Handlers
 * complete that private initial response with `editReply` and may use
 * `followUp` only for additional messages.
 */
export interface DiscordCommand {
  readonly data: RESTPostAPIApplicationCommandsJSONBody;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

/**
 * The shared command registry — the single source of truth for both
 * deployment and dispatch.
 *
 * Adding a command here makes the same definition available to both REST
 * deployment and interaction dispatch, preventing the two surfaces from
 * drifting apart.
 */
export const commands: readonly DiscordCommand[] = [infoCommand];
