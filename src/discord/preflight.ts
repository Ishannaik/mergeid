/**
 * Shared role-application machinery for Discord role changes.
 *
 * One code path serves both the single linked role (granted on link) and
 * per-rule verified roles (granted/revoked by the verification engine), so
 * preflight checks — bot hierarchy, Manage Roles, role existence, idempotency
 * — are identical everywhere (docs/security-model.md §3 role safety rails).
 *
 * Contract: role application is *advisory*. A refusal from Discord never
 * fails or rolls back the link or verification that triggered it. Callers get
 * a typed outcome, surface it to the user, and carry on.
 */

import { DiscordAPIError, PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import type { APIInteractionGuildMember, Client, Guild, GuildMember, Role } from 'discord.js';

import type { Logger } from '../lib/logger.js';

export const GRANT_REASON = 'MergeID: GitHub account linked';
export const REVOKE_REASON = 'MergeID: GitHub account unlinked';

/**
 * Why a role change ended the way it did.
 *
 * `granted` / `removed` / `unchanged` / `disabled` are successes. Everything
 * else is a failure the caller should know about but that must not block the
 * operation that triggered it.
 */
export type RoleOutcomeKind =
  /** The feature is off for this role (no-op). */
  | 'disabled'
  /** The role was added. */
  | 'granted'
  /** The role was removed. */
  | 'removed'
  /** Member already had (or already lacked) the role — nothing to do. */
  | 'unchanged'
  /** Invoked outside a guild (DM), so there is no member to act on. */
  | 'no_guild'
  /** This process has no Discord gateway client (api-only deployment). */
  | 'client_unavailable'
  /** The bot is not in that guild, or the guild is unreachable. */
  | 'guild_unavailable'
  /** The user is not a member of that guild. */
  | 'member_unavailable'
  /** The configured role id does not exist in the guild. */
  | 'role_missing'
  /** The role is integration-managed (or @everyone) and cannot be assigned. */
  | 'role_unassignable'
  /** The bot lacks the Manage Roles permission. */
  | 'missing_manage_roles'
  /** The bot's highest role sits at or below the target role. */
  | 'role_above_bot'
  /** Discord rejected the call for some other reason. */
  | 'discord_error';

export interface RoleOutcome {
  kind: RoleOutcomeKind;
  /** True when the member's roles now match the desired state. */
  ok: boolean;
  /** Operator-facing detail for logs. Never rendered to end users verbatim. */
  detail?: string;
}

/** Which direction a call was going, used to word the user-facing message. */
export type RoleAction = 'grant' | 'revoke';

/**
 * Who to act on. Supply `member` when one is already in hand (slash commands)
 * to skip a REST round trip; supply `guildId` alone from out-of-band flows such
 * as the OAuth callback, which has no interaction.
 */
export interface RoleChangeTarget {
  /** Guild the action applies to; null when invoked from a DM. */
  guildId: string | null;
  /** Discord user snowflake being acted on. */
  userId: string;
  /**
   * Pre-resolved member. Typed as discord.js types `interaction.member`, which
   * is a plain JSON `APIInteractionGuildMember` when the guild is uncached —
   * that variant is ignored and the member re-fetched by id.
   */
  member?: GuildMember | APIInteractionGuildMember | null;
}

export interface RoleChangeDeps {
  logger: Logger;
  /** Late-bound so the api role can be constructed before the gateway client exists. */
  getClient: () => Client | null;
}

const ok = (kind: RoleOutcomeKind, detail?: string): RoleOutcome => ({ kind, ok: true, detail });
const fail = (kind: RoleOutcomeKind, detail?: string): RoleOutcome => ({ kind, ok: false, detail });

/**
 * Duck-typed member check.
 *
 * `interaction.member` is either a real `GuildMember` or the raw
 * `APIInteractionGuildMember` payload, which is a plain object with no methods.
 * We probe for the role manager rather than using `instanceof`, which also
 * fails silently when two copies of discord.js end up in the dependency tree.
 */
export function isGuildMember(value: unknown): value is GuildMember {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { roles?: { add?: unknown; remove?: unknown; cache?: unknown } };
  return (
    typeof candidate.roles?.add === 'function' && typeof candidate.roles?.remove === 'function'
  );
}

export function isOutcome(value: unknown): value is RoleOutcome {
  return typeof value === 'object' && value !== null && 'kind' in value && 'ok' in value;
}

/** Resolve the guild from a pre-fetched member, else over REST by id. */
export async function resolveGuild(
  target: RoleChangeTarget,
  deps: RoleChangeDeps,
): Promise<Guild | RoleOutcome> {
  if (isGuildMember(target.member)) return target.member.guild;
  if (!target.guildId) return fail('no_guild');

  const client = deps.getClient();
  if (!client) {
    return fail('client_unavailable', 'no discord gateway client in this process');
  }

  try {
    return await client.guilds.fetch(target.guildId);
  } catch (err) {
    deps.logger.warn({ err, guildId: target.guildId }, 'guild unreachable for role change');
    return fail('guild_unavailable', 'guild fetch failed');
  }
}

/**
 * Fetch exactly one member by id. This is `GET /guilds/{id}/members/{user}`,
 * which is not gated by the GuildMembers intent — unlike a full member list,
 * which this module must never request.
 */
export async function resolveMember(
  guild: Guild,
  target: RoleChangeTarget,
  deps: RoleChangeDeps,
): Promise<GuildMember | RoleOutcome> {
  if (isGuildMember(target.member)) return target.member;
  try {
    return await guild.members.fetch(target.userId);
  } catch (err) {
    if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMember) {
      return fail('member_unavailable', 'user is not a member of the guild');
    }
    deps.logger.warn({ err, guildId: guild.id }, 'member fetch failed for role change');
    return fail('member_unavailable', 'member fetch failed');
  }
}

/** Resolve a role and confirm the bot is allowed to manage it. */
export async function resolveManageableRole(
  guild: Guild,
  id: string,
  deps: RoleChangeDeps,
): Promise<Role | RoleOutcome> {
  let role: Role | null;
  try {
    role = guild.roles.cache.get(id) ?? (await guild.roles.fetch(id));
  } catch (err) {
    deps.logger.warn({ err, guildId: guild.id, roleId: id }, 'role fetch failed');
    return fail('role_missing', 'role fetch failed');
  }
  if (!role) return fail('role_missing', 'configured role id not present in guild');

  // @everyone shares the guild id and can never be added or removed.
  if (role.id === guild.id || role.managed) {
    return fail('role_unassignable', role.managed ? 'integration-managed role' : '@everyone');
  }

  let me: GuildMember;
  try {
    me = guild.members.me ?? (await guild.members.fetchMe());
  } catch (err) {
    deps.logger.warn(
      { err, guildId: guild.id },
      'could not resolve bot member for permission preflight',
    );
    return fail('guild_unavailable', 'bot member unresolvable');
  }

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return fail('missing_manage_roles');
  }

  // A bot can only touch roles strictly below its own highest role. This is
  // the single most common production failure — preflight it so the user gets
  // an actionable message instead of an opaque 50013.
  if (role.comparePositionTo(me.roles.highest) >= 0) {
    return fail(
      'role_above_bot',
      `role position ${role.position} >= bot ${me.roles.highest.position}`,
    );
  }

  return role;
}

/** Map a post-preflight Discord rejection onto an outcome. */
export function mapDiscordError(err: unknown, guildId: string, logger: Logger): RoleOutcome {
  if (err instanceof DiscordAPIError) {
    switch (err.code) {
      case RESTJSONErrorCodes.MissingPermissions:
        // Preflight passed, so the hierarchy or permissions changed under us.
        return fail('role_above_bot', 'discord returned 50013 after preflight');
      case RESTJSONErrorCodes.UnknownRole:
        return fail('role_missing', 'discord returned 10011');
      case RESTJSONErrorCodes.UnknownMember:
        return fail('member_unavailable', 'discord returned 10007');
      case RESTJSONErrorCodes.MissingAccess:
        return fail('guild_unavailable', 'discord returned 50001');
      default:
        break;
    }
  }
  logger.error({ err, guildId }, 'unexpected discord error during role change');
  return fail('discord_error');
}

/**
 * Apply a single role change idempotently, with full preflight.
 * A no-op when the member already is (or already isn't) holding the role.
 */
export async function applyRoleChange(
  target: RoleChangeTarget,
  roleId: string,
  action: RoleAction,
  deps: RoleChangeDeps,
): Promise<RoleOutcome> {
  const guild = await resolveGuild(target, deps);
  if (isOutcome(guild)) return guild;

  const member = await resolveMember(guild, target, deps);
  if (isOutcome(member)) return member;

  const role = await resolveManageableRole(guild, roleId, deps);
  if (isOutcome(role)) return role;

  // Idempotency: adding a role the member holds, or removing one they do not,
  // is a no-op rather than an error.
  const has = member.roles.cache.has(role.id);
  if (action === 'grant' && has) return ok('unchanged', 'member already has the role');
  if (action === 'revoke' && !has) return ok('unchanged', 'member does not have the role');

  try {
    if (action === 'grant') {
      await member.roles.add(role, GRANT_REASON);
    } else {
      await member.roles.remove(role, REVOKE_REASON);
    }
  } catch (err) {
    return mapDiscordError(err, guild.id, deps.logger);
  }

  deps.logger.info(
    { guildId: guild.id, userId: target.userId, roleId: role.id, action },
    'role updated',
  );
  return ok(action === 'grant' ? 'granted' : 'removed');
}
