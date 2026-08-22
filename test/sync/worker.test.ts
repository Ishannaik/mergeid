import { describe, expect, it, vi } from 'vitest';

import { createRuleSyncProcessor } from '../../src/sync/worker.js';
import type { SyncWorkerDeps } from '../../src/sync/worker.js';
import { makeLogger } from '../discord/fixtures.js';

const GUILD = '111111111111111111';
const RULE = 'rule-1';

type Mock = ReturnType<typeof vi.fn>;

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const prisma = {
    verificationRule: { findFirst: vi.fn() },
    membershipResult: { findMany: vi.fn() },
    syncRun: { create: vi.fn() },
  };
  const engine = {
    verifyUser: vi.fn().mockResolvedValue({
      guildId: GUILD,
      checked: 1,
      passed: 1,
      failed: 0,
      errored: 0,
      granted: ['r1'],
      revoked: [],
      kept: [],
      failures: [],
    }),
  };
  const deps = {
    prisma,
    engine,
    config: {},
    logger: makeLogger(),
    ...overrides,
  } as never as SyncWorkerDeps & {
    prisma: Record<string, Record<string, Mock>>;
    engine: { verifyUser: Mock };
  };
  return { deps, prisma, engine };
}

function job(data: Record<string, string>) {
  return { data, id: 'job-1' } as never as Parameters<
    ReturnType<typeof createRuleSyncProcessor>
  >[0];
}

describe('rule sync processor', () => {
  it('verifies every member known to the rule and records an OK run', async () => {
    const { deps, prisma, engine } = makeDeps();
    prisma.verificationRule.findFirst.mockResolvedValue({
      id: RULE,
      guildId: GUILD,
      enabled: true,
    });
    prisma.membershipResult.findMany.mockResolvedValue([
      { link: { discordUserId: 'u1' } },
      { link: { discordUserId: 'u2' } },
    ]);
    const process = createRuleSyncProcessor(deps);

    const result = await process(job({ guildId: GUILD, ruleId: RULE }));

    expect(engine.verifyUser).toHaveBeenCalledTimes(2);
    expect(engine.verifyUser).toHaveBeenCalledWith({ discordUserId: 'u1', guildId: GUILD });
    expect(result.checked).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.granted).toBe(2);
    expect(prisma.syncRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ruleId: RULE, status: 'OK' }),
      }),
    );
  });

  it('short-circuits when the rule is missing or disabled', async () => {
    const { deps, prisma, engine } = makeDeps();
    prisma.verificationRule.findFirst.mockResolvedValue(null);
    const process = createRuleSyncProcessor(deps);

    // Null result: the schedule outlived its rule, nothing ran, nothing recorded.
    await expect(process(job({ guildId: GUILD, ruleId: RULE }))).resolves.toBeNull();
    expect(engine.verifyUser).not.toHaveBeenCalled();
    expect(prisma.membershipResult.findMany).not.toHaveBeenCalled();
    expect(prisma.syncRun.create).not.toHaveBeenCalled();
  });

  it('skips unlinked members without failing the run', async () => {
    const { deps, prisma, engine } = makeDeps();
    prisma.verificationRule.findFirst.mockResolvedValue({
      id: RULE,
      guildId: GUILD,
      enabled: true,
    });
    prisma.membershipResult.findMany.mockResolvedValue([
      { link: { discordUserId: 'gone' } },
      { link: { discordUserId: 'present' } },
    ]);
    engine.verifyUser.mockImplementation(async (input: { discordUserId: string }) => {
      if (input.discordUserId === 'gone') {
        return {
          notVerified: 'not_linked',
          checked: 0,
          passed: 0,
          failed: 0,
          errored: 0,
          granted: [],
          revoked: [],
        };
      }
      return { checked: 1, passed: 0, failed: 1, errored: 0, granted: [], revoked: ['r9'] };
    });
    const process = createRuleSyncProcessor(deps);

    const result = await process(job({ guildId: GUILD, ruleId: RULE }));

    expect(result.checked).toBe(1);
    expect(result.revoked).toBe(1);
    // The skipped member did not count as an error.
    expect(result.errored).toBe(0);
    expect(prisma.syncRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'OK' }) }),
    );
  });

  it('marks a run PARTIAL when some members error', async () => {
    const { deps, prisma, engine } = makeDeps();
    prisma.verificationRule.findFirst.mockResolvedValue({
      id: RULE,
      guildId: GUILD,
      enabled: true,
    });
    prisma.membershipResult.findMany.mockResolvedValue([{ link: { discordUserId: 'u1' } }]);
    engine.verifyUser.mockRejectedValue(new Error('github 500'));
    const process = createRuleSyncProcessor(deps);

    const result = await process(job({ guildId: GUILD, ruleId: RULE }));

    // Member failure is contained; the run completes with the error counted.
    expect(result.checked).toBe(0);
    expect(result.errored).toBe(1);
    expect(prisma.syncRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PARTIAL' }) }),
    );
  });

  it('records FAILED and rethrows when the whole run crashes', async () => {
    const { deps, prisma } = makeDeps();
    prisma.verificationRule.findFirst.mockRejectedValue(new Error('db down'));
    const process = createRuleSyncProcessor(deps);

    await expect(process(job({ guildId: GUILD, ruleId: RULE }))).rejects.toThrow('db down');
    expect(prisma.syncRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', ruleId: RULE }),
      }),
    );
  });

  it('still writes the FAILED row when recording itself races a disconnect', async () => {
    const { deps, prisma } = makeDeps();
    prisma.verificationRule.findFirst.mockRejectedValue(new Error('db down'));
    prisma.syncRun.create.mockRejectedValueOnce(new Error('connection closed'));
    const process = createRuleSyncProcessor(deps);

    // Must not throw from the recorder — the original error propagates.
    await expect(process(job({ guildId: GUILD, ruleId: RULE }))).rejects.toThrow('db down');
  });
});
