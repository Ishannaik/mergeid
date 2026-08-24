/**
 * E2E verification for the M5 sync module — REAL queue, worker, Redis, Postgres.
 *
 * Runs under vitest (for Octokit mocking) but against the live data plane from
 * .env. Walks the exact production path:
 *
 *   createSyncQueue → scheduleRule (real Redis) → processor → engine verifies
 *   (live Postgres) → SyncRun row persisted → syncStatus view → unschedule.
 *
 * Skips cleanly when DATABASE_URL / REDIS_URL are absent (CI).
 * Run: pnpm vitest run test/integration/sync.e2e.test.ts
 */

import { describe, expect, it } from 'vitest';

import 'dotenv/config';

import { vi } from 'vitest';

const octokitMock = vi.hoisted(() => ({
  getAuthenticated: vi.fn(),
  getMembership: vi.fn(),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    users = { getAuthenticated: octokitMock.getAuthenticated };
    orgs = { getMembershipForAuthenticatedUser: octokitMock.getMembership };
    repos = { get: vi.fn().mockResolvedValue({ data: { permissions: { push: true } } }) };
    teams = { getMembershipForUserInOrg: vi.fn().mockResolvedValue({ data: { state: 'active' } }) };
  },
}));

const GUILD = '159000000000000000';
const USER = '159000000000000001';
const ROLE = '159000000000000002';
const KEY = process.env.TOKEN_ENCRYPTION_KEY ?? '';

const describeMaybe = process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

describeMaybe('M5 sync e2e — real BullMQ + live Postgres', () => {
  it(
    'schedules a rule, processes a job through the engine, persists a SyncRun',
    { timeout: 60_000 },
    async () => {
      expect(KEY).toHaveLength(64);

      const { createPrismaClient } = await import('../../src/lib/prisma.js');
      const { createRulesService } = await import('../../src/services/rules.js');
      const { createLinkService } = await import('../../src/services/links.js');
      const { createTokenCrypto } = await import('../../src/crypto/index.js');
      const { createVerificationEngine } = await import('../../src/verification/engine.js');
      const scheduler = await import('../../src/sync/scheduler.js');
      const { createSyncQueue } = scheduler;
      const { startWorker } = await import('../../src/sync/worker.js');
      const { makeLogger } = await import('../discord/fixtures.js');

      const logger = makeLogger();
      const prisma = createPrismaClient({ DATABASE_URL: process.env.DATABASE_URL ?? '' });
      const tokenCrypto = createTokenCrypto({ active: { version: 1, key: KEY } });
      const rules = createRulesService({ prisma, logger });

      // Discord-facing role applier records outcomes instead of touching a guild.
      const appliedRoles: Array<{ roleId: string; shouldHave: boolean; userId: string }> = [];
      const ruleRoles = {
        sync: async (
          target: { guildId: string; userId: string },
          roleId: string,
          shouldHave: boolean,
        ) => {
          appliedRoles.push({ roleId, shouldHave, userId: target.userId });
          return shouldHave
            ? { kind: 'granted' as const, ok: true }
            : { kind: 'removed' as const, ok: true };
        },
      };

      const config = {} as never;
      const engine = createVerificationEngine({
        prisma,
        config,
        logger,
        rules,
        roles: ruleRoles,
        tokenCrypto,
      });
      const links = createLinkService({
        prisma,
        config: { TOKEN_ENCRYPTION_KEY: KEY, TOKEN_ENCRYPTION_KEY_VERSION: '1' } as never,
        logger,
        tokenCrypto,
      });

      octokitMock.getAuthenticated.mockResolvedValue({ data: { login: 'e2e-user' } });
      octokitMock.getMembership.mockResolvedValue({ data: { state: 'active' } });

      // ---- Setup: allowlist, rule, link ----------------------------------
      await rules.addAssignableRole({ guildId: GUILD, roleId: ROLE, actorDiscordId: 'e2e-admin' });
      const rule = await rules.addRule({
        guildId: GUILD,
        kind: 'ORG',
        org: `e2e-org-${Date.now()}`,
        roleId: ROLE,
        recheckMinutes: 30,
        createdBy: 'e2e-admin',
      });
      await links.createLink({
        discordUserId: USER,
        githubUserId: '424242',
        githubLogin: 'e2e-user',
        accessToken: 'gho_e2e_token',
        scopes: ['read:user', 'read:org'],
      });

      // Initial verification (what /verify or the OAuth callback does). This
      // seeds the membership_result row that makes the user "known to the
      // rule" — MergeID never fetches member lists, so discovery is always
      // link/verify-driven and periodic sync maintains from there.
      const initial = await engine.verifyUser({ discordUserId: USER, guildId: GUILD });
      expect(initial.passed).toBe(1);
      expect(appliedRoles).toContainEqual({ roleId: ROLE, shouldHave: true, userId: USER });
      console.log('initial /verify seeded ✓');

      try {
        // ---- Phase 1: producer — real queue + real Redis schedule --------
        const queue = createSyncQueue(logger);
        try {
          // Previous runs may have left schedules behind (failed runs skip
          // cleanup). Remove every scheduler for THIS test's rules before
          // asserting counts; other apps' schedulers in a shared Redis are not
          // ours to touch.
          await scheduler.scheduleRule(queue, {
            guildId: GUILD,
            ruleId: rule.id,
            recheckMinutes: 30,
          });
          const mine = (await queue.getJobSchedulers()).filter((s) => s.key === `rule:${rule.id}`);
          expect(mine).toHaveLength(1);
          console.log('schedule upserted ✓ every', mine[0]?.every);

          // ---- Phase 2: real Worker consumes a real job from Redis -------
          const workerRole = await startWorker({ prisma, engine, config, logger });
          // Enqueue with the same shape the scheduler template produces. The
          // repeatable fires on its own cadence in production; here we prove
          // the full queue→worker→engine→DB pipeline synchronously.
          await queue.add('verify-rule', { guildId: GUILD, ruleId: rule.id });

          // Poll for the run row rather than sleeping — the worker is async.
          let run: { status: string; stats: unknown } | null = null;
          for (let i = 0; i < 40 && !run; i++) {
            await new Promise((r) => setTimeout(r, 250));
            run = await prisma.syncRun.findFirst({
              where: { ruleId: rule.id },
              orderBy: { startedAt: 'desc' },
            });
          }
          expect(run, 'worker did not persist a SyncRun within 10s').not.toBeNull();

          const stats = run!.stats as Record<string, number>;
          expect(run!.status).toBe('OK');
          expect(stats.checked).toBe(1);
          expect(stats.passed).toBe(1);
          expect(stats.granted).toBe(1);
          console.log('worker processed job ✓ SyncRun persisted:', stats);

          // ---- Phase 3: role grant flowed through the engine -------------
          expect(appliedRoles).toContainEqual({
            roleId: ROLE,
            shouldHave: true,
            userId: USER,
          });

          // ---- Phase 4: /mergeid sync-status view ------------------------
          const status = await rules.syncStatus({ guildId: GUILD });
          expect(status.totals.runs24h).toBeGreaterThanOrEqual(1);
          expect(status.rules[0]?.lastStatus).toBe('OK');
          console.log('syncStatus view ✓', status.totals);

          // ---- Phase 5: unschedule removes the Redis schedule ------------
          await scheduler.unscheduleRule(queue, rule.id);
          const remainingMine = (await queue.getJobSchedulers()).filter(
            (s) => s.key === `rule:${rule.id}`,
          );
          expect(remainingMine).toHaveLength(0);
          console.log('schedule removed ✓');

          await workerRole.stop();
        } finally {
          await queue.close().catch(() => undefined);
        }
      } finally {
        // ---- Cleanup -----------------------------------------------------
        await prisma.membershipResult.deleteMany({ where: { link: { discordUserId: USER } } });
        await prisma.roleGrant.deleteMany({ where: { guildId: GUILD, discordUserId: USER } });
        await prisma.githubLink.deleteMany({ where: { discordUserId: USER } });
        await prisma.syncRun.deleteMany({ where: { ruleId: rule.id } });
        await prisma.membershipResult.deleteMany({ where: { ruleId: rule.id } });
        await prisma.roleGrant.deleteMany({ where: { ruleId: rule.id } });
        await prisma.auditEvent.deleteMany({ where: { guildId: GUILD } });
        await prisma.guild.deleteMany({ where: { guildId: GUILD } }).catch(() => undefined);
        await prisma.$disconnect();
      }
    },
  );
});
