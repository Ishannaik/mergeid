/**
 * Linked-role application — the single "this user proved their GitHub account" role.
 *
 * Deliberately non-privileged. Every path here works from either the
 * interaction's own `GuildMember` or a targeted `GET /guilds/{id}/members/{user}`
 * fetch, neither of which needs the `GuildMembers` privileged intent (the bot
 * requests `Guilds` only — see `client.ts`, and README "no privileged intents").
 * Nothing in this module may fetch the full member list.
 *
 * Contract: role application is *advisory*. A refusal from Discord never fails
 * or rolls back the link/unlink that triggered it. Callers get a typed outcome,
 * surface it to the user via {@link describeRoleOutcome}, and carry on.
 *
 * The role mechanics live in `preflight.ts` and are shared with the
 * per-rule verification roles (`rule-roles.ts`).
 */

import type { Client } from 'discord.js';

import type { Config } from '../config/index.js';
import type { Logger } from '../lib/logger.js';
import {
  applyRoleChange,
  type RoleAction,
  type RoleChangeTarget,
  type RoleOutcome,
  type RoleOutcomeKind,
} from './preflight.js';

export type {
  RoleOutcome,
  RoleOutcomeKind,
  RoleAction,
  RoleChangeTarget as LinkedRoleTarget,
} from './preflight.js';

export interface LinkedRoleService {
  /** False when MERGEID_LINKED_ROLE_ID is unset; every call is then a no-op. */
  readonly enabled: boolean;
  /** The configured role snowflake, or null when the feature is off. */
  readonly roleId: string | null;
  grant(target: RoleChangeTarget): Promise<RoleOutcome>;
  revoke(target: RoleChangeTarget): Promise<RoleOutcome>;
}

export function createLinkedRoleService(deps: {
  config: Pick<Config, 'MERGEID_LINKED_ROLE_ID'>;
  logger: Logger;
  /**
   * Late-bound so the api role can be constructed before the gateway client
   * exists. Returns null in processes that do not run the bot role.
   */
  getClient: () => Client | null;
}): LinkedRoleService {
  const roleId = deps.config.MERGEID_LINKED_ROLE_ID ?? null;
  const log = deps.logger.child({ component: 'linked-role' });

  async function apply(target: RoleChangeTarget, action: RoleAction): Promise<RoleOutcome> {
    if (!roleId) {
      return { kind: 'disabled', ok: true };
    }
    return applyRoleChange(target, roleId, action, {
      logger: log,
      getClient: deps.getClient,
    });
  }

  return {
    enabled: roleId !== null,
    roleId,
    grant: (target) => apply(target, 'grant'),
    revoke: (target) => apply(target, 'revoke'),
  };
}

/** Reason clauses, keyed by outcome. Successes are absent — nothing to report. */
const FAILURE_REASONS: Partial<Record<RoleOutcomeKind, string>> = {
  no_guild: 'the command was run in a DM rather than in the server',
  client_unavailable: 'the bot gateway is not running — ask an admin to check the logs',
  guild_unavailable: 'the bot is no longer in that server',
  member_unavailable: 'you are not a member of that server',
  role_missing: 'the configured role no longer exists in that server',
  role_unassignable: 'the configured role is managed by an integration and cannot be assigned',
  // Plain text, no markdown: these strings render in Discord and on the OAuth
  // callback HTML page, and only one of those surfaces understands asterisks.
  missing_manage_roles: 'the bot is missing the Manage Roles permission',
  role_above_bot: "the bot's own role sits below the linked role — an admin needs to drag it above",
  discord_error: 'Discord rejected the change',
};

/**
 * Turn an outcome into an ephemeral sentence, or null when there is nothing
 * worth telling the user (feature off, or the role change succeeded).
 */
export function describeRoleOutcome(outcome: RoleOutcome, action: RoleAction): string | null {
  const reason = FAILURE_REASONS[outcome.kind];
  if (!reason) return null;
  const verb = action === 'grant' ? 'could not be applied' : 'could not be removed';
  return `Heads up: the linked role ${verb} because ${reason}.`;
}
