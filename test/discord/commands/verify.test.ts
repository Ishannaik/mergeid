import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

import { executeVerify } from '../../../src/discord/commands/verify.js';
import { makeLogger } from '../fixtures.js';

const GUILD_ID = '111111111111111111';
const USER_ID = '333333333333333333';
const ROLE_A = '444444444444444444';
const ROLE_B = '555555555555555555';

function interaction(guildId: string | null): ChatInputCommandInteraction {
  return {
    user: { id: USER_ID },
    guildId,
    reply: vi.fn(),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn(),
  } as unknown as ChatInputCommandInteraction;
}

function engine(summary: Record<string, unknown>) {
  return { verifyUser: vi.fn().mockResolvedValue(summary) };
}

/** reply() takes {content, flags}; editReply() takes a plain string. */
function contentOf(fn: ReturnType<typeof vi.fn>): string {
  const arg = fn.mock.calls[0]?.[0];
  return typeof arg === 'string' ? arg : (arg as { content: string }).content;
}

describe('/verify', () => {
  it('replies without deferring when run in a DM', async () => {
    const it = interaction(null);
    const eng = engine({});

    await executeVerify(it, { logger: makeLogger(), engine: eng });

    expect(it.reply).toHaveBeenCalledTimes(1);
    expect(it.deferReply).not.toHaveBeenCalled();
    expect(contentOf(it.reply as ReturnType<typeof vi.fn>)).toContain('/verify');
    expect(eng.verifyUser).not.toHaveBeenCalled();
  });

  it('tells an unlinked user to run /link', async () => {
    const it = interaction(GUILD_ID);
    const eng = engine({ notVerified: 'not_linked' });

    await executeVerify(it, { logger: makeLogger(), engine: eng });

    expect(contentOf(it.editReply as ReturnType<typeof vi.fn>)).toContain('/link');
  });

  it('tells the user when the server has no rules', async () => {
    const it = interaction(GUILD_ID);
    const eng = engine({ notVerified: 'no_rules' });

    await executeVerify(it, { logger: makeLogger(), engine: eng });

    expect(contentOf(it.editReply as ReturnType<typeof vi.fn>)).toContain('/mergeid rules add');
  });

  it('tells the user when the token is unavailable', async () => {
    const it = interaction(GUILD_ID);
    const eng = engine({ notVerified: 'token_unavailable' });

    await executeVerify(it, { logger: makeLogger(), engine: eng });

    expect(contentOf(it.editReply as ReturnType<typeof vi.fn>)).toContain('/unlink');
  });

  it('reports a successful run with granted and revoked roles', async () => {
    const it = interaction(GUILD_ID);
    const eng = engine({
      checked: 2,
      passed: 1,
      failed: 1,
      errored: 0,
      granted: [ROLE_A],
      revoked: [ROLE_B],
      kept: [],
      failures: [],
    });

    await executeVerify(it, { logger: makeLogger(), engine: eng });

    const content = contentOf(it.editReply as ReturnType<typeof vi.fn>);
    expect(content).toContain('Verification complete');
    expect(content).toContain('2 rules checked');
    expect(content).toContain(`<@&${ROLE_A}>`);
    expect(content).toContain(`<@&${ROLE_B}>`);
  });

  it('uses singular wording for a single rule', async () => {
    const it = interaction(GUILD_ID);
    const eng = engine({ checked: 1, passed: 1, failed: 0, errored: 0, granted: [], revoked: [], kept: [], failures: [] });

    await executeVerify(it, { logger: makeLogger(), engine: eng });

    expect(contentOf(it.editReply as ReturnType<typeof vi.fn>)).toContain('1 rule checked');
  });

  it('warns when some role changes failed', async () => {
    const it = interaction(GUILD_ID);
    const eng = engine({
      checked: 1,
      passed: 1,
      failed: 0,
      errored: 0,
      granted: [],
      revoked: [],
      kept: [],
      failures: [{ roleId: ROLE_A, kind: 'role_above_bot' }],
    });

    await executeVerify(it, { logger: makeLogger(), engine: eng });

    expect(contentOf(it.editReply as ReturnType<typeof vi.fn>)).toContain('role position');
  });
});
