import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

import { executeLink } from '../../../src/discord/commands/link.js';
import { createLinkedRoleService } from '../../../src/discord/roles.js';
import { createMemoryOAuthStateStore } from '../../../src/oauth/state.js';
import type { Config } from '../../../src/config/index.js';
import type { LinkService } from '../../../src/services/index.js';
import type { OAuthStateStore } from '../../../src/oauth/index.js';
import { makeGuild, makeLogger, makeRole } from '../fixtures.js';

const ROLE_ID = '222222222222222222';
const USER_ID = '333333333333333333';

const config = {
  GITHUB_CLIENT_ID: 'Iv1.test',
  OAUTH_REDIRECT_URI: 'https://bot.example.com/oauth/callback',
  GITHUB_BASE_SCOPES: ['read:user'],
} as unknown as Config;

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

function stubEngine() {
  return {
    verifyUser: vi.fn().mockResolvedValue({ notVerified: 'no_rules' }),
  } as unknown as Parameters<typeof executeLink>[1]['engine'];
}

function replyContent(it: ChatInputCommandInteraction): string {
  const reply = it.reply as unknown as ReturnType<typeof vi.fn>;
  expect(reply).toHaveBeenCalledTimes(1);
  return (reply.mock.calls[0]?.[0] as { content: string }).content;
}

describe('/link', () => {
  it('records the invoking guild on the OAuth state so the callback can grant', async () => {
    const oauthState = createMemoryOAuthStateStore();
    const issue = vi.spyOn(oauthState, 'issue');
    const links = {
      getStatus: vi.fn().mockResolvedValue({ linked: false }),
    } as unknown as LinkService;
    const it = interaction('111111111111111111', null);

    await executeLink(it, {
      config,
      logger: makeLogger(),
      oauthState,
      links,
      linkedRoles: linkedRoles(ROLE_ID),
      engine: stubEngine(),
    });

    expect(issue).toHaveBeenCalledExactlyOnceWith({
      discordUserId: USER_ID,
      guildId: '111111111111111111',
    });
    expect(replyContent(it)).toContain('https://github.com/login/oauth/authorize');
  });

  it('records a null guild when run in a DM', async () => {
    const oauthState = createMemoryOAuthStateStore();
    const issue = vi.spyOn(oauthState, 'issue');
    const links = {
      getStatus: vi.fn().mockResolvedValue({ linked: false }),
    } as unknown as LinkService;

    await executeLink(interaction(null, null), {
      config,
      logger: makeLogger(),
      oauthState,
      links,
      linkedRoles: linkedRoles(ROLE_ID),
      engine: stubEngine(),
    });

    expect(issue).toHaveBeenCalledExactlyOnceWith({ discordUserId: USER_ID, guildId: null });
  });

  it('reconciles the role for an already-linked user who is missing it', async () => {
    const { guild, member, add } = makeGuild({ memberRoleIds: [] });
    const links = {
      getStatus: vi.fn().mockResolvedValue({ linked: true, githubLogin: 'octocat' }),
    } as unknown as LinkService;
    const it = interaction(guild.id, member);

    await executeLink(it, {
      config,
      logger: makeLogger(),
      oauthState: {} as OAuthStateStore,
      links,
      linkedRoles: linkedRoles(ROLE_ID),
      engine: stubEngine(),
    });

    expect(add).toHaveBeenCalledTimes(1);
    const content = replyContent(it);
    expect(content).toContain('Already linked');
    expect(content).not.toContain('Heads up');
  });

  it('re-running /link for a member who already has the role is a no-op', async () => {
    const { guild, member, add } = makeGuild({ memberRoleIds: [ROLE_ID] });
    const links = {
      getStatus: vi.fn().mockResolvedValue({ linked: true, githubLogin: 'octocat' }),
    } as unknown as LinkService;
    const it = interaction(guild.id, member);

    await executeLink(it, {
      config,
      logger: makeLogger(),
      oauthState: {} as OAuthStateStore,
      links,
      linkedRoles: linkedRoles(ROLE_ID),
      engine: stubEngine(),
    });

    expect(add).not.toHaveBeenCalled();
    expect(replyContent(it)).toContain('Already linked');
  });

  it('surfaces a hierarchy failure without hiding the link status', async () => {
    const { guild, member, add } = makeGuild({
      roles: [makeRole({ id: ROLE_ID, position: 90 })],
      botHighestPosition: 5,
    });
    const links = {
      getStatus: vi.fn().mockResolvedValue({ linked: true, githubLogin: 'octocat' }),
    } as unknown as LinkService;
    const it = interaction(guild.id, member);

    await executeLink(it, {
      config,
      logger: makeLogger(),
      oauthState: {} as OAuthStateStore,
      links,
      linkedRoles: linkedRoles(ROLE_ID),
      engine: stubEngine(),
    });

    expect(add).not.toHaveBeenCalled();
    const content = replyContent(it);
    expect(content).toContain('Already linked to GitHub **@octocat**');
    expect(content).toContain('could not be applied');
  });
});
