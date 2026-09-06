import { describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ChatInputCommandInteraction,
  type ClientOptions,
  type Interaction,
} from 'discord.js';
import { Agent } from 'undici';

import { startBot } from '../src/discord/client.js';
import type { DiscordCommand } from '../src/discord/commands/index.js';

const config = {
  token: 'synthetic-discord-token',
  applicationId: 'synthetic-application-id',
} as const;

class RestConfiguredClient {
  readonly listeners = new Map<string, (...args: unknown[]) => unknown>();
  readonly order: string[] = [];
  readonly interaction = this.createInteraction();
  readonly destroy = vi.fn(() => {
    if (this.destroyError) throw this.destroyError;
  });
  private restAgent: Agent | undefined;

  constructor(
    private readonly loginError?: Error,
    private readonly destroyError?: Error,
  ) {}

  setRestAgent(agent: Agent): void {
    this.restAgent = agent;
  }

  once(event: string, listener: (...args: unknown[]) => unknown): this {
    this.listeners.set(event, listener);
    return this;
  }

  on(event: string, listener: (...args: unknown[]) => unknown): this {
    this.listeners.set(event, listener);
    return this;
  }

  async login(token: string): Promise<string> {
    this.order.push(`login:${token}`);
    if (!this.restAgent || this.restAgent.closed) {
      throw new Error('Discord REST dispatcher was not ready before gateway login');
    }
    if (this.loginError) throw this.loginError;

    const listener = this.listeners.get(Events.InteractionCreate);
    if (!listener) throw new Error('interaction listener was not registered before login');
    await listener(this.interaction);
    return token;
  }

  private createInteraction(): Interaction {
    const interaction = {
      commandName: 'verify',
      isChatInputCommand: () => true,
      replied: false,
      deferred: false,
      user: { id: 'synthetic-user-id' },
      guildId: 'synthetic-guild-id',
      deferReply: vi.fn(async (options: { flags: MessageFlags }) => {
        if (!this.restAgent || this.restAgent.closed) {
          throw new Error('interaction acknowledgement transport was not ready');
        }
        interaction.deferred = true;
        return options;
      }),
      reply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    return interaction as unknown as Interaction;
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

function requireRestAgent(options: ClientOptions): Agent {
  const agent = options.rest?.agent;
  if (!(agent instanceof Agent)) {
    throw new Error('Discord client did not receive an Undici Agent before login');
  }
  return agent;
}

describe('startBot', () => {
  it('provides a durable REST dispatcher before the first interaction and closes it exactly once', async () => {
    const client = new RestConfiguredClient();
    let receivedOptions: ClientOptions | undefined;
    let close: MockInstance | undefined;
    const execute = vi.fn(async (interaction: ChatInputCommandInteraction) => {
      await interaction.editReply('done');
    });
    const command: DiscordCommand = {
      data: { name: 'verify', description: 'Verify an account.', type: 1 },
      execute,
    };

    const role = await startBot({
      config,
      commandList: [command],
      clientFactory: (options) => {
        receivedOptions = options;
        const agent = requireRestAgent(options);
        close = vi.spyOn(agent, 'close');
        client.setRestAgent(agent);
        return client;
      },
      log: createLog(),
    });

    const agent = requireRestAgent(receivedOptions!);
    expect(receivedOptions).toMatchObject({
      intents: [GatewayIntentBits.Guilds],
      rest: { agent },
    });
    expect(agent.closed).toBe(false);
    expect(client.order).toEqual([`login:${config.token}`]);
    expect(client.interaction.deferred).toBe(true);
    expect(execute).toHaveBeenCalledExactlyOnceWith(client.interaction);

    await Promise.all([role.stop(), role.stop()]);

    expect(client.destroy).toHaveBeenCalledOnce();
    expect(close?.mock.calls.filter((call) => call.length === 0)).toHaveLength(1);
    expect(agent.closed).toBe(true);
  });

  it('closes the dispatcher after failed startup without replacing the startup error', async () => {
    const startupError = new Error('gateway login failed');
    const cleanupError = new Error('client destroy failed');
    const client = new RestConfiguredClient(startupError, cleanupError);
    let close: MockInstance | undefined;
    let agent: Agent | undefined;

    await expect(
      startBot({
        config,
        clientFactory: (options) => {
          agent = requireRestAgent(options);
          close = vi.spyOn(agent, 'close');
          client.setRestAgent(agent);
          return client;
        },
        log: createLog(),
      }),
    ).rejects.toBe(startupError);

    expect(client.destroy).toHaveBeenCalledOnce();
    expect(close?.mock.calls.filter((call) => call.length === 0)).toHaveLength(1);
    expect(agent?.closed).toBe(true);
  });
});
