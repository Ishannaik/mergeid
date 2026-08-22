/**
 * Integration demo — exercises the REAL MergeID services against the REAL
 * database (the dev bot's Postgres), with only the GitHub API boundary mocked
 * (the Octokit surface). This is the "feature demo": it shows the exact flow
 * the slash commands drive, minus the Discord interaction layer.
 *
 * Run: pnpm vitest run test/integration/demo.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import 'dotenv/config';

import { createPrismaClient } from '../../src/lib/prisma.js';
import { createLinkService, createRulesService } from '../../src/services/index.js';
import { createVerificationEngine } from '../../src/verification/engine.js';
import { makeLogger } from '../discord/fixtures.js';
import { createTokenCrypto } from '../../src/crypto/index.js';

const DEMO_USER = '999999999999999999';
const GUILD_ID = process.env.DISCORD_DEV_GUILD_ID ?? '1529918028236455967';
const CONTRIBUTOR_ROLE = '1530441368361767064';
const MAINTAINER_ROLE = '1530441365912162388';

const KEY = process.env.TOKEN_ENCRYPTION_KEY ?? '';

// This suite needs the live database — skip cleanly in CI where there is none.
const describeMaybe = process.env.DATABASE_URL ? describe : describe.skip;

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

describeMaybe('MergeID M3 — live feature demo', () => {
  it('walks the full verify → grant → revoke flow against the real database', async () => {
    expect(KEY, 'TOKEN_ENCRYPTION_KEY required from .env').toHaveLength(64);

    const log = (line: string) => console.log(`\n  ${line}`);
    const prisma = createPrismaClient({ DATABASE_URL: process.env.DATABASE_URL ?? '' });
    const rules = createRulesService({ prisma, logger: makeLogger() });
    const roleApplier = { sync: vi.fn() };

    const tokenCrypto = createTokenCrypto({ active: { version: 1, key: KEY } });
    const config = { TOKEN_ENCRYPTION_KEY: KEY } as never;
    const engine = createVerificationEngine({
      prisma,
      config,
      logger: makeLogger(),
      rules,
      roles: roleApplier,
      tokenCrypto,
    } as never);

    const createdRuleIds: string[] = [];
    const cleanup = async () => {
      await prisma.membershipResult.deleteMany({ where: { link: { discordUserId: DEMO_USER } } });
      await prisma.roleGrant.deleteMany({ where: { guildId: GUILD_ID, discordUserId: DEMO_USER } });
      await prisma.githubLink.deleteMany({ where: { discordUserId: DEMO_USER } });
      for (const id of createdRuleIds) {
        await prisma.membershipResult.deleteMany({ where: { ruleId: id } });
        await prisma.roleGrant.deleteMany({ where: { ruleId: id } });
        await prisma.verificationRule.deleteMany({ where: { id } });
      }
      await prisma.auditEvent.deleteMany({ where: { actorDiscordId: DEMO_USER } });
      await prisma.auditEvent.deleteMany({ where: { actorDiscordId: 'demo-admin' } });
      await prisma.$disconnect();
    };

    try {
      // ---- Step 0: baseline ----
      const before = await prisma.verificationRule.count({ where: { guildId: GUILD_ID } });
      log(`▶ STEP 0 — baseline: ${before} rules in the dev guild`);

      // ---- Step 1: admin allowlists roles (what /mergeid roles add does) ----
      log(`▶ STEP 1 — admin allowlists the Contributor + Maintainer roles`);
      await rules.addAssignableRole({
        guildId: GUILD_ID,
        roleId: CONTRIBUTOR_ROLE,
        actorDiscordId: 'demo-admin',
      });
      await rules.addAssignableRole({
        guildId: GUILD_ID,
        roleId: MAINTAINER_ROLE,
        actorDiscordId: 'demo-admin',
      });
      const settings = await rules.getSettings(GUILD_ID);
      log(
        `   allowlist now: ${settings.assignableRoles.length} role(s) — ${settings.assignableRoles.join(', ')}`,
      );

      // ---- Step 2: admin adds rules (what /mergeid rules add does) ----
      log(`▶ STEP 2 — admin adds two rules`);
      const orgRule = await rules.addRule({
        guildId: GUILD_ID,
        kind: 'ORG',
        org: 'ishannaik',
        roleId: CONTRIBUTOR_ROLE,
        createdBy: 'demo-admin',
      });
      createdRuleIds.push(orgRule.id);
      const repoRule = await rules.addRule({
        guildId: GUILD_ID,
        kind: 'REPO',
        org: 'ishannaik',
        repo: 'mergeid',
        roleId: MAINTAINER_ROLE,
        createdBy: 'demo-admin',
      });
      createdRuleIds.push(repoRule.id);
      log(`   org rule  → member of org "ishannaik" gets <@&${CONTRIBUTOR_ROLE}>`);
      log(`   repo rule → push access to "ishannaik/mergeid" gets <@&${MAINTAINER_ROLE}>`);

      // ---- Step 3: member links GitHub (what /link + OAuth callback do) ----
      log(`▶ STEP 3 — member completes OAuth; link persisted (encrypted token)`);
      const tokenCrypto = createTokenCrypto({ active: { version: 1, key: KEY } });
      const links = createLinkService({
        prisma,
        config: { TOKEN_ENCRYPTION_KEY: KEY, TOKEN_ENCRYPTION_KEY_VERSION: '1' } as never,
        logger: makeLogger(),
        tokenCrypto,
      });
      await links.createLink({
        discordUserId: DEMO_USER,
        githubUserId: '123456789',
        githubLogin: 'octocat-demo',
        accessToken: 'gho_demo_token',
        scopes: ['read:user', 'read:org'],
      });
      log(`   link row written for discord user ${DEMO_USER}`);

      // ---- Step 4: initial verification runs (what the callback triggers) ----
      octokitMock.getAuthenticated.mockResolvedValue({ data: { login: 'octocat-demo' } });
      octokitMock.orgs.getMembershipForAuthenticatedUser.mockResolvedValue({
        data: { state: 'active' },
      });
      octokitMock.repos.get.mockResolvedValue({
        data: { permissions: { push: true, pull: true } },
      });
      roleApplier.sync.mockImplementation(async (_t: unknown, _r: string, shouldHave: boolean) =>
        shouldHave ? { kind: 'granted', ok: true } : { kind: 'removed', ok: true },
      );

      log(`▶ STEP 4 — GitHub reports: org member ✓, push access ✓ — engine reconciles`);
      const first = await engine.verifyUser({ discordUserId: DEMO_USER, guildId: GUILD_ID });
      log(
        `   checked ${first.checked} · passed ${first.passed} · granted ${first.granted.length} role(s)`,
      );
      expect(first.granted).toEqual(expect.arrayContaining([CONTRIBUTOR_ROLE, MAINTAINER_ROLE]));

      const grants = await prisma.roleGrant.findMany({
        where: { guildId: GUILD_ID, discordUserId: DEMO_USER },
      });
      log(`   role_grants persisted: ${grants.map((g) => g.roleId).join(', ')}`);

      // ---- Step 5: user leaves the org — GitHub reports FAIL, engine revokes ----
      octokitMock.orgs.getMembershipForAuthenticatedUser.mockResolvedValue({
        data: { state: 'pending' },
      });
      log(`▶ STEP 5 — GitHub now reports: NOT in org. Engine re-verifies and revokes.`);
      const second = await engine.verifyUser({ discordUserId: DEMO_USER, guildId: GUILD_ID });
      log(
        `   checked ${second.checked} · failed ${second.failed} · revoked ${second.revoked.length} role(s)`,
      );
      expect(second.revoked).toEqual(expect.arrayContaining([CONTRIBUTOR_ROLE]));

      // ---- Step 6: GitHub outage — ERROR keeps last-known state ----
      octokitMock.orgs.getMembershipForAuthenticatedUser.mockRejectedValue(
        new Error('rate limited'),
      );
      log(`▶ STEP 6 — GitHub API errors (rate limit). Engine must NOT flip roles.`);
      const third = await engine.verifyUser({ discordUserId: DEMO_USER, guildId: GUILD_ID });
      log(
        `   errored ${third.errored} · granted ${third.granted.length} · revoked ${third.revoked.length} (last-known state kept)`,
      );
      expect(third.errored).toBeGreaterThan(0);
      expect(third.revoked).toHaveLength(0);

      // ---- Step 7: admin lists rules (what /mergeid rules list shows) ----
      log(`▶ STEP 7 — /mergeid rules list would show:`);
      for (const r of await rules.listRules(GUILD_ID)) {
        log(
          `   ${r.id.slice(0, 8)}…  ${r.kind} ${r.org}${r.repo ? '/' + r.repo : ''}${r.teamSlug ? '/' + r.teamSlug : ''} → ${r.roleId}`,
        );
      }

      console.log(
        '\n  ✅ DEMO COMPLETE — engine decisions, persistence, and audit all real against Postgres',
      );
    } finally {
      await cleanup();
    }
  }, 60000);
});
