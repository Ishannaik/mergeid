import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryOAuthStateStore } from '../../../src/oauth/state.js';
import { createLinkedRoleService } from '../../../src/discord/roles.js';
import { makeClient, makeGuild, makeLogger, makeRole } from '../../discord/fixtures.js';
import type { Config } from '../../../src/config/index.js';
import type { LinkService } from '../../../src/services/index.js';
import type { Logger } from '../../../src/lib/logger.js';

vi.mock('../../../src/github/index.js', () => ({
  exchangeCodeForToken: vi.fn(),
  fetchGithubProfile: vi.fn(),
}));

import { exchangeCodeForToken, fetchGithubProfile } from '../../../src/github/index.js';
import { registerOAuthRoutes } from '../../../src/api/routes/oauth.js';

const config = {
  GITHUB_CLIENT_ID: 'Iv1.test',
  GITHUB_CLIENT_SECRET: 'secret',
  OAUTH_REDIRECT_URI: 'https://bot.example.com/oauth/callback',
  GITHUB_BASE_SCOPES: ['read:user', 'read:org'],
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
} as unknown as Config;

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

/** Linked-role feature switched off — the default for the pre-existing tests. */
function disabledRoles() {
  return createLinkedRoleService({
    config: { MERGEID_LINKED_ROLE_ID: undefined },
    logger: makeLogger(),
    getClient: () => null,
  });
}

describe('GET /oauth/callback HTML escaping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('escapes attacker-controlled error_description (reflected XSS)', async () => {
    const app = Fastify({ logger: false });
    const oauthState = createMemoryOAuthStateStore();
    const links = { createLink: vi.fn() } as unknown as LinkService;
    registerOAuthRoutes(app, { config, logger, oauthState, links, linkedRoles: disabledRoles(), engine: null });

    const payload = '<script>alert(1)</script>';
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/callback?error=access_denied&error_description=${encodeURIComponent(payload)}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('&lt;script&gt;');
    expect(res.body).not.toContain('<script>');
    expect(res.body).not.toContain(payload);

    await app.close();
  });

  it('escapes untrusted github login on the success page', async () => {
    const app = Fastify({ logger: false });
    const oauthState = createMemoryOAuthStateStore();
    const { state } = await oauthState.issue({
      discordUserId: 'discord-xss',
      codeVerifier: 'verifier-abcdefghijklmnopqrstuvwxyz0123456789',
    });

    const evilLogin = `evil"><img src=x onerror=alert(1)><`;
    vi.mocked(exchangeCodeForToken).mockResolvedValue({
      accessToken: 'gho_test',
      scopes: ['read:user'],
      tokenType: 'bearer',
    });
    vi.mocked(fetchGithubProfile).mockResolvedValue({
      id: '42',
      login: evilLogin,
    });

    const createLink = vi.fn().mockResolvedValue({ id: 'link-1' });
    const links = { createLink } as unknown as LinkService;
    registerOAuthRoutes(app, { config, logger, oauthState, links, linkedRoles: disabledRoles(), engine: null });

    const res = await app.inject({
      method: 'GET',
      url: `/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('&lt;');
    expect(res.body).toContain('&quot;');
    expect(res.body).not.toContain(`@${evilLogin}`);
    expect(res.body).not.toContain('<img src=x onerror=');
    // Intentional markup around the escaped login must remain.
    expect(res.body).toMatch(/<strong>@[^<]*&lt;[^<]*<\/strong>/);

    await app.close();
  });
});

describe('GET /oauth/callback linked-role grant', () => {
  const ROLE_ID = '222222222222222222';
  const GUILD_ID = '111111111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exchangeCodeForToken).mockResolvedValue({
      accessToken: 'gho_test',
      scopes: ['read:user'],
      tokenType: 'bearer',
    });
    vi.mocked(fetchGithubProfile).mockResolvedValue({ id: '42', login: 'octocat' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function callback(options: {
    guildId: string | null;
    bundle: ReturnType<typeof makeGuild>;
    roleId?: string;
  }) {
    const app = Fastify({ logger: false });
    const oauthState = createMemoryOAuthStateStore();
    const { state } = await oauthState.issue({
      discordUserId: 'discord-1',
      guildId: options.guildId,
      codeVerifier: 'verifier-abcdefghijklmnopqrstuvwxyz0123456789',
    });
    const links = {
      createLink: vi.fn().mockResolvedValue({ id: 'link-1' }),
    } as unknown as LinkService;
    const linkedRoles = createLinkedRoleService({
      config: { MERGEID_LINKED_ROLE_ID: options.roleId ?? ROLE_ID },
      logger: makeLogger(),
      getClient: () => makeClient(options.bundle.guild, GUILD_ID),
    });

    registerOAuthRoutes(app, { config, logger, oauthState, links, linkedRoles, engine: null });
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    await app.close();
    return { res, links };
  }

  it('grants the role in the guild recorded at /link time', async () => {
    const bundle = makeGuild({ guildId: GUILD_ID });
    const { res } = await callback({ guildId: GUILD_ID, bundle });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Linked!');
    expect(bundle.add).toHaveBeenCalledTimes(1);
    expect(res.body).not.toContain('Heads up');
  });

  it('keeps the link and explains the failure when the role outranks the bot', async () => {
    const bundle = makeGuild({
      guildId: GUILD_ID,
      roles: [makeRole({ id: ROLE_ID, position: 90 })],
      botHighestPosition: 5,
    });
    const { res, links } = await callback({ guildId: GUILD_ID, bundle });

    // The link committed; only the role failed.
    expect(res.statusCode).toBe(200);
    expect(links.createLink).toHaveBeenCalledOnce();
    expect(res.body).toContain('is now linked');
    expect(res.body).toContain('could not be applied');
    expect(bundle.add).not.toHaveBeenCalled();
  });

  it('links normally when /link was run in a DM', async () => {
    const bundle = makeGuild({ guildId: GUILD_ID });
    const { res, links } = await callback({ guildId: null, bundle });

    expect(res.statusCode).toBe(200);
    expect(links.createLink).toHaveBeenCalledOnce();
    expect(res.body).toContain('DM');
    expect(bundle.add).not.toHaveBeenCalled();
  });
});
