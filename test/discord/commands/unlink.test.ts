import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

import { executeUnlink } from '../../../src/discord/commands/unlink.js';
import { createLinkedRoleService } from '../../../src/discord/roles.js';
import type { Config } from '../../../src/config/index.js';
import type { LinkService } from '../../../src/services/index.js';
import { makeGuild, makeLogger, makeRole } from '../fixtures.js';

const ROLE_ID = '222222222222222222';
const USER_ID = '333333333333333333';

function linkedRoles(roleId: string | undefined) {
  return createLinkedRoleService({
    config: { MERGEID_LINKED_ROLE_ID: roleId } as Pick<Config, 'MERGEID_LINKED_ROLE_ID'>,
    logger: makeLogger(),
    getClient: () => null,
  });
}

function interaction(guildId: string | null, member: unknown): ChatInputCommandInteraction {
  return {
    user: { id: USER_ID },
    guildId,
    member,
    reply: vi.fn(),
  } as unknown as ChatInputCommandInteraction;
}

/** Content of the single ephemeral reply the command sent. */
function replyContent(it: ChatInputCommandInteraction): string {
  const reply = it.reply as unknown as ReturnType<typeof vi.fn>;
  expect(reply).toHaveBeenCalledTimes(1);
  return (reply.mock.calls[0]?.[0] as { content: string }).content;
}

describe('/unlink linked-role removal', () => {
  it('removes the role after a successful unlink', async () => {
    const { guild, member, remove } = makeGuild({ memberRoleIds: [ROLE_ID] });
    const links = {
      unlink: vi.fn().mockResolvedValue({ unlinked: true }),
    } as unknown as LinkService;
    const it = interaction(guild.id, member);

    await executeUnlink(it, { logger: makeLogger(), links, linkedRoles: linkedRoles(ROLE_ID) });

    expect(remove).toHaveBeenCalledTimes(1);
    expect(replyContent(it)).toContain('Unlinked.');
    expect(replyContent(it)).not.toContain('Heads up');
  });

  it('does not touch roles when nothing was linked', async () => {
    const { guild, member, remove } = makeGuild({ memberRoleIds: [ROLE_ID] });
    const links = {
      unlink: vi.fn().mockResolvedValue({ unlinked: false }),
    } as unknown as LinkService;
    const it = interaction(guild.id, member);

    await executeUnlink(it, { logger: makeLogger(), links, linkedRoles: linkedRoles(ROLE_ID) });

    expect(remove).not.toHaveBeenCalled();
    expect(replyContent(it)).toContain('No GitHub account is linked');
  });

  it('behaves exactly as before when the feature is disabled', async () => {
    const { guild, member, remove } = makeGuild({ memberRoleIds: [ROLE_ID] });
    const links = {
      unlink: vi.fn().mockResolvedValue({ unlinked: true }),
    } as unknown as LinkService;
    const it = interaction(guild.id, member);

    await executeUnlink(it, { logger: makeLogger(), links, linkedRoles: linkedRoles(undefined) });

    expect(remove).not.toHaveBeenCalled();
    expect(replyContent(it)).toBe(
      'Unlinked. Your GitHub token was revoked and local link data was deleted. Run `/link` to connect again.',
    );
  });

  it('still reports the unlink as done when the role sits above the bot', async () => {
    const { guild, member, remove } = makeGuild({
      roles: [makeRole({ id: ROLE_ID, position: 90 })],
      botHighestPosition: 5,
      memberRoleIds: [ROLE_ID],
    });
    const unlink = vi.fn().mockResolvedValue({ unlinked: true });
    const it = interaction(guild.id, member);

    await executeUnlink(it, {
      logger: makeLogger(),
      links: { unlink } as unknown as LinkService,
      linkedRoles: linkedRoles(ROLE_ID),
    });

    // The unlink stands; only the role change is reported as failed.
    expect(unlink).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    const content = replyContent(it);
    expect(content).toContain('Unlinked.');
    expect(content).toContain('could not be removed');
    expect(content).toContain("bot's own role sits below");
  });

  it('warns about the DM case without failing the unlink', async () => {
    const links = {
      unlink: vi.fn().mockResolvedValue({ unlinked: true }),
    } as unknown as LinkService;
    const it = interaction(null, null);

    await executeUnlink(it, { logger: makeLogger(), links, linkedRoles: linkedRoles(ROLE_ID) });

    const content = replyContent(it);
    expect(content).toContain('Unlinked.');
    expect(content).toContain('DM');
  });
});
