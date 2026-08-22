import type {
  ChatInputCommandInteraction,
  RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';

import { infoCommand } from './info.js';
import { linkCommandData, executeLink } from './link.js';
import { unlinkCommandData, executeUnlink } from './unlink.js';
import { statusCommandData, executeStatus } from './status.js';
import { verifyCommandData, executeVerify } from './verify.js';
import { mergeidCommandData, executeMergeid } from './mergeid.js';
import type { LinkedRoleService } from '../roles.js';
import type { Config } from '../../config/index.js';
import type { Logger } from '../../lib/logger.js';
import type { OAuthStateStore } from '../../oauth/index.js';
import type { LinkService, RulesService } from '../../services/index.js';
import type { VerificationEngine } from '../../verification/engine.js';

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
 * Services the MVP command handlers need. One object is captured by
 * `createRegistry` and closed over by every handler wrapper, so the registry,
 * the router and `index.ts` all share one dependency instance.
 */
export interface CommandDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly oauthState: OAuthStateStore;
  readonly links: LinkService;
  readonly linkedRoles: LinkedRoleService;
  readonly rules: RulesService;
  readonly engine: VerificationEngine;
}

function command(
  data: RESTPostAPIApplicationCommandsJSONBody,
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>,
): DiscordCommand {
  return { data, execute };
}

/**
 * The wired registry — built once at boot from live services. This is what the
 * runtime bot role hands to both its router; deployment uses `commands`, whose
 * REST surface is identical by construction (same builders).
 */
export function createRegistry(deps: CommandDeps): readonly DiscordCommand[] {
  return [
    infoCommand,
    command(linkCommandData.toJSON(), (interaction) =>
      executeLink(interaction, {
        config: deps.config,
        logger: deps.logger,
        oauthState: deps.oauthState,
        links: deps.links,
        linkedRoles: deps.linkedRoles,
        engine: deps.engine,
      }),
    ),
    command(unlinkCommandData.toJSON(), (interaction) =>
      executeUnlink(interaction, {
        logger: deps.logger,
        links: deps.links,
        linkedRoles: deps.linkedRoles,
      }),
    ),
    command(statusCommandData.toJSON(), (interaction) =>
      executeStatus(interaction, { links: deps.links }),
    ),
    command(verifyCommandData.toJSON(), (interaction) =>
      executeVerify(interaction, { logger: deps.logger, engine: deps.engine }),
    ),
    command(mergeidCommandData.toJSON(), (interaction) =>
      executeMergeid(interaction, { logger: deps.logger, rules: deps.rules }),
    ),
  ];
}

/**
 * The shared command registry — the single source of truth for REST
 * deployment (the deploy CLI has no service wiring).
 *
 * Adding a command means adding its builder here AND to `createRegistry`; a
 * vitest guard below fails when the two surfaces drift.
 */
export const commands: readonly DiscordCommand[] = [
  infoCommand,
  ...[
    linkCommandData,
    unlinkCommandData,
    statusCommandData,
    verifyCommandData,
    mergeidCommandData,
  ].map((builder): DiscordCommand => {
    const data = builder.toJSON();
    return { data, execute: () => Promise.resolve() };
  }),
];
