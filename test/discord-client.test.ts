import { describe, expect, it, vi } from 'vitest';
import {
  Events,
  GatewayIntentBits,
  type ChatInputCommandInteraction,
  type ClientOptions,
} from 'discord.js';

import { startBot } from '../src/discord/client.js';
import type { DiscordCommand } from '../src/discord/commands/index.js';

const config = {
  token: 'discord-token',
  applicationId: 'application-id',
} as const;

class FakeClient {
  readonly listeners = new Map<string, (...args: unknown[]) => unknown>();
  readonly order: string[] = [];
  destroyError?: Error;
  destroyGate?: Promise<void>;
  destroyCalls = 0;
  loginError?: Error;

  once(event: string, listener: (...args: unknown[]) => unknown): this {
    this.order.push(`once:${event}`);
    this.listeners.set(event, listener);
    return this;
  }

  on(event: string, listener: (...args: unknown[]) => unknown): this {
    this.order.push(`on:${event}`);
    this.listeners.set(event, listener);
    return this;
  }

  async login(token: string): Promise<string> {
    this.order.push(`login:${token}`);
    if (this.loginError) {
      throw this.loginError;
    }
    return token;
  }

  async destroy(): Promise<void> {
    this.destroyCalls += 1;
    if (this.destroyError) {
      throw this.destroyError;
    }
    await this.destroyGate;
  }
}

function createLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function chatInteraction(commandName: string): ChatInputCommandInteraction {
  return {
    commandName,
    isChatInputCommand: () => true,
    replied: false,
    deferred: false,
    user: { id: 'user-id' },
    guildId: 'guild-id',
    reply: vi.fn(),
    followUp: vi.fn(),
  } as unknown as ChatInputCommandInteraction;
}

describe('startBot', () => {
  it('uses only the Guilds intent, registers listeners before login, and routes interactions', async () => {
    const client = new FakeClient();
    let receivedOptions: ClientOptions | undefined;
    const clientFactory = vi.fn((options: ClientOptions) => {
      receivedOptions = options;
      return client;
    });
    const execute = vi.fn(async () => undefined);
    const command: DiscordCommand = {
      data: { name: 'verify', description: 'Verify an account.', type: 1 },
      execute,
    };

    const role = await startBot({
      config,
      commandList: [command],
      clientFactory,
      log: createLog(),
    });

    expect(receivedOptions).toEqual({ intents: [GatewayIntentBits.Guilds] });
    expect(client.order).toEqual([
      `once:${Events.ClientReady}`,
      `on:${Events.InteractionCreate}`,
      `on:${Events.Error}`,
      `login:${config.token}`,
    ]);
    expect(role.name).toBe('bot');

    const interaction = chatInteraction('verify');
    const interactionListener = client.listeners.get(Events.InteractionCreate);
    expect(interactionListener).toBeTypeOf('function');
    await interactionListener!(interaction);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(interaction);
  });

  it('handles gateway errors with structured logging before login', async () => {
    const client = new FakeClient();
    const log = createLog();
    await startBot({ config, clientFactory: () => client, log });

    const gatewayError = new Error('gateway disconnected');
    const errorListener = client.listeners.get(Events.Error);
    expect(errorListener).toBeTypeOf('function');
    await errorListener!(gatewayError);

    expect(log.error).toHaveBeenCalledWith({ err: gatewayError }, 'Discord gateway error');
    expect(client.order.indexOf(`on:${Events.Error}`)).toBeLessThan(
      client.order.indexOf(`login:${config.token}`),
    );
  });

  it('destroys the gateway client exactly once when stop is called repeatedly', async () => {
    const client = new FakeClient();
    const role = await startBot({
      config,
      clientFactory: () => client,
      log: createLog(),
    });

    await role.stop();
    await role.stop();
    await role.stop();

    expect(client.destroyCalls).toBe(1);
  });

  it('waits for asynchronous client destruction before stop resolves', async () => {
    const client = new FakeClient();
    let releaseDestroy!: () => void;
    client.destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    const role = await startBot({
      config,
      clientFactory: () => client,
      log: createLog(),
    });

    const stop = role.stop();
    const state = await Promise.race([stop.then(() => 'stopped'), Promise.resolve('pending')]);

    expect(state).toBe('pending');
    expect(client.destroyCalls).toBe(1);

    releaseDestroy();
    await expect(stop).resolves.toBeUndefined();
  });

  it('keeps stop non-throwing when client destruction fails', async () => {
    const client = new FakeClient();
    const log = createLog();
    const destroyError = new Error('destroy failed');
    client.destroyError = destroyError;
    const role = await startBot({ config, clientFactory: () => client, log });

    await expect(role.stop()).resolves.toBeUndefined();
    await expect(role.stop()).resolves.toBeUndefined();

    expect(client.destroyCalls).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      { err: destroyError },
      'Failed to destroy Discord gateway client',
    );
  });

  it('destroys the client and rethrows the same error when login fails', async () => {
    const client = new FakeClient();
    const loginError = new Error('login rejected');
    client.destroyError = new Error('cleanup rejected');
    client.loginError = loginError;

    let caught: unknown;
    try {
      await startBot({
        config,
        clientFactory: () => client,
        log: createLog(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(loginError);
    expect(client.destroyCalls).toBe(1);
  });
});
