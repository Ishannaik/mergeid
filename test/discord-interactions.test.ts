import { describe, expect, it, vi } from 'vitest';
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';

import { createInteractionHandler } from '../src/discord/events/interaction-create.js';
import type { DiscordCommand } from '../src/discord/commands/index.js';

/**
 * Minimal generic interaction shape cast at the module boundary. Only the
 * members the handler observes are populated; everything else is left absent so
 * a stray access surfaces as a test failure rather than a silent pass.
 */
type FauxInteraction = {
  readonly commandName: string;
  readonly isChatInputCommand: () => boolean;
  readonly replied: boolean;
  readonly deferred: boolean;
  readonly user: { readonly id: string };
  readonly guildId: string | null;
  reply: (options: { content: string; flags: MessageFlags }) => Promise<unknown>;
  followUp: (options: { content: string; flags: MessageFlags }) => Promise<unknown>;
};

/** Identifiers shared across fixtures so log assertions can target them. */
const SENDER_ID = 'user-id';
const GUILD_ID = 'guild-id';
const COMMAND_NAME = 'verify';
const ORIGINAL_ERROR = new Error('boom from command handler');

const EPHEMERAL = MessageFlags.Ephemeral;

function baseInteraction(overrides: Partial<FauxInteraction> = {}): FauxInteraction {
  return {
    commandName: COMMAND_NAME,
    isChatInputCommand: () => true,
    replied: false,
    deferred: false,
    user: { id: SENDER_ID },
    guildId: GUILD_ID,
    reply: vi.fn(async () => undefined) as FauxInteraction['reply'],
    followUp: vi.fn(async () => undefined) as FauxInteraction['followUp'],
    ...overrides,
  };
}

/** A throwing command to exercise the failure paths. */
function throwingCommand(): DiscordCommand {
  return {
    data: { name: COMMAND_NAME, description: 'throws', type: 1 },
    execute: vi.fn(async () => {
      throw ORIGINAL_ERROR;
    }) as unknown as DiscordCommand['execute'],
  };
}

describe('createInteractionHandler', () => {
  it('ignores interactions that are not chat-input commands', async () => {
    const idleExecute = vi.fn(async () => undefined);
    const command: DiscordCommand = {
      data: { name: COMMAND_NAME, description: 'verify a GitHub account', type: 1 },
      execute: idleExecute,
    };
    const log = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    const interaction = baseInteraction({
      commandName: COMMAND_NAME,
      isChatInputCommand: () => false,
    });

    const handle = createInteractionHandler([command], log);
    await handle(interaction as unknown as ChatInputCommandInteraction);

    // An ignored interaction is never replied to, never logged, and never dispatched.
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(idleExecute).not.toHaveBeenCalled();
  });

  it('dispatches a known chat command and runs execute exactly once', async () => {
    const execute = vi.fn(async () => undefined);
    const command: DiscordCommand = {
      data: { name: COMMAND_NAME, description: 'verify a GitHub account', type: 1 },
      execute,
    };
    const log = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    const interaction = baseInteraction();

    const handle = createInteractionHandler([command], log);
    await handle(interaction as unknown as ChatInputCommandInteraction);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(interaction as unknown as ChatInputCommandInteraction);
    // A successful run neither replies with the safe messages nor logs a failure.
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('replies with the exact safe ephemeral message and warns for an unknown command', async () => {
    const log = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    const interaction = baseInteraction({
      commandName: 'nope-not-registered',
      guildId: GUILD_ID,
    });

    const handle = createInteractionHandler(
      [
        {
          data: { name: 'something-else', description: 'x', type: 1 },
          execute: vi.fn(),
        },
      ],
      log,
    );
    await handle(interaction as unknown as ChatInputCommandInteraction);

    // Unacknowledged path → exact safe reply, no followUp.
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Unknown command.',
      flags: EPHEMERAL,
    });
    expect(interaction.followUp).not.toHaveBeenCalled();

    // Structured warning includes the command/user/guild identifiers.
    expect(log.warn).toHaveBeenCalledTimes(1);
    const payload = log.warn.mock.calls[0]![0];
    expect(payload).toMatchObject({
      commandName: 'nope-not-registered',
      userId: SENDER_ID,
      guildId: GUILD_ID,
    });
    expect(payload).not.toHaveProperty('err'); // unknown command is not an error
    expect(log.error).not.toHaveBeenCalled();
  });

  it('replies with the exact safe ephemeral message and logs a structured error (incl. original error) when a handler throws before acknowledgment', async () => {
    const log = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    const interaction = baseInteraction({
      commandName: COMMAND_NAME,
      replied: false,
      deferred: false,
    });

    const handle = createInteractionHandler([throwingCommand()], log);
    await handle(interaction as unknown as ChatInputCommandInteraction);

    // Unacknowledged path → reply used (not followUp).
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Something went wrong while running this command.',
      flags: EPHEMERAL,
    });
    expect(interaction.followUp).not.toHaveBeenCalled();

    // Structured error retains the original thrown error plus command/user/guild ids.
    expect(log.error).toHaveBeenCalledTimes(1);
    const payload = log.error.mock.calls[0]![0];
    expect(payload).toMatchObject({
      commandName: COMMAND_NAME,
      userId: SENDER_ID,
      guildId: GUILD_ID,
    });
    // The original error object must be attached so callers preserve the stack cause.
    expect(payload.err).toBe(ORIGINAL_ERROR);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('uses followUp instead of reply when the interaction was already replied', async () => {
    const log = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    const interaction = baseInteraction({
      commandName: COMMAND_NAME,
      replied: true,
      deferred: false,
    });

    const handle = createInteractionHandler([throwingCommand()], log);
    await handle(interaction as unknown as ChatInputCommandInteraction);

    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: 'Something went wrong while running this command.',
      flags: EPHEMERAL,
    });
    expect(interaction.reply).not.toHaveBeenCalled();

    expect(log.error).toHaveBeenCalledTimes(1);
    const payload = log.error.mock.calls[0]![0];
    expect(payload).toMatchObject({
      commandName: COMMAND_NAME,
      userId: SENDER_ID,
      guildId: GUILD_ID,
    });
    expect(payload.err).toBe(ORIGINAL_ERROR);
  });

  it('uses followUp instead of reply when the interaction was deferred', async () => {
    const log = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    const interaction = baseInteraction({
      commandName: COMMAND_NAME,
      replied: false,
      deferred: true,
    });

    const handle = createInteractionHandler([throwingCommand()], log);
    await handle(interaction as unknown as ChatInputCommandInteraction);

    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: 'Something went wrong while running this command.',
      flags: EPHEMERAL,
    });
    expect(interaction.reply).not.toHaveBeenCalled();

    expect(log.error).toHaveBeenCalledTimes(1);
    const payload = log.error.mock.calls[0]![0];
    expect(payload).toMatchObject({
      commandName: COMMAND_NAME,
      userId: SENDER_ID,
      guildId: GUILD_ID,
    });
    expect(payload.err).toBe(ORIGINAL_ERROR);
  });
});
