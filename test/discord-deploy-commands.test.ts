import { describe, expect, it, vi } from 'vitest';
import { Routes, type RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import { readDiscordConfig } from '../src/discord/config.js';
import { deployCommands } from '../src/discord/deploy-commands.js';
import { commands } from '../src/discord/commands/index.js';
import * as deployCommandModule from '../src/discord/deploy-commands.js';

/**
 * Two distinct command bodies used across the deployment suites. They mirror the
 * raw JSON shape the Discord REST API accepts (SlashCommandBuilder.toJSON()).
 */
const pingCommand: RESTPostAPIApplicationCommandsJSONBody = {
  name: 'ping',
  description: 'Ping the bot.',
  type: 1,
};

const verifyCommand: RESTPostAPIApplicationCommandsJSONBody = {
  name: 'verify',
  description: 'Verify your GitHub account.',
  type: 1,
};

const commandBodies: RESTPostAPIApplicationCommandsJSONBody[] = [pingCommand, verifyCommand];

/**
 * The registry handed to `deployCommands` is a list of command definitions,
 * each carrying its raw REST body under `.data`. The implementation must PUT
 * exactly those `.data` values — i.e. `[pingCommand, verifyCommand]` — so the
 * fixtures wrap the bodies rather than passing them bare.
 */
const commandDefinitions = [
  { data: pingCommand, execute: vi.fn() },
  { data: verifyCommand, execute: vi.fn() },
];
describe('readDiscordConfig', () => {
  it('returns token and applicationId and omits devGuildId when the dev guild is absent', async () => {
    const config = readDiscordConfig({
      DISCORD_TOKEN: 'a-real-token',
      DISCORD_CLIENT_ID: 'client-id',
    });

    expect(config.token).toBe('a-real-token');
    expect(config.applicationId).toBe('client-id');
    expect(config).not.toHaveProperty('devGuildId');
  });

  it('exposes devGuildId only when the dev guild is explicitly provided', async () => {
    const config = readDiscordConfig({
      DISCORD_TOKEN: 'a-real-token',
      DISCORD_CLIENT_ID: 'client-id',
      DISCORD_DEV_GUILD_ID: 'dev-guild-id',
    });

    expect(config.devGuildId).toBe('dev-guild-id');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('rejects a %s DISCORD_TOKEN without leaking the value', (_label, value) => {
    expect(() =>
      readDiscordConfig({
        DISCORD_TOKEN: value,
        DISCORD_CLIENT_ID: 'client-id',
      }),
    ).toThrow();

    // No error path should echo the secret around in an identifiable form.
    try {
      readDiscordConfig({
        DISCORD_TOKEN: value,
        DISCORD_CLIENT_ID: 'client-id',
      });
    } catch (error) {
      expect(String(error)).not.toContain('secret-token-canary');
    }
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('rejects a %s DISCORD_CLIENT_ID', (_label, value) => {
    expect(() =>
      readDiscordConfig({
        DISCORD_TOKEN: 'a-real-token',
        DISCORD_CLIENT_ID: value,
      }),
    ).toThrow();
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('rejects an explicitly %s DISCORD_DEV_GUILD_ID', (_label, value) => {
    expect(() =>
      readDiscordConfig({
        DISCORD_TOKEN: 'a-real-token',
        DISCORD_CLIENT_ID: 'client-id',
        DISCORD_DEV_GUILD_ID: value,
      }),
    ).toThrow();
  });

  it('treats a deliberately injected secret canary as never exfiltrated through thrown errors', () => {
    const canary = 'secret-token-canary';
    try {
      readDiscordConfig({
        DISCORD_TOKEN: canary,
        DISCORD_CLIENT_ID: '',
      });
    } catch (error) {
      // The blank client id is the rejection cause, but the valid token must
      // still never be echoed back in the surfaced error text.
      expect(String(error)).not.toContain(canary);
    }
  });
});

describe('deployCommands', () => {
  const validConfig = {
    token: 'a-real-token',
    applicationId: 'application-id',
  } as const;

  const devConfig = {
    ...validConfig,
    devGuildId: 'dev-guild-id',
  } as const;

  const createRest = () => ({
    put: vi.fn().mockResolvedValue([]),
  });
  it('wires direct deployment to the shared command registry', async () => {
    const deploy = vi.fn().mockResolvedValue(undefined);
    const readConfig = vi.fn(() => validConfig);

    expect(deployCommandModule.runDeployCommands).toBeTypeOf('function');
    await deployCommandModule.runDeployCommands!({ deploy, readConfig });

    expect(readConfig).toHaveBeenCalledTimes(1);
    expect(deploy).toHaveBeenCalledExactlyOnceWith({
      config: validConfig,
      commandList: commands,
    });
  });

  it('loads the local environment before direct deployment uses the shared registry', async () => {
    const order: string[] = [];
    const deploy = vi.fn().mockResolvedValue(undefined);
    const loadEnvironment = vi.fn(() => {
      order.push('environment');
    });
    const run = () =>
      deployCommandModule.runDeployCommands!({
        deploy,
        readConfig: () => {
          order.push('config');
          return validConfig;
        },
      });
    const setExitCode = vi.fn();

    expect(deployCommandModule.runDeployEntrypoint).toBeTypeOf('function');
    await deployCommandModule.runDeployEntrypoint!({
      argv1: '/tmp/deploy-commands.js',
      moduleUrl: 'file:///tmp/deploy-commands.js',
      loadEnvironment,
      run,
      setExitCode,
    });

    expect(order).toEqual(['environment', 'config']);
    expect(deploy).toHaveBeenCalledExactlyOnceWith({
      config: validConfig,
      commandList: commands,
    });
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('keeps imports inert without loading the local environment', async () => {
    const loadEnvironment = vi.fn();
    const run = vi.fn().mockResolvedValue(undefined);

    await deployCommandModule.runDeployEntrypoint!({
      argv1: '/tmp/vitest.js',
      moduleUrl: 'file:///tmp/deploy-commands.js',
      loadEnvironment,
      run,
    });

    expect(loadEnvironment).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('logs direct deployment failures and sets a nonzero exit code', async () => {
    const error = new Error('deployment failed');
    const logError = vi.fn();
    const setExitCode = vi.fn();

    await deployCommandModule.runDeployEntrypoint!({
      argv1: '/tmp/deploy-commands.js',
      moduleUrl: 'file:///tmp/deploy-commands.js',
      run: vi.fn().mockRejectedValue(error),
      logError,
      setExitCode,
    });

    expect(logError).toHaveBeenCalledWith(
      { err: error },
      'Failed to register Discord application commands',
    );
    expect(setExitCode).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('bulk PUTs exactly the registry bodies to the global route when no guild is configured', async () => {
    const rest = createRest();

    await deployCommands({
      config: { token: validConfig.token, applicationId: validConfig.applicationId },
      commandList: commandDefinitions,
      rest,
    });

    expect(rest.put).toHaveBeenCalledTimes(1);

    const [route, options] = rest.put.mock.calls[0]!;
    expect(route).toBe(Routes.applicationCommands(validConfig.applicationId));
    expect(options).toEqual({ body: commandBodies });
    // The global guild-scoped route must never be reached here.
    expect(rest.put).not.toHaveBeenCalledWith(expect.stringContaining('guilds'), expect.anything());
  });

  it('bulk PUTs exactly the registry bodies to the guild route and never the global route when a dev guild is set', async () => {
    const rest = createRest();

    await deployCommands({
      config: {
        token: devConfig.token,
        applicationId: devConfig.applicationId,
        devGuildId: devConfig.devGuildId,
      },
      commandList: commandDefinitions,
      rest,
    });

    expect(rest.put).toHaveBeenCalledTimes(1);

    const [route, options] = rest.put.mock.calls[0]!;
    expect(route).toBe(
      Routes.applicationGuildCommands(devConfig.applicationId, devConfig.devGuildId),
    );
    expect(options).toEqual({ body: commandBodies });
    expect(rest.put).not.toHaveBeenCalledWith(
      Routes.applicationCommands(devConfig.applicationId),
      expect.anything(),
    );
  });

  it('PUTs the body exactly once (no retries or duplicate registrations)', async () => {
    const rest = createRest();

    await deployCommands({
      config: { token: validConfig.token, applicationId: validConfig.applicationId },
      commandList: commandDefinitions,
      rest,
    });

    expect(rest.put).toHaveBeenCalledTimes(1);
  });

  it('logs the command count and global scope without leaking the token', async () => {
    const log = vi.fn();
    const rest = createRest();

    await deployCommands({
      config: { token: 'a-real-token', applicationId: validConfig.applicationId },
      commandList: commandDefinitions,
      rest,
      log,
    });

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatchObject({
      count: commandBodies.length,
      scope: 'global',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('a-real-token');
  });

  it('logs the guild scope without leaking credentials or guild identifiers', async () => {
    const log = vi.fn();
    const rest = createRest();

    await deployCommands({
      config: {
        token: 'a-real-token',
        applicationId: validConfig.applicationId,
        devGuildId: 'dev-guild-id',
      },
      commandList: commandDefinitions,
      rest,
      log,
    });

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatchObject({
      count: commandBodies.length,
      scope: 'guild',
    });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('a-real-token');
    expect(logged).not.toContain('dev-guild-id');
  });

  it('bulk PUTs an empty body to clear global commands when the registry is empty', async () => {
    const rest = createRest();

    await deployCommands({
      config: { token: validConfig.token, applicationId: validConfig.applicationId },
      commandList: [],
      rest,
    });

    // A single bulk PUT is still performed (clearing commands is a real operation),
    // but the body must be exactly empty and the route must remain global.
    expect(rest.put).toHaveBeenCalledTimes(1);
    const [route, options] = rest.put.mock.calls[0]!;
    expect(route).toBe(Routes.applicationCommands(validConfig.applicationId));
    expect(options).toEqual({ body: [] });
  });
});
