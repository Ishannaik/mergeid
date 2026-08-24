/**
 * E2E OAuth flow test (M6 #2) — the complete linking journey.
 *
 * Covers what the individual unit tests each see only a slice of:
 *   /link issues state+PKCE → user authorizes on GitHub → GET /oauth/callback
 *   → token exchange → profile fetch → encrypted link persisted → linked role
 *   granted → initial verification runs → success page.
 *
 * Boundaries mocked: GitHub HTTP (`src/github`), Discord gateway (fixtures).
 * Everything between — Fastify routing, state store, link service, crypto,
 * engine reconciliation logic — is the real implementation. The engine's DB
 * writes use an in-memory Prisma double so this suite runs anywhere; the live
 * data-plane path is covered by demo.test.ts and sync.e2e.test.ts.
 */

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryOAuthStateStore } from '../../src/oauth/state.js';
import { buildAuthorizeUrl } from '../../src/github/oauth.js';
import { createTokenCrypto } from '../../src/crypto/index.js';
import { createVerificationEngine } from '../../src/verification/engine.js';
import { createLinkedRoleService } from '../../src/discord/roles.js';
import { makeClient, makeGuild, makeLogger, makeRole } from '../discord/fixtures.js';
import type { Config } from '../../src/config/index.js';
import type { PrismaClient } from '../../src/lib/prisma.js';
import type { RulesService } from '../../src/services/rules.js';

vi.mock('../../src/github/index.js', () => ({
  exchangeCodeForToken: vi.fn(),
  fetchGithubProfile: vi.fn(),
}));

// The engine builds its own Octokit for the initial verification pass.
const octokitMock = vi.hoisted(() => ({
  getAuthenticated: vi.fn(),
}));
vi.mock('@octokit/rest', () => ({
  Octokit: class {
    users = { getAuthenticated: octokitMock.getAuthenticated };
    orgs = {
      getMembershipForAuthenticatedUser: vi.fn().mockResolvedValue({ data: { state: 'active' } }),
    };
    repos = { get: vi.fn().mockResolvedValue({ data: { permissions: { push: true } } }) };
    teams = {
      getMembershipForUserInOrg: vi.fn().mockResolvedValue({ data: { state: 'active' } }),
    };
  },
}));

import { exchangeCodeForToken, fetchGithubProfile } from '../../src/github/index.js';
import { registerOAuthRoutes } from '../../src/api/routes/oauth.js';

const GUILD_ID = '111111111111111111';
const USER_ID = '333333333333333333';
const LINKED_ROLE = '222222222222222222';
const RULE_ROLE = '444444444444444444';

const config = {
  GITHUB_CLIENT_ID: 'Iv1.e2etest',
  GITHUB_CLIENT_SECRET: 'e2e-secret',
  OAUTH_REDIRECT_URI: 'https://bot.example.com/oauth/callback',
  GITHUB_BASE_SCOPES: ['read:user', 'read:org'],
  MERGEID_LINKED_ROLE_ID: LINKED_ROLE,
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
} as unknown as Config;

/**
 * Minimal in-memory Prisma double for the tables the callback touches via
 * services/engine. Only the operations those code paths actually issue are
 * implemented; anything else failing loudly is a feature here.
 */
function makePrisma() {
  const guilds = new Map<string, { guildId: string; settings: unknown }>();
  const links = new Map<string, Record<string, unknown>>();
  const rules: Array<Record<string, unknown>> = [];
  const results = new Map<string, Record<string, unknown>>();
  const grants = new Map<string, Record<string, unknown>>();

  return {
    guild: {
      findUnique: vi.fn(
        async ({ where }: { where: { guildId: string } }) => guilds.get(where.guildId) ?? null,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { guildId: string };
          create: Record<string, unknown>;
        }) => {
          guilds.set(where.guildId, { ...(guilds.get(where.guildId) ?? {}), ...create } as never);
          return guilds.get(where.guildId);
        },
      ),
    },
    githubLink: {
      findUnique: vi.fn(
        async ({ where }: { where: { discordUserId: string } }) =>
          links.get(where.discordUserId) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `link-${links.size + 1}`, createdAt: new Date(), ...data };
        links.set(data.discordUserId as string, row);
        return row;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    },
    verificationRule: {
      findMany: vi.fn(async ({ where }: { where?: { guildId?: string } } = {}) =>
        rules.filter((r) => !where?.guildId || r.guildId === where.guildId),
      ),
    },
    membershipResult: {
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { linkId_ruleId: { linkId: string; ruleId: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const key = `${where.linkId_ruleId.linkId}:${where.linkId_ruleId.ruleId}`;
          const existing = results.get(key);
          const row = existing ? { ...existing, ...(update as object) } : { ...create, ...{} };
          results.set(key, row);
          return row;
        },
      ),
    },
    roleGrant: {
      findMany: vi.fn(async () => [...grants.values()]),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { guildId_discordUserId_roleId: { roleId: string } };
          create: Record<string, unknown>;
        }) => {
          const key = `${where.guildId_discordUserId_roleId.roleId}`;
          const row = { ...create };
          grants.set(key, row);
          return row;
        },
      ),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    auditEvent: { create: vi.fn(async () => ({})) },
    githubLinkUpdate: null,
  } as unknown as PrismaClient & {
    __secrets: Map<string, Record<string, unknown>>;
  };
}

/** A rules service double with one enabled ORG rule pointing at RULE_ROLE. */
function makeRules(): RulesService {
  return {
    listRules: vi.fn(async () => [
      {
        id: 'rule-1',
        guildId: GUILD_ID,
        kind: 'ORG' as const,
        org: 'acme',
        repo: null,
        teamSlug: null,
        roleId: RULE_ROLE,
        recheckMinutes: 1440,
        requiredScopes: 'read:user,read:org',
        enabled: true,
        createdAt: new Date(),
      },
    ]),
  } as unknown as RulesService;
}

describe('E2E OAuth flow — /link to verified roles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exchangeCodeForToken).mockResolvedValue({
      accessToken: 'gho_e2e_access_token',
      scopes: ['read:user', 'read:org'],
      tokenType: 'bearer',
    });
    vi.mocked(fetchGithubProfile).mockResolvedValue({ id: '424242', login: 'octocat' });
    octokitMock.getAuthenticated.mockResolvedValue({ data: { login: 'octocat' } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeEngineDeps() {
    const prisma = makePrisma();
    const tokenCrypto = createTokenCrypto({
      active: { version: 1, key: 'a'.repeat(64) },
    });
    const applied: Array<{ roleId: string; shouldHave: boolean }> = [];
    const ruleRoles = {
      sync: async (
        _target: { guildId: string; userId: string },
        roleId: string,
        shouldHave: boolean,
      ) => {
        applied.push({ roleId, shouldHave });
        return shouldHave
          ? { kind: 'granted' as const, ok: true }
          : { kind: 'removed' as const, ok: true };
      },
    };
    const engine = createVerificationEngine({
      prisma,
      config,
      logger: makeLogger(),
      rules: makeRules(),
      roles: ruleRoles,
      tokenCrypto,
    });
    /** Mirrors LinkService.createLink's write so the engine can read the link. */
    const seedLink = async (input: Record<string, unknown>) => {
      await prisma.githubLink.create({
        data: {
          discordUserId: input.discordUserId as string,
          githubUserId: input.githubUserId as string,
          githubLogin: input.githubLogin as string,
          tokenEncrypted: tokenCrypto.encrypt(input.accessToken as string),
          tokenScopes: (input.scopes as string[]).join(','),
          lastVerifiedAt: null,
        },
      });
    };
    return { engine, applied, seedLink };
  }

  async function runFlow(options: {
    guildId: string | null;
    engine: ReturnType<typeof createVerificationEngine> | null;
    clientBundle: ReturnType<typeof makeGuild>;
    /** Seeds the engine's Prisma with the link row during createLink. */
    prismaSeed?: (input: Record<string, unknown>) => Promise<void>;
  }) {
    const app = Fastify({ logger: false });
    const oauthState = createMemoryOAuthStateStore();

    // Step 1: /link — issue state bound to user+guild and build the URL.
    const issued = await oauthState.issue({
      discordUserId: USER_ID,
      guildId: options.guildId,
    });
    const authorizeUrl = buildAuthorizeUrl(config, {
      state: issued.state,
      codeChallenge: issued.codeChallenge,
    });
    expect(authorizeUrl).toContain('github.com/login/oauth/authorize');
    expect(authorizeUrl).toContain(`state=${issued.state}`);
    expect(authorizeUrl).toContain('code_challenge_method=S256');
    expect(authorizeUrl).not.toContain('code_verifier='); // PKCE verifier never travels in the URL

    // Step 2: linked-role grantor wired to a fixture guild client.
    const linkedRoles = createLinkedRoleService({
      config,
      logger: makeLogger(),
      getClient: () => makeClient(options.clientBundle.guild, GUILD_ID),
    });

    // A LinkService double that persists into the same fake Prisma the engine
    // reads, so the initial verification pass sees the fresh link — mirroring
    // how the real LinkService writes what the real engine later reads.
    const createdLinks: Array<Record<string, unknown>> = [];
    const links = {
      createLink:
        options.prismaSeed === undefined
          ? vi.fn(async (input: Record<string, unknown>) => {
              createdLinks.push(input);
              return { id: 'link-e2e' };
            })
          : vi.fn(async (input: Record<string, unknown>) => {
              createdLinks.push(input);
              await options.prismaSeed(input);
              return { id: 'link-e2e' };
            }),
    };

    registerOAuthRoutes(app, {
      config,
      logger: makeLogger(),
      oauthState,
      links: links as never,
      linkedRoles,
      engine: options.engine,
    });

    // Step 3: GitHub redirects back with the code.
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/callback?code=real-auth-code&state=${issued.state}`,
    });
    await app.close();
    return { res, createdLinks, oauthState, authorizeUrl };
  }

  it('completes the full happy path: link → role → verification → page', async () => {
    const bundle = makeGuild({ guildId: GUILD_ID });
    const { engine, applied, seedLink } = makeEngineDeps();

    const { res, createdLinks } = await runFlow({
      guildId: GUILD_ID,
      engine,
      clientBundle: bundle,
      prismaSeed: seedLink,
    });

    // Success page.
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Linked!');
    expect(res.body).toContain('@octocat');

    // Correct link persisted from exchanged token + fetched profile.
    expect(createdLinks).toHaveLength(1);
    expect(createdLinks[0]).toMatchObject({
      discordUserId: USER_ID,
      githubUserId: '424242',
      githubLogin: 'octocat',
      accessToken: 'gho_e2e_access_token',
      scopes: ['read:user', 'read:org'],
    });

    // Linked role granted via member.roles.add(roleObject, reason)…
    expect(bundle.add).toHaveBeenCalledTimes(1);
    expect(bundle.add).toHaveBeenCalledWith(
      expect.objectContaining({ id: LINKED_ROLE }),
      expect.stringContaining('linked'),
    );
    // …and the rule role granted by the initial verification pass.
    expect(applied).toContainEqual({ roleId: RULE_ROLE, shouldHave: true });

    // Page reports both outcomes.
    expect(res.body).toContain('1 role granted');
  });

  it('state is single-use: replaying the callback fails closed', async () => {
    const bundle = makeGuild({ guildId: GUILD_ID });
    const app = Fastify({ logger: false });
    const oauthState = createMemoryOAuthStateStore();
    const issued = await oauthState.issue({
      discordUserId: USER_ID,
      guildId: GUILD_ID,
    });
    const links = { createLink: vi.fn() } as never;
    const linkedRoles = createLinkedRoleService({
      config,
      logger: makeLogger(),
      getClient: () => makeClient(bundle.guild, GUILD_ID),
    });
    registerOAuthRoutes(app, {
      config,
      logger: makeLogger(),
      oauthState,
      links,
      linkedRoles,
      engine: null,
    });

    const first = await app.inject({
      method: 'GET',
      url: `/oauth/callback?code=a&state=${issued.state}`,
    });
    const replay = await app.inject({
      method: 'GET',
      url: `/oauth/callback?code=a&state=${issued.state}`,
    });
    await app.close();

    expect(first.statusCode).toBe(200);
    // Replay hits the "Link expired" branch — the nonce was consumed.
    expect(replay.statusCode).toBe(400);
    expect(replay.body).toContain('expired or was already used');
  });

  it('user denying authorization lands on the cancel page without a link', async () => {
    const bundle = makeGuild({ guildId: GUILD_ID });
    const app = Fastify({ logger: false });
    const links = { createLink: vi.fn() } as never;
    const linkedRoles = createLinkedRoleService({
      config,
      logger: makeLogger(),
      getClient: () => makeClient(bundle.guild, GUILD_ID),
    });
    registerOAuthRoutes(app, {
      config,
      logger: makeLogger(),
      oauthState: createMemoryOAuthStateStore(),
      links,
      linkedRoles,
      engine: null,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/oauth/callback?error=access_denied&error_description=The+user+has+denied+your+application',
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Authorization cancelled');
    expect(res.body).toContain('The user has denied'); // escaped description present
  });

  it('GitHub rejecting the token exchange surfaces a failure page, not a crash', async () => {
    vi.mocked(exchangeCodeForToken).mockRejectedValue(
      Object.assign(new Error('bad_verification_code'), { expose: false }),
    );
    const bundle = makeGuild({ guildId: GUILD_ID });
    const { res } = await runFlow({
      guildId: GUILD_ID,
      engine: null,
      clientBundle: bundle,
    });

    expect(res.statusCode).toBe(502);
    expect(res.body).toContain('Something went wrong');
    // No internals leak.
    expect(res.body).not.toContain('bad_verification_code');
    expect(bundle.add).not.toHaveBeenCalled();
  });

  it('DM-started links skip roles but still persist', async () => {
    const bundle = makeGuild({ guildId: GUILD_ID });
    const { res, createdLinks } = await runFlow({
      guildId: null,
      engine: null,
      clientBundle: bundle,
    });

    expect(res.statusCode).toBe(200);
    expect(createdLinks).toHaveLength(1);
    expect(bundle.add).not.toHaveBeenCalled();
    expect(res.body).toContain('DM');
  });

  it('role hierarchy refusal keeps the link and explains on the page', async () => {
    // Bot's highest role (5) is below the linked role (90): refusal expected.
    const bundle = makeGuild({
      guildId: GUILD_ID,
      roles: [makeRole({ id: LINKED_ROLE, position: 90 })],
      botHighestPosition: 5,
    });
    const { engine } = makeEngineDeps();
    const { res, createdLinks } = await runFlow({
      guildId: GUILD_ID,
      engine,
      clientBundle: bundle,
    });

    expect(res.statusCode).toBe(200);
    expect(createdLinks).toHaveLength(1); // link committed
    expect(res.body).toContain('could not be applied'); // advisory note
  });
});
