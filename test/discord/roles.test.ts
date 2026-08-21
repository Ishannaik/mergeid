import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLinkedRoleService, describeRoleOutcome } from '../../src/discord/roles.js';
import type { Config } from '../../src/config/index.js';
import { makeClient, makeGuild, makeLogger, makeRole } from './fixtures.js';

const ROLE_ID = '222222222222222222';
const GUILD_ID = '111111111111111111';
const USER_ID = '333333333333333333';

function service(
  roleId: string | undefined,
  options: { client?: ReturnType<typeof makeClient> | null } = {},
) {
  return createLinkedRoleService({
    config: { MERGEID_LINKED_ROLE_ID: roleId } as Pick<Config, 'MERGEID_LINKED_ROLE_ID'>,
    logger: makeLogger(),
    getClient: () => options.client ?? null,
  });
}

/** Build a DiscordAPIError with a given JSON error code. */
function discordError(code: number, message: string): DiscordAPIError {
  return new DiscordAPIError({ code, message }, code, 403, 'PATCH', 'https://discord.test', {});
}

describe('linked role service — feature flag', () => {
  it('is disabled and makes no Discord calls when MERGEID_LINKED_ROLE_ID is unset', async () => {
    const { guild, member, add, remove } = makeGuild();
    const svc = service(undefined);

    expect(svc.enabled).toBe(false);
    expect(svc.roleId).toBeNull();

    const granted = await svc.grant({ guildId: guild.id, userId: USER_ID, member });
    const revoked = await svc.revoke({ guildId: guild.id, userId: USER_ID, member });

    expect(granted).toEqual({ kind: 'disabled', ok: true, detail: undefined });
    expect(revoked.kind).toBe('disabled');
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(describeRoleOutcome(granted, 'grant')).toBeNull();
  });

  it('reports enabled with the configured role id when set', () => {
    const svc = service(ROLE_ID);
    expect(svc.enabled).toBe(true);
    expect(svc.roleId).toBe(ROLE_ID);
  });
});

describe('linked role service — grant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('grants the role to a member supplied by an interaction', async () => {
    const { guild, member, add } = makeGuild();
    const outcome = await service(ROLE_ID).grant({ guildId: guild.id, userId: USER_ID, member });

    expect(outcome.kind).toBe('granted');
    expect(outcome.ok).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[0]).toMatchObject({ id: ROLE_ID });
    expect(add.mock.calls[0]?.[1]).toContain('MergeID');
    expect(describeRoleOutcome(outcome, 'grant')).toBeNull();
  });

  it('resolves the member with a single targeted fetch when none is supplied', async () => {
    const bundle = makeGuild();
    const client = makeClient(bundle.guild, GUILD_ID);

    const outcome = await service(ROLE_ID, { client }).grant({
      guildId: GUILD_ID,
      userId: USER_ID,
    });

    expect(outcome.kind).toBe('granted');
    // One member, by id — never the whole guild (that would need GuildMembers).
    expect(bundle.fetchMember).toHaveBeenCalledExactlyOnceWith(USER_ID);
  });

  it('is idempotent when the member already has the role', async () => {
    const { guild, member, add } = makeGuild({ memberRoleIds: [ROLE_ID] });
    const outcome = await service(ROLE_ID).grant({ guildId: guild.id, userId: USER_ID, member });

    expect(outcome.kind).toBe('unchanged');
    expect(outcome.ok).toBe(true);
    expect(add).not.toHaveBeenCalled();
  });

  it('re-granting twice in a row stays successful and calls add once', async () => {
    const { guild, member, add } = makeGuild();
    const svc = service(ROLE_ID);

    const first = await svc.grant({ guildId: guild.id, userId: USER_ID, member });
    const second = await svc.grant({ guildId: guild.id, userId: USER_ID, member });

    expect(first.kind).toBe('granted');
    expect(second.kind).toBe('unchanged');
    expect(second.ok).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
  });
});

describe('linked role service — revoke', () => {
  it('removes the role on unlink', async () => {
    const { guild, member, remove } = makeGuild({ memberRoleIds: [ROLE_ID] });
    const outcome = await service(ROLE_ID).revoke({ guildId: guild.id, userId: USER_ID, member });

    expect(outcome.kind).toBe('removed');
    expect(outcome.ok).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[0]).toMatchObject({ id: ROLE_ID });
    expect(describeRoleOutcome(outcome, 'revoke')).toBeNull();
  });

  it('is idempotent when the member does not have the role', async () => {
    const { guild, member, remove } = makeGuild({ memberRoleIds: [] });
    const outcome = await service(ROLE_ID).revoke({ guildId: guild.id, userId: USER_ID, member });

    expect(outcome.kind).toBe('unchanged');
    expect(outcome.ok).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('linked role service — failure modes', () => {
  it('reports no_guild in a DM and never touches Discord', async () => {
    const outcome = await service(ROLE_ID).grant({ guildId: null, userId: USER_ID, member: null });

    expect(outcome.kind).toBe('no_guild');
    expect(outcome.ok).toBe(false);
    expect(describeRoleOutcome(outcome, 'grant')).toMatch(/DM/);
  });

  it('ignores the raw APIInteractionGuildMember payload and falls back to a fetch', async () => {
    const bundle = makeGuild();
    const client = makeClient(bundle.guild, GUILD_ID);
    // discord.js hands this shape over when the guild is uncached: plain JSON,
    // no role manager, so it must not be treated as a GuildMember.
    const rawMember = { user: { id: USER_ID }, roles: [ROLE_ID] };

    const outcome = await service(ROLE_ID, { client }).grant({
      guildId: GUILD_ID,
      userId: USER_ID,
      member: rawMember as never,
    });

    expect(outcome.kind).toBe('granted');
    expect(bundle.fetchMember).toHaveBeenCalledExactlyOnceWith(USER_ID);
  });

  it('reports client_unavailable when the process runs no gateway client', async () => {
    const outcome = await service(ROLE_ID, { client: null }).grant({
      guildId: GUILD_ID,
      userId: USER_ID,
    });

    expect(outcome.kind).toBe('client_unavailable');
    expect(describeRoleOutcome(outcome, 'grant')).toMatch(/gateway/);
  });

  it('reports role_missing when the configured role is not in the guild', async () => {
    const { guild, member, add } = makeGuild({ roles: [makeRole({ id: '444444444444444444' })] });
    const outcome = await service(ROLE_ID).grant({ guildId: guild.id, userId: USER_ID, member });

    expect(outcome.kind).toBe('role_missing');
    expect(outcome.ok).toBe(false);
    expect(add).not.toHaveBeenCalled();
    expect(describeRoleOutcome(outcome, 'grant')).toMatch(/no longer exists/);
  });

  it('reports role_unassignable for an integration-managed role', async () => {
    const { guild, member, add } = makeGuild({
      roles: [makeRole({ id: ROLE_ID, managed: true })],
    });
    const outcome = await service(ROLE_ID).grant({ guildId: guild.id, userId: USER_ID, member });

    expect(outcome.kind).toBe('role_unassignable');
    expect(add).not.toHaveBeenCalled();
  });

  it('reports missing_manage_roles when the bot lacks the permission', async () => {
    const { guild, member, add } = makeGuild({ botCanManageRoles: false });
    const outcome = await service(ROLE_ID).grant({ guildId: guild.id, userId: USER_ID, member });

    expect(outcome.kind).toBe('missing_manage_roles');
    expect(outcome.ok).toBe(false);
    expect(add).not.toHaveBeenCalled();
    expect(describeRoleOutcome(outcome, 'grant')).toMatch(/Manage Roles/);
  });

  it('reports role_above_bot when the target role outranks the bot', async () => {
    const { guild, member, add } = makeGuild({
      roles: [makeRole({ id: ROLE_ID, position: 90 })],
      botHighestPosition: 10,
    });
    const outcome = await service(ROLE_ID).grant({ guildId: guild.id, userId: USER_ID, member });

    expect(outcome.kind).toBe('role_above_bot');
    expect(outcome.ok).toBe(false);
    // Preflighted, so we never fire a doomed request at Discord.
    expect(add).not.toHaveBeenCalled();
    expect(describeRoleOutcome(outcome, 'grant')).toMatch(/below the linked role/);
  });

  it('treats an equal role position as outranking the bot', async () => {
    const { guild, member } = makeGuild({
      roles: [makeRole({ id: ROLE_ID, position: 30 })],
      botHighestPosition: 30,
    });
    const outcome = await service(ROLE_ID).grant({ guildId: guild.id, userId: USER_ID, member });

    expect(outcome.kind).toBe('role_above_bot');
  });

  it('maps a 50013 raised after preflight onto role_above_bot', async () => {
    const { guild, member } = makeGuild({
      addError: discordError(RESTJSONErrorCodes.MissingPermissions, 'Missing Permissions'),
    });
    const outcome = await service(ROLE_ID).grant({ guildId: guild.id, userId: USER_ID, member });

    expect(outcome.kind).toBe('role_above_bot');
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('50013');
  });

  it('maps 10011 unknown role and 10007 unknown member onto their outcomes', async () => {
    const unknownRole = makeGuild({
      removeError: discordError(RESTJSONErrorCodes.UnknownRole, 'Unknown Role'),
      memberRoleIds: [ROLE_ID],
    });
    expect(
      (
        await service(ROLE_ID).revoke({
          guildId: unknownRole.guild.id,
          userId: USER_ID,
          member: unknownRole.member,
        })
      ).kind,
    ).toBe('role_missing');

    const unknownMember = makeGuild({
      memberFetchError: discordError(RESTJSONErrorCodes.UnknownMember, 'Unknown Member'),
    });
    const client = makeClient(unknownMember.guild, GUILD_ID);
    const outcome = await service(ROLE_ID, { client }).grant({
      guildId: GUILD_ID,
      userId: USER_ID,
    });

    expect(outcome.kind).toBe('member_unavailable');
    expect(describeRoleOutcome(outcome, 'grant')).toMatch(/not a member/);
  });

  it('reports guild_unavailable when the bot is no longer in the guild', async () => {
    const bundle = makeGuild();
    const client = makeClient(bundle.guild, 'a-different-guild');
    const outcome = await service(ROLE_ID, { client }).grant({
      guildId: GUILD_ID,
      userId: USER_ID,
    });

    expect(outcome.kind).toBe('guild_unavailable');
    expect(describeRoleOutcome(outcome, 'grant')).toMatch(/no longer in that server/);
  });

  it('falls back to discord_error for an unrecognised rejection', async () => {
    const { guild, member } = makeGuild({ addError: new Error('socket hang up') });
    const outcome = await service(ROLE_ID).grant({ guildId: guild.id, userId: USER_ID, member });

    expect(outcome.kind).toBe('discord_error');
    expect(outcome.ok).toBe(false);
    expect(describeRoleOutcome(outcome, 'grant')).toMatch(/Discord rejected/);
  });
});

describe('describeRoleOutcome wording', () => {
  it('uses applied/removed wording per action', () => {
    const outcome = { kind: 'missing_manage_roles', ok: false } as const;
    expect(describeRoleOutcome(outcome, 'grant')).toContain('could not be applied');
    expect(describeRoleOutcome(outcome, 'revoke')).toContain('could not be removed');
  });

  it('stays silent for every successful outcome', () => {
    for (const kind of ['disabled', 'granted', 'removed', 'unchanged'] as const) {
      expect(describeRoleOutcome({ kind, ok: true }, 'grant')).toBeNull();
    }
  });
});
