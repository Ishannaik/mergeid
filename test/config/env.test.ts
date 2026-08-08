import { describe, expect, it } from 'vitest';

import { loadConfig, ConfigError } from '../../src/config/env.js';

/** Minimal valid env — every required key present with a plausible value. */
function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: 'discord-bot-token-for-tests',
    DISCORD_CLIENT_ID: '123456789012345678',
    GITHUB_CLIENT_ID: 'Iv1.testclientid',
    GITHUB_CLIENT_SECRET: 'github-client-secret-for-tests',
    OAUTH_REDIRECT_URI: 'https://bot.example.com/oauth/callback',
    PUBLIC_BASE_URL: 'https://bot.example.com',
    DATABASE_URL: 'postgresql://mergeid:mergeid@localhost:5432/mergeid',
    // 32 bytes as hex = 64 hex chars
    TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('accepts a complete valid environment', () => {
    const config = loadConfig(validEnv());

    expect(config.DISCORD_TOKEN).toBe('discord-bot-token-for-tests');
    expect(config.DISCORD_CLIENT_ID).toBe('123456789012345678');
    expect(config.GITHUB_CLIENT_ID).toBe('Iv1.testclientid');
    expect(config.OAUTH_REDIRECT_URI).toBe('https://bot.example.com/oauth/callback');
    expect(config.PUBLIC_BASE_URL).toBe('https://bot.example.com');
    expect(config.DATABASE_URL).toContain('postgresql://');
    expect(config.TOKEN_ENCRYPTION_KEY).toHaveLength(64);
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe('development');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.GITHUB_BASE_SCOPES).toEqual(['read:user', 'read:org']);
    expect(config.MERGEID_ROLES).toEqual(['bot', 'api', 'worker']);
  });

  it('fails loudly when a required variable is missing', () => {
    const env = validEnv({ DISCORD_TOKEN: undefined });
    delete env.DISCORD_TOKEN;

    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/DISCORD_TOKEN/);
  });

  it('rejects a TOKEN_ENCRYPTION_KEY that is not 32-byte hex', () => {
    expect(() => loadConfig(validEnv({ TOKEN_ENCRYPTION_KEY: 'tooshort' }))).toThrow(
      /TOKEN_ENCRYPTION_KEY/,
    );
  });

  it('parses MERGEID_ROLES and rejects unknown roles', () => {
    const config = loadConfig(validEnv({ MERGEID_ROLES: 'bot,api' }));
    expect(config.MERGEID_ROLES).toEqual(['bot', 'api']);

    expect(() => loadConfig(validEnv({ MERGEID_ROLES: 'bot,banana' }))).toThrow(/MERGEID_ROLES/);
  });

  it('leaves MERGEID_LINKED_ROLE_ID undefined when unset (feature off by default)', () => {
    expect(loadConfig(validEnv()).MERGEID_LINKED_ROLE_ID).toBeUndefined();
  });

  it('accepts a snowflake for MERGEID_LINKED_ROLE_ID and rejects anything else', () => {
    const config = loadConfig(validEnv({ MERGEID_LINKED_ROLE_ID: '987654321098765432' }));
    expect(config.MERGEID_LINKED_ROLE_ID).toBe('987654321098765432');

    for (const bad of ['not-a-snowflake', '123', '@Verified', '1234567890123456789012']) {
      expect(() => loadConfig(validEnv({ MERGEID_LINKED_ROLE_ID: bad }))).toThrow(
        /MERGEID_LINKED_ROLE_ID/,
      );
    }
  });

  it('keeps MERGEID_LINKED_ROLE_ID independent of MERGEID_ROLES', () => {
    const config = loadConfig(
      validEnv({ MERGEID_LINKED_ROLE_ID: '987654321098765432', MERGEID_ROLES: 'bot' }),
    );
    expect(config.MERGEID_ROLES).toEqual(['bot']);
    expect(config.MERGEID_LINKED_ROLE_ID).toBe('987654321098765432');
  });

  it('parses PORT as a number', () => {
    const config = loadConfig(validEnv({ PORT: '8080' }));
    expect(config.PORT).toBe(8080);
  });
});
