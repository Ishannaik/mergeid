import { describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';

import { createInteractionHandler } from '../src/discord/events/interaction-create.js';
import type { DiscordCommand } from '../src/discord/commands/index.js';

/** The payloads the router hands to each response method. */
type DeferOptions = { flags: MessageFlags };
type EphemeralMessage = { content: string; flags: MessageFlags };
type EditMessage = { content: string };

/**
 * The shape of a single response double. Naming the payload keeps the recorded
 * calls typed, so `.mock` is readable without a cast and the call assertions
 * still compare the exact object the router sent.
 */
type Respond<Options> = (options: Options) => Promise<unknown>;

/**
 * Minimal generic interaction shape cast at the module boundary. Only the
 * members the handler observes are populated; everything else is left absent so
 * a stray access surfaces as a test failure rather than a silent pass.
 */
type FauxInteraction = {
  readonly commandName: string;
  readonly isChatInputCommand: () => boolean;
  replied: boolean;
  deferred: boolean;
  readonly user: { readonly id: string };
  readonly guildId: string | null;
  deferReply: Mock<Respond<DeferOptions>>;
  reply: Mock<Respond<EphemeralMessage>>;
  editReply: Mock<Respond<EditMessage>>;
  followUp: Mock<Respond<EphemeralMessage>>;
};

/** Identifiers shared across fixtures so log assertions can target them. */
const SENDER_ID = 'user-id';
const GUILD_ID = 'guild-id';
const COMMAND_NAME = 'verify';
const ORIGINAL_ERROR = new Error('boom from command handler');

const EPHEMERAL = MessageFlags.Ephemeral;
function baseInteraction(overrides: Partial<FauxInteraction> = {}): FauxInteraction {
  // `deferReply` flips the fixture's own flag, the way discord.js marks an
  // interaction deferred. The annotation is what lets the double close over the
  // object it belongs to, so the fixture needs no cast to build itself.
  const interaction: FauxInteraction = {
    commandName: COMMAND_NAME,
    isChatInputCommand: () => true,
    replied: false,
    deferred: false,
    user: { id: SENDER_ID },
    guildId: GUILD_ID,
    deferReply: vi.fn<Respond<DeferOptions>>(async () => {
      interaction.deferred = true;
    }),
    reply: vi.fn<Respond<EphemeralMessage>>(async () => undefined),
    editReply: vi.fn<Respond<EditMessage>>(async () => undefined),
    followUp: vi.fn<Respond<EphemeralMessage>>(async () => undefined),
  };
  return Object.assign(interaction, overrides);
}

/** A throwing command to exercise the failure paths. */
function throwingCommand(): DiscordCommand {
  return {
    data: { name: COMMAND_NAME, description: 'throws', type: 1 },
    execute: vi.fn(async () => {
      throw ORIGINAL_ERROR;
    }),
  };
}

/**
 * Every line the router logs follows pino's `(bindings, message)` convention,
 * but the logger port it depends on declares those methods as
 * `(...args: unknown[])`. Mirroring the port exactly keeps the double
 * substitutable and its recorded arguments `unknown`, so a payload has to be
 * narrowed before anything reads it.
 */
type LogCall = (...args: unknown[]) => void;

/** The bindings object a logger double was handed on its first call. */
function firstCallBindings(method: Mock<LogCall>): unknown {
  const [call] = method.mock.calls;
  if (call === undefined) {
    throw new Error('expected the logger method to have been called');
  }
  return call[0];
}

/**
 * The `err` binding of a structured log payload, proven at runtime instead of
 * asserted: a payload the router never produced fails the test here rather than
 * quietly comparing `undefined`.
 */
function errBindingOf(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || !('err' in payload)) {
    throw new Error('expected the log payload to carry an err binding');
  }
  return payload.err;
}

/** The tick Vitest stamps on a mock's first call, for ordering comparisons. */
function firstCallOrder(mock: MockInstance): number {
  const [order] = mock.mock.invocationCallOrder;
  if (order === undefined) {
    throw new Error('expected the mock to have been called');
  }
  return order;
}

describe('createInteractionHandler', () => {
  const createLog = () => ({
    warn: vi.fn<LogCall>(),
    error: vi.fn<LogCall>(),
    info: vi.fn<LogCall>(),
    debug: vi.fn<LogCall>(),
  });

  it('ignores interactions that are not chat-input commands', async () => {
    const execute = vi.fn(async () => undefined);
    const command: DiscordCommand = {
      data: { name: COMMAND_NAME, description: 'verify a GitHub account', type: 1 },
      execute,
    };
    const log = createLog();
    const interaction = baseInteraction({ isChatInputCommand: () => false });

    const handle = createInteractionHandler([command], log);
    await handle(interaction as unknown as ChatInputCommandInteraction);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('defers known commands ephemerally before dispatch', async () => {
    const execute = vi.fn(async () => undefined);
    const command: DiscordCommand = {
      data: { name: COMMAND_NAME, description: 'verify a GitHub account', type: 1 },
      execute,
    };
    const log = createLog();
    const interaction = baseInteraction();

    const handle = createInteractionHandler([command], log);
    await handle(interaction as unknown as ChatInputCommandInteraction);

    expect(interaction.deferReply).toHaveBeenCalledExactlyOnceWith({ flags: EPHEMERAL });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      interaction as unknown as ChatInputCommandInteraction,
    );
    expect(firstCallOrder(interaction.deferReply)).toBeLessThan(firstCallOrder(execute));
    expect(log.error).not.toHaveBeenCalled();
  });

  it('replies ephemerally and warns for an unknown command without deferring', async () => {
    const log = createLog();
    const interaction = baseInteraction({ commandName: 'nope-not-registered' });
    const handle = createInteractionHandler([], log);

    await handle(interaction as unknown as ChatInputCommandInteraction);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledExactlyOnceWith({
      content: 'Unknown command.',
      flags: EPHEMERAL,
    });
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
    const payload = firstCallBindings(log.warn);
    expect(payload).toMatchObject({
      commandName: 'nope-not-registered',
      userId: SENDER_ID,
      guildId: GUILD_ID,
    });
    expect(payload).not.toHaveProperty('err');
  });

  it('edits the private deferred response when a command throws', async () => {
    const log = createLog();
    const interaction = baseInteraction();
    const handle = createInteractionHandler([throwingCommand()], log);

    await handle(interaction as unknown as ChatInputCommandInteraction);

    expect(interaction.deferReply).toHaveBeenCalledExactlyOnceWith({ flags: EPHEMERAL });
    expect(interaction.editReply).toHaveBeenCalledExactlyOnceWith({
      content: 'Something went wrong while running this command.',
    });
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
    const payload = firstCallBindings(log.error);
    expect(payload).toMatchObject({
      commandName: COMMAND_NAME,
      userId: SENDER_ID,
      guildId: GUILD_ID,
    });
    expect(errBindingOf(payload)).toBe(ORIGINAL_ERROR);
  });

  it('uses an ephemeral followUp when a command fails after replying', async () => {
    const log = createLog();
    const interaction = baseInteraction();
    const command = throwingCommand();
    command.execute = vi.fn(async () => {
      interaction.replied = true;
      throw ORIGINAL_ERROR;
    });
    const handle = createInteractionHandler([command], log);

    await handle(interaction as unknown as ChatInputCommandInteraction);

    expect(interaction.followUp).toHaveBeenCalledExactlyOnceWith({
      content: 'Something went wrong while running this command.',
      flags: EPHEMERAL,
    });
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(errBindingOf(firstCallBindings(log.error))).toBe(ORIGINAL_ERROR);
  });
});
