import { describe, expect, it, vi } from 'vitest';

import { createRulesService } from '../../src/services/rules.js';
import { makeLogger } from '../discord/fixtures.js';

type Mock = ReturnType<typeof vi.fn>;

interface PrismaMock {
  guild: { findUnique: Mock; upsert: Mock };
  verificationRule: { count: Mock; findMany: Mock; create: Mock; findFirst: Mock; delete: Mock };
  roleGrant: { deleteMany: Mock };
  membershipResult: { deleteMany: Mock };
  auditEvent: { create: Mock };
  $transaction: Mock;
}

const GUILD = '111111111111111111';
const ROLE = '444444444444444444';
const PROTECTED_ROLE = '555555555555555555';
const ACTOR = '333333333333333333';

const allowedGuild = {
  guildId: GUILD,
  settings: { assignableRoles: [ROLE], protectedRoleIds: [PROTECTED_ROLE] },
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makePrisma(): PrismaMock {
  const prisma: PrismaMock = {
    guild: { findUnique: vi.fn(), upsert: vi.fn() },
    verificationRule: {
      count: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    roleGrant: { deleteMany: vi.fn() },
    membershipResult: { deleteMany: vi.fn() },
    auditEvent: { create: vi.fn() },
    $transaction: vi.fn(async (cb: (tx: PrismaMock) => Promise<unknown>) => cb(prisma)),
  };
  return prisma;
}

function ruleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    guildId: GUILD,
    kind: 'ORG',
    org: 'acme',
    repo: null,
    teamSlug: null,
    roleId: ROLE,
    recheckMinutes: 1440,
    requiredScopes: 'read:user,read:org',
    enabled: true,
    createdBy: ACTOR,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('rules service — getSettings', () => {
  it('returns empty settings when the guild has no row', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(null);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    await expect(svc.getSettings(GUILD)).resolves.toEqual({
      assignableRoles: [],
      protectedRoleIds: [],
    });
  });

  it('parses stored assignable roles from guild settings', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(allowedGuild);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    await expect(svc.getSettings(GUILD)).resolves.toEqual({
      assignableRoles: [ROLE],
      protectedRoleIds: [PROTECTED_ROLE],
    });
  });

  it('falls back to defaults when settings are malformed', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue({
      ...allowedGuild,
      settings: { assignableRoles: 'not-an-array' },
    });
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const settings = await svc.getSettings(GUILD);
    expect(settings.assignableRoles).toEqual([]);
    expect(settings.protectedRoleIds).toEqual([]);
  });
});

describe('rules service — addRule', () => {
  it('creates an ORG rule on the happy path', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(allowedGuild);
    prisma.verificationRule.count.mockResolvedValue(0);
    prisma.verificationRule.create.mockResolvedValue(ruleRow());
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const rule = await svc.addRule({
      guildId: GUILD,
      kind: 'ORG',
      org: 'acme',
      roleId: ROLE,
      createdBy: ACTOR,
    });

    expect(rule.kind).toBe('ORG');
    expect(rule.org).toBe('acme');
    expect(rule.requiredScopes).toBe('read:user,read:org');
    expect(prisma.verificationRule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'ORG', org: 'acme', roleId: ROLE, enabled: true }),
      }),
    );
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'rule.created' }) }),
    );
  });

  it('creates REPO and TEAM rules with their extra fields', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(allowedGuild);
    prisma.verificationRule.count.mockResolvedValue(0);
    prisma.verificationRule.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve(ruleRow(data)),
    );
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const repoRule = await svc.addRule({
      guildId: GUILD,
      kind: 'REPO',
      org: 'acme',
      repo: 'api',
      roleId: ROLE,
      createdBy: ACTOR,
    });
    expect(repoRule.repo).toBe('api');

    const teamRule = await svc.addRule({
      guildId: GUILD,
      kind: 'TEAM',
      org: 'acme',
      teamSlug: 'core',
      roleId: ROLE,
      createdBy: ACTOR,
    });
    expect(teamRule.teamSlug).toBe('core');
  });

  it('normalizes github.com org URLs', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(allowedGuild);
    prisma.verificationRule.count.mockResolvedValue(0);
    prisma.verificationRule.create.mockResolvedValue(ruleRow());
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const rule = await svc.addRule({
      guildId: GUILD,
      kind: 'ORG',
      org: 'https://github.com/acme/',
      roleId: ROLE,
      createdBy: ACTOR,
    });
    expect(rule.org).toBe('acme');
  });

  it('rejects invalid org names', async () => {
    const prisma = makePrisma();
    const svc = createRulesService({ prisma, logger: makeLogger() });

    await expect(
      svc.addRule({
        guildId: GUILD,
        kind: 'ORG',
        org: 'not valid!',
        roleId: ROLE,
        createdBy: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'invalid_org', expose: true });
  });

  it('requires a repo name for REPO rules', async () => {
    const prisma = makePrisma();
    const svc = createRulesService({ prisma, logger: makeLogger() });

    await expect(
      svc.addRule({ guildId: GUILD, kind: 'REPO', org: 'acme', roleId: ROLE, createdBy: ACTOR }),
    ).rejects.toMatchObject({ code: 'repo_required' });
  });

  it('rejects invalid repo names', async () => {
    const prisma = makePrisma();
    const svc = createRulesService({ prisma, logger: makeLogger() });

    await expect(
      svc.addRule({
        guildId: GUILD,
        kind: 'REPO',
        org: 'acme',
        repo: 'bad/name',
        roleId: ROLE,
        createdBy: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'invalid_repo' });
  });

  it('requires a team slug for TEAM rules', async () => {
    const prisma = makePrisma();
    const svc = createRulesService({ prisma, logger: makeLogger() });

    await expect(
      svc.addRule({ guildId: GUILD, kind: 'TEAM', org: 'acme', roleId: ROLE, createdBy: ACTOR }),
    ).rejects.toMatchObject({ code: 'team_required' });
  });

  it('rejects invalid team slugs', async () => {
    const prisma = makePrisma();
    const svc = createRulesService({ prisma, logger: makeLogger() });

    await expect(
      svc.addRule({
        guildId: GUILD,
        kind: 'TEAM',
        org: 'acme',
        teamSlug: 'bad slug',
        roleId: ROLE,
        createdBy: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'invalid_team_slug' });
  });

  it('rejects ORG rules that carry repo/team fields', async () => {
    const prisma = makePrisma();
    const svc = createRulesService({ prisma, logger: makeLogger() });

    await expect(
      svc.addRule({
        guildId: GUILD,
        kind: 'ORG',
        org: 'acme',
        repo: 'api',
        roleId: ROLE,
        createdBy: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'org_extra_fields' });
  });

  it('rejects re-check intervals below the minimum', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(allowedGuild);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    await expect(
      svc.addRule({
        guildId: GUILD,
        kind: 'ORG',
        org: 'acme',
        roleId: ROLE,
        recheckMinutes: 10,
        createdBy: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'bad_recheck_interval' });
  });

  it('honors an explicit re-check interval', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(allowedGuild);
    prisma.verificationRule.count.mockResolvedValue(0);
    prisma.verificationRule.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve(ruleRow(data)),
    );
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const rule = await svc.addRule({
      guildId: GUILD,
      kind: 'ORG',
      org: 'acme',
      roleId: ROLE,
      recheckMinutes: 60,
      createdBy: ACTOR,
    });
    expect(rule.recheckMinutes).toBe(60);
  });

  it('blocks roles that are not on the allowlist', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(allowedGuild);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    await expect(
      svc.addRule({
        guildId: GUILD,
        kind: 'ORG',
        org: 'acme',
        roleId: '777777777777777777',
        createdBy: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'role_not_allowlisted' });
    expect(prisma.verificationRule.create).not.toHaveBeenCalled();
  });

  it('blocks protected roles even when allowlisted', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue({
      ...allowedGuild,
      settings: {
        assignableRoles: [ROLE, PROTECTED_ROLE],
        protectedRoleIds: [PROTECTED_ROLE],
      },
    });
    const svc = createRulesService({ prisma, logger: makeLogger() });

    await expect(
      svc.addRule({
        guildId: GUILD,
        kind: 'ORG',
        org: 'acme',
        roleId: PROTECTED_ROLE,
        createdBy: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'role_protected' });
  });

  it('enforces the per-guild rule cap', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(allowedGuild);
    prisma.verificationRule.count.mockResolvedValue(25);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    await expect(
      svc.addRule({ guildId: GUILD, kind: 'ORG', org: 'acme', roleId: ROLE, createdBy: ACTOR }),
    ).rejects.toMatchObject({ code: 'rule_cap_reached' });
    expect(prisma.verificationRule.count).toHaveBeenCalledWith({
      where: { guildId: GUILD, enabled: true },
    });
  });

  it('allows a rule at 24 of 25 (cap boundary)', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(allowedGuild);
    prisma.verificationRule.count.mockResolvedValue(24);
    prisma.verificationRule.create.mockResolvedValue(ruleRow());
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const rule = await svc.addRule({
      guildId: GUILD,
      kind: 'ORG',
      org: 'acme',
      roleId: ROLE,
      createdBy: ACTOR,
    });
    expect(rule.id).toBe('rule-1');
  });
});

describe('rules service — removeRule', () => {
  it('returns removed:false when the rule is not found', async () => {
    const prisma = makePrisma();
    prisma.verificationRule.findFirst.mockResolvedValue(null);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    await expect(
      svc.removeRule({ guildId: GUILD, ruleId: 'nope', actorDiscordId: ACTOR }),
    ).resolves.toEqual({
      removed: false,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('deletes grants, results, and the rule inside a transaction', async () => {
    const prisma = makePrisma();
    prisma.verificationRule.findFirst.mockResolvedValue(ruleRow());
    const svc = createRulesService({ prisma, logger: makeLogger() });

    await expect(
      svc.removeRule({ guildId: GUILD, ruleId: 'rule-1', actorDiscordId: ACTOR }),
    ).resolves.toEqual({
      removed: true,
    });
    expect(prisma.roleGrant.deleteMany).toHaveBeenCalledWith({ where: { ruleId: 'rule-1' } });
    expect(prisma.membershipResult.deleteMany).toHaveBeenCalledWith({
      where: { ruleId: 'rule-1' },
    });
    expect(prisma.verificationRule.delete).toHaveBeenCalledWith({ where: { id: 'rule-1' } });
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'rule.removed' }) }),
    );
  });
});

describe('rules service — assignable roles', () => {
  it('adds a role to the allowlist', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(null);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const settings = await svc.addAssignableRole({
      guildId: GUILD,
      roleId: ROLE,
      actorDiscordId: ACTOR,
    });
    expect(settings.assignableRoles).toContain(ROLE);
    expect(prisma.guild.upsert).toHaveBeenCalled();
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'settings.assignable_role.added' }),
      }),
    );
  });

  it('is idempotent when the role is already allowlisted', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(allowedGuild);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const settings = await svc.addAssignableRole({
      guildId: GUILD,
      roleId: ROLE,
      actorDiscordId: ACTOR,
    });
    expect(settings.assignableRoles.filter((id) => id === ROLE)).toHaveLength(1);
  });

  it('removes a role from the allowlist', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(allowedGuild);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const settings = await svc.removeAssignableRole({
      guildId: GUILD,
      roleId: ROLE,
      actorDiscordId: ACTOR,
    });
    expect(settings.assignableRoles).not.toContain(ROLE);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'settings.assignable_role.removed' }),
      }),
    );
  });
});

describe('rules service — listRules', () => {
  it('returns rules ordered by creation', async () => {
    const prisma = makePrisma();
    prisma.verificationRule.findMany.mockResolvedValue([
      ruleRow(),
      ruleRow({ id: 'rule-2', kind: 'REPO', repo: 'api' }),
    ]);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const rules = await svc.listRules(GUILD);
    expect(rules).toHaveLength(2);
    expect(rules[0]?.requiredScopes).toBe('read:user,read:org');
    expect(prisma.verificationRule.findMany).toHaveBeenCalledWith({
      where: { guildId: GUILD },
      orderBy: { createdAt: 'asc' },
    });
  });
});

describe('rules service — protected roles', () => {
  it('adds a role to the protected list', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(null);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const settings = await svc.addProtectedRole({
      guildId: GUILD,
      roleId: ROLE,
      actorDiscordId: ACTOR,
    });
    expect(settings.protectedRoleIds).toContain(ROLE);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'settings.protected_role.added' }),
      }),
    );
  });

  it('is idempotent when the role is already protected', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(allowedGuild);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const settings = await svc.addProtectedRole({
      guildId: GUILD,
      roleId: PROTECTED_ROLE,
      actorDiscordId: ACTOR,
    });
    expect(settings.protectedRoleIds.filter((id) => id === PROTECTED_ROLE)).toHaveLength(1);
  });

  it('strips a newly protected role from the allowlist', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique
      .mockResolvedValueOnce({
        ...allowedGuild,
        settings: { assignableRoles: [ROLE], protectedRoleIds: [] },
      })
      .mockResolvedValueOnce({
        ...allowedGuild,
        settings: { assignableRoles: [ROLE], protectedRoleIds: [ROLE] },
      });
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const settings = await svc.addProtectedRole({
      guildId: GUILD,
      roleId: ROLE,
      actorDiscordId: ACTOR,
    });
    expect(settings.assignableRoles).not.toContain(ROLE);
    expect(settings.protectedRoleIds).toContain(ROLE);
  });

  it('removes a role from the protected list', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(allowedGuild);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const settings = await svc.removeProtectedRole({
      guildId: GUILD,
      roleId: PROTECTED_ROLE,
      actorDiscordId: ACTOR,
    });
    expect(settings.protectedRoleIds).not.toContain(PROTECTED_ROLE);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'settings.protected_role.removed' }),
      }),
    );
  });
});

describe('rules service — log channel', () => {
  it('sets the log channel', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue(null);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const settings = await svc.setLogChannel({
      guildId: GUILD,
      channelId: '222222222222222222',
      actorDiscordId: ACTOR,
    });
    expect(settings.logChannelId).toBe('222222222222222222');
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'settings.log_channel.set' }),
      }),
    );
  });

  it('clears the log channel', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue({
      ...allowedGuild,
      settings: { assignableRoles: [], protectedRoleIds: [], logChannelId: '222222222222222222' },
    });
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const settings = await svc.setLogChannel({
      guildId: GUILD,
      channelId: null,
      actorDiscordId: ACTOR,
    });
    expect(settings.logChannelId).toBeUndefined();
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'settings.log_channel.cleared' }),
      }),
    );
  });

  it('keeps the log channel key off settings when malformed', async () => {
    const prisma = makePrisma();
    prisma.guild.findUnique.mockResolvedValue({
      ...allowedGuild,
      settings: { assignableRoles: [], protectedRoleIds: [], logChannelId: 42 },
    });
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const settings = await svc.getSettings(GUILD);
    expect(settings.logChannelId).toBeUndefined();
  });
});

describe('rules service — audit query', () => {
  it('returns recent events newest first', async () => {
    const prisma = makePrisma();
    prisma.auditEvent.findMany = vi.fn().mockResolvedValue([
      {
        id: 'a2',
        actorDiscordId: ACTOR,
        action: 'rule.created',
        subject: 'rule-1',
        meta: {},
        at: new Date(2),
      },
      {
        id: 'a1',
        actorDiscordId: ACTOR,
        action: 'settings.assignable_role.added',
        subject: ROLE,
        meta: {},
        at: new Date(1),
      },
    ]);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    const events = await svc.listAuditEvents({ guildId: GUILD, limit: 5 });
    expect(events).toHaveLength(2);
    expect(events[0]?.action).toBe('rule.created');
    expect(prisma.auditEvent.findMany).toHaveBeenCalledWith({
      where: { guildId: GUILD },
      orderBy: { at: 'desc' },
      take: 5,
    });
  });

  it('clamps the limit into the 1..25 range', async () => {
    const prisma = makePrisma();
    prisma.auditEvent.findMany = vi.fn().mockResolvedValue([]);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    await svc.listAuditEvents({ guildId: GUILD, limit: 500 });
    expect(prisma.auditEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25 }));

    await svc.listAuditEvents({ guildId: GUILD, limit: 0 });
    expect(prisma.auditEvent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 1 }),
    );
  });

  it('defaults to 10 events when no limit is given', async () => {
    const prisma = makePrisma();
    prisma.auditEvent.findMany = vi.fn().mockResolvedValue([]);
    const svc = createRulesService({ prisma, logger: makeLogger() });

    await svc.listAuditEvents({ guildId: GUILD });
    expect(prisma.auditEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10 }));
  });
});
