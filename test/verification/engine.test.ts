import { describe, expect, it, vi, beforeEach } from 'vitest';

import { createVerificationEngine } from '../../src/verification/engine.js';
import { createTokenCrypto } from '../../src/crypto/index.js';
import type { Config } from '../../src/config/index.js';
import { makeLogger } from '../discord/fixtures.js';

const KEY = '0'.repeat(64);

/** Main-line token crypto bound to the test key. */
const makeCrypto = () => createTokenCrypto({ active: { version: 1, key: KEY } });
const GUILD = '111111111111111111';
const USER = '333333333333333333';
const ROLE_A = '444444444444444444';
const ROLE_B = '555555555555555555';

// The engine builds `new Octokit({ auth })` and the real membership functions
// call octokit.orgs / repos / teams. We mock Octokit itself with the full
// surface so the real membership logic runs against controllable doubles.
const octokitMock = vi.hoisted(() => ({
  getAuthenticated: vi.fn(),
  orgs: { getMembershipForAuthenticatedUser: vi.fn() },
  repos: { get: vi.fn() },
  teams: { getMembershipForUserInOrg: vi.fn() },
}));

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    users = { getAuthenticated: octokitMock.getAuthenticated };
    orgs = {
      getMembershipForAuthenticatedUser: octokitMock.orgs.getMembershipForAuthenticatedUser,
    };
    repos = { get: octokitMock.repos.get };
    teams = { getMembershipForUserInOrg: octokitMock.teams.getMembershipForUserInOrg };
  },
}));

const config = { TOKEN_ENCRYPTION_KEY: KEY } as unknown as Config;

type Mock = ReturnType<typeof vi.fn>;

interface PrismaMock {
  githubLink: { findUnique: Mock; update: Mock };
  membershipResult: { upsert: Mock };
  roleGrant: { findMany: Mock; upsert: Mock; deleteMany: Mock };
  auditEvent: { create: Mock };
  $transaction: Mock;
}

function makePrisma(): PrismaMock {
  return {
    githubLink: { findUnique: vi.fn(), update: vi.fn() },
    membershipResult: { upsert: vi.fn() },
    roleGrant: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    auditEvent: { create: vi.fn() },
    $transaction: vi.fn(),
  };
}

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    guildId: GUILD,
    kind: 'ORG',
    org: 'acme',
    repo: null,
    teamSlug: null,
    roleId: ROLE_A,
    recheckMinutes: 1440,
    requiredScopes: 'read:user,read:org',
    enabled: true,
    createdAt: new Date(),
    ...overrides,
  };
}

interface SetupOptions {
  rules?: ReturnType<typeof rule>[];
  link?: Record<string, unknown> | null;
  scopes?: string;
}

function setup(options: SetupOptions = {}) {
  const prisma = makePrisma();
  prisma.githubLink.findUnique.mockResolvedValue(
    options.link === null
      ? null
      : {
          id: 'link-1',
          githubUserId: '12345',
          githubLogin: 'octocat',
          tokenEncrypted: makeCrypto().encrypt('gho_test'),
          tokenScopes: options.scopes ?? 'read:user,read:org',
          lastVerifiedAt: null,
          ...(options.link ?? {}),
        },
  );
  prisma.roleGrant.findMany.mockResolvedValue([]);

  const rulesSvc = { listRules: vi.fn().mockResolvedValue(options.rules ?? []) };
  const roles = { sync: vi.fn().mockResolvedValue({ kind: 'granted', ok: true }) };
  const engine = createVerificationEngine({
    prisma,
    config,
    logger: makeLogger(),
    rules: rulesSvc,
    roles,
    tokenCrypto: makeCrypto(),
  });

  return { engine, prisma, rulesSvc, roles };
}

beforeEach(() => {
  octokitMock.getAuthenticated.mockReset().mockResolvedValue({ data: { login: 'octocat' } });
  octokitMock.orgs.getMembershipForAuthenticatedUser
    .mockReset()
    .mockResolvedValue({ data: { state: 'active' } });
  octokitMock.repos.get.mockReset().mockResolvedValue({
    data: { permissions: { push: true, pull: true } },
  });
  octokitMock.teams.getMembershipForUserInOrg
    .mockReset()
    .mockResolvedValue({ data: { state: 'active' } });
});

describe('verification engine — short-circuits', () => {
  it('returns not_linked when the user has no link', async () => {
    const { engine, rulesSvc } = setup({ link: null });

    const summary = await engine.verifyUser({ discordUserId: USER, guildId: GUILD });

    expect(summary.notVerified).toBe('not_linked');
    expect(rulesSvc.listRules).not.toHaveBeenCalled();
  });

  it('returns no_rules when the guild has no enabled rules', async () => {
    const { engine } = setup({ rules: [rule({ enabled: false })] });

    const summary = await engine.verifyUser({ discordUserId: USER, guildId: GUILD });

    expect(summary.notVerified).toBe('no_rules');
  });

  it('returns token_unavailable when the stored token cannot be decrypted', async () => {
    const { engine } = setup({ rules: [rule()], link: { tokenEncrypted: 'garbage' } });

    const summary = await engine.verifyUser({ discordUserId: USER, guildId: GUILD });

    expect(summary.notVerified).toBe('token_unavailable');
  });

  it('returns token_unavailable when GitHub rejects the token', async () => {
    octokitMock.getAuthenticated.mockRejectedValue(new Error('Bad credentials'));
    const { engine } = setup({ rules: [rule()] });

    const summary = await engine.verifyUser({ discordUserId: USER, guildId: GUILD });

    expect(summary.notVerified).toBe('token_unavailable');
    expect(octokitMock.orgs.getMembershipForAuthenticatedUser).not.toHaveBeenCalled();
  });
});

describe('verification engine — role reconciliation', () => {
  it('grants the role when an ORG rule passes', async () => {
    const { engine, prisma, roles } = setup({ rules: [rule()] });

    const summary = await engine.verifyUser({ discordUserId: USER, guildId: GUILD });

    expect(summary.checked).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.granted).toEqual([ROLE_A]);
    expect(roles.sync).toHaveBeenCalledWith({ guildId: GUILD, userId: USER }, ROLE_A, true);
    expect(prisma.roleGrant.upsert).toHaveBeenCalled();
    expect(prisma.membershipResult.upsert).toHaveBeenCalled();
    expect(prisma.githubLink.update).toHaveBeenCalled();
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'verification.completed' }),
      }),
    );
  });

  it('revokes the role when a previously-granted rule fails', async () => {
    octokitMock.orgs.getMembershipForAuthenticatedUser.mockResolvedValue({
      data: { state: 'pending' },
    });
    const { engine, prisma, roles } = setup({ rules: [rule()] });
    prisma.roleGrant.findMany.mockResolvedValue([
      { guildId: GUILD, discordUserId: USER, roleId: ROLE_A, ruleId: 'rule-1' },
    ]);
    roles.sync.mockResolvedValue({ kind: 'removed', ok: true });

    const summary = await engine.verifyUser({ discordUserId: USER, guildId: GUILD });

    expect(summary.failed).toBe(1);
    expect(summary.revoked).toEqual([ROLE_A]);
    expect(roles.sync).toHaveBeenCalledWith({ guildId: GUILD, userId: USER }, ROLE_A, false);
    expect(prisma.roleGrant.deleteMany).toHaveBeenCalled();
  });

  it('does not touch a role the rule never granted', async () => {
    octokitMock.orgs.getMembershipForAuthenticatedUser.mockResolvedValue({
      data: { state: 'pending' },
    });
    const { engine, roles } = setup({ rules: [rule()] });

    const summary = await engine.verifyUser({ discordUserId: USER, guildId: GUILD });

    expect(summary.failed).toBe(1);
    expect(summary.revoked).toEqual([]);
    expect(roles.sync).not.toHaveBeenCalled();
  });

  it('keeps last-known state when a membership check errors', async () => {
    octokitMock.orgs.getMembershipForAuthenticatedUser.mockRejectedValue(new Error('network'));
    const { engine, roles } = setup({ rules: [rule()] });

    const summary = await engine.verifyUser({ discordUserId: USER, guildId: GUILD });

    expect(summary.errored).toBe(1);
    expect(summary.granted).toEqual([]);
    expect(summary.revoked).toEqual([]);
    expect(roles.sync).not.toHaveBeenCalled();
  });

  it('marks ERROR and skips the check when required scopes are missing', async () => {
    const { engine, roles } = setup({ rules: [rule()], scopes: 'read:user' });

    const summary = await engine.verifyUser({ discordUserId: USER, guildId: GUILD });

    expect(summary.errored).toBe(1);
    expect(octokitMock.orgs.getMembershipForAuthenticatedUser).not.toHaveBeenCalled();
    expect(roles.sync).not.toHaveBeenCalled();
  });

  it('records sync failures in the summary', async () => {
    const { engine, roles } = setup({ rules: [rule()] });
    roles.sync.mockResolvedValue({ kind: 'role_above_bot', ok: false });

    const summary = await engine.verifyUser({ discordUserId: USER, guildId: GUILD });

    expect(summary.granted).toEqual([]);
    expect(summary.failures).toEqual([
      expect.objectContaining({ roleId: ROLE_A, kind: 'role_above_bot' }),
    ]);
  });
});

describe('verification engine — rule kinds', () => {
  it('checks repository push access for REPO rules', async () => {
    const { engine } = setup({ rules: [rule({ kind: 'REPO', org: 'acme', repo: 'api' })] });

    await engine.verifyUser({ discordUserId: USER, guildId: GUILD });

    expect(octokitMock.repos.get).toHaveBeenCalledWith({ owner: 'acme', repo: 'api' });
  });

  it('checks team membership for TEAM rules with the resolved username', async () => {
    const { engine } = setup({ rules: [rule({ kind: 'TEAM', org: 'acme', teamSlug: 'core' })] });

    await engine.verifyUser({ discordUserId: USER, guildId: GUILD });

    expect(octokitMock.teams.getMembershipForUserInOrg).toHaveBeenCalledWith({
      org: 'acme',
      team_slug: 'core',
      username: 'octocat',
    });
  });
});

describe('verification engine — mixed runs', () => {
  it('counts pass/fail/error and reconciles each role', async () => {
    octokitMock.orgs.getMembershipForAuthenticatedUser
      .mockResolvedValueOnce({ data: { state: 'active' } }) // rule-1 PASS
      .mockResolvedValueOnce({ data: { state: 'pending' } }) // rule-2 FAIL
      .mockRejectedValueOnce(new Error('boom')); // rule-3 ERROR

    const { engine, prisma, roles } = setup({
      rules: [
        rule({ id: 'rule-1', roleId: ROLE_A }),
        rule({ id: 'rule-2', roleId: ROLE_B }),
        rule({ id: 'rule-3', roleId: ROLE_A }),
      ],
    });
    prisma.roleGrant.findMany.mockResolvedValue([
      { guildId: GUILD, discordUserId: USER, roleId: ROLE_B, ruleId: 'rule-2' },
    ]);
    roles.sync.mockImplementation(async (_target: unknown, _roleId: string, shouldHave: boolean) =>
      shouldHave ? { kind: 'granted', ok: true } : { kind: 'removed', ok: true },
    );

    const summary = await engine.verifyUser({ discordUserId: USER, guildId: GUILD });

    expect(summary.checked).toBe(3);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.errored).toBe(1);
    expect(summary.granted).toEqual([ROLE_A]);
    expect(summary.revoked).toEqual([ROLE_B]);
    expect(roles.sync).toHaveBeenCalledTimes(2);
  });
});
