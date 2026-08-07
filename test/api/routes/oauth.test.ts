import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryOAuthStateStore } from '../../../src/oauth/state.js';
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
    registerOAuthRoutes(app, { config, logger, oauthState, links });

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
    registerOAuthRoutes(app, { config, logger, oauthState, links });

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
