import { describe, expect, it } from 'vitest';

import {
  createMemoryOAuthStateStore,
  OAuthStateError,
  type OAuthStateRecord,
} from '../../src/oauth/state.js';

describe('OAuth state store', () => {
  it('issues a state and consumes it exactly once', async () => {
    const store = createMemoryOAuthStateStore();
    const { state, codeChallenge } = await store.issue({
      discordUserId: 'discord-1',
      codeVerifier: 'verifier-abcdefghijklmnopqrstuvwxyz0123456789',
    });

    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);

    const first = await store.consume(state);
    expect(first).toEqual<OAuthStateRecord>({
      discordUserId: 'discord-1',
      codeVerifier: 'verifier-abcdefghijklmnopqrstuvwxyz0123456789',
      // Normalised to null when /link was invoked outside a guild.
      guildId: null,
    });

    await expect(store.consume(state)).rejects.toBeInstanceOf(OAuthStateError);
    await expect(store.consume(state)).rejects.toThrow(/expired|used|invalid/i);
  });

  it('rejects consume after TTL expiry', async () => {
    let now = 1_000_000;
    const store = createMemoryOAuthStateStore({
      now: () => now,
      ttlSeconds: 600,
    });

    const { state } = await store.issue({
      discordUserId: 'discord-2',
      codeVerifier: 'verifier-abcdefghijklmnopqrstuvwxyz0123456789',
    });

    now += 601_000;
    await expect(store.consume(state)).rejects.toBeInstanceOf(OAuthStateError);
  });

  it('binds the consumed record to the issuing Discord user', async () => {
    const store = createMemoryOAuthStateStore();
    const { state } = await store.issue({
      discordUserId: 'only-this-user',
      codeVerifier: 'verifier-abcdefghijklmnopqrstuvwxyz0123456789',
    });

    const record = await store.consume(state);
    expect(record.discordUserId).toBe('only-this-user');
  });

  it('round-trips the guild id so the OAuth callback can apply the linked role', async () => {
    const store = createMemoryOAuthStateStore();
    const { state } = await store.issue({
      discordUserId: 'discord-3',
      guildId: '111111111111111111',
      codeVerifier: 'verifier-abcdefghijklmnopqrstuvwxyz0123456789',
    });

    const record = await store.consume(state);
    expect(record.guildId).toBe('111111111111111111');
  });
});

describe('PKCE helpers', () => {
  it('produces an S256 challenge matching the verifier', async () => {
    const { createCodeChallenge, generateCodeVerifier } = await import('../../src/oauth/pkce.js');
    const verifier = generateCodeVerifier();
    const challenge = createCodeChallenge(verifier);

    // Fixed test vector from RFC 7636 appendix B (base64url S256).
    expect(createCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    expect(challenge).not.toBe(verifier);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });
});
