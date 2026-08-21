/**
 * Hand-rolled discord.js doubles.
 *
 * Only the surface `src/discord/roles.ts` actually touches is modelled — the
 * real classes cannot be constructed without a live client, and mocking the
 * whole module would stop the tests from exercising the code paths that matter
 * (permission preflight, hierarchy comparison, idempotency).
 *
 * Note the absence of any bulk member fetch: `members.fetch(id)` here takes a
 * single id, matching the non-privileged REST call the service is allowed to
 * make. A regression that reached for the whole guild would fail to resolve.
 */

import { expect, vi } from 'vitest';
import type { Client, Guild, GuildMember, Role } from 'discord.js';

import type { Logger } from '../../src/lib/logger.js';

export interface FakeRole {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  comparePositionTo(other: { position: number }): number;
}

export function makeRole(overrides: Partial<FakeRole> & { id: string }): FakeRole {
  const role: FakeRole = {
    name: 'Verified',
    position: 5,
    managed: false,
    comparePositionTo(other) {
      return role.position - other.position;
    },
    ...overrides,
  };
  return role;
}

export interface MakeGuildOptions {
  guildId?: string;
  /** Roles present in the guild, keyed by id. */
  roles?: FakeRole[];
  /** Role ids the target member already holds. */
  memberRoleIds?: string[];
  /** Whether the bot has Manage Roles. */
  botCanManageRoles?: boolean;
  /** Position of the bot's highest role — compared against the target role. */
  botHighestPosition?: number;
  /** Force `member.roles.add` / `.remove` to reject with this error. */
  addError?: unknown;
  removeError?: unknown;
  /** Make a single-member fetch fail (user not in the guild). */
  memberFetchError?: unknown;
}

export interface FakeGuildBundle {
  guild: Guild;
  member: GuildMember;
  add: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  fetchMember: ReturnType<typeof vi.fn>;
}

export function makeGuild(options: MakeGuildOptions = {}): FakeGuildBundle {
  const guildId = options.guildId ?? '111111111111111111';
  const roleList = options.roles ?? [makeRole({ id: '222222222222222222' })];
  const roleMap = new Map(roleList.map((role) => [role.id, role]));
  const memberRoles = new Set(options.memberRoleIds ?? []);

  const add = vi.fn(async (role: FakeRole) => {
    if (options.addError) throw options.addError;
    memberRoles.add(role.id);
  });
  const remove = vi.fn(async (role: FakeRole) => {
    if (options.removeError) throw options.removeError;
    memberRoles.delete(role.id);
  });

  const member = {
    id: '333333333333333333',
    roles: {
      cache: { has: (id: string) => memberRoles.has(id) },
      add,
      remove,
    },
    get guild() {
      return guild;
    },
  } as unknown as GuildMember;

  const botHighest = makeRole({
    id: '999999999999999999',
    name: 'MergeID',
    position: options.botHighestPosition ?? 50,
  });

  const me = {
    permissions: { has: () => options.botCanManageRoles !== false },
    roles: { highest: botHighest },
  } as unknown as GuildMember;

  const fetchMember = vi.fn(async (id: string) => {
    if (options.memberFetchError) throw options.memberFetchError;
    // Asserted on by callers: the service must ask for one id, not the guild.
    expect(typeof id).toBe('string');
    return member;
  });

  const guild = {
    id: guildId,
    roles: {
      cache: { get: (id: string) => roleMap.get(id) as Role | undefined },
      fetch: vi.fn(async (id: string) => (roleMap.get(id) ?? null) as Role | null),
    },
    members: {
      me,
      fetchMe: vi.fn(async () => me),
      fetch: fetchMember,
    },
  } as unknown as Guild;

  return { guild, member, add, remove, fetchMember };
}

/** A client that resolves exactly one guild, mimicking the OAuth-callback path. */
export function makeClient(guild: Guild, guildId: string): Client {
  return {
    guilds: {
      fetch: vi.fn(async (id: string) => {
        if (id !== guildId) throw new Error('Unknown Guild');
        return guild;
      }),
    },
  } as unknown as Client;
}

/** Silent logger whose `child()` returns an equally silent logger. */
export function makeLogger(): Logger {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => log),
  };
  return log as unknown as Logger;
}
