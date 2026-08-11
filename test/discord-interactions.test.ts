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
  replied: boolean;
  deferred: boolean;
  readonly user: { readonly id: string };
  readonly guildId: string | null;
  deferReply: (options: { flags: MessageFlags }) => Promise<unknown>;
  reply: (options: { content: string; flags: MessageFlags }) => Promise<unknown>;
  editReply: (options: { content: string }) => Promise<unknown>;
  followUp: (options: { content: string; flags: MessageFlags }) => Promise<unknown>;
};

/** Identifiers shared across fixtures so log assertions can target them. */
const SENDER_ID = 'user-id';
const GUILD_ID = 'guild-id';
const COMMAND_NAME = 'verify';
const ORIGINAL_ERROR = new Error('boom from command handler');

const EPHEMERAL = MessageFlags.Ephemeral;
function baseInteraction(overrides: Partial<FauxInteraction> = {}): FauxInteraction {
  const interaction = {
    commandName: COMMAND_NAME,
    isChatInputCommand: () => true,
    replied: false,
    deferred: false,
    user: { id: SENDER_ID },
    guildId: GUILD_ID,
    deferReply: undefined,
    reply: vi.fn(async () => undefined) as FauxInteraction['reply'],
    editReply: vi.fn(async () => undefined) as FauxInteraction['editReply'],
    followUp: vi.fn(async () => undefined) as FauxInteraction['followUp'],
  } as unknown as FauxInteraction;
  interaction.deferReply = vi.fn(async () => {
    interaction.deferred = true;
  }) as FauxInteraction['deferReply'];
  return Object.assign(interaction, overrides);
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
  const createLog = () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
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
    expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[0]!,
    );
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
    const payload = log.warn.mock.calls[0]![0];
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
    const payload = log.error.mock.calls[0]![0];
    expect(payload).toMatchObject({
      commandName: COMMAND_NAME,
      userId: SENDER_ID,
      guildId: GUILD_ID,
    });
    expect(payload.err).toBe(ORIGINAL_ERROR);
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
    expect(log.error.mock.calls[0]![0].err).toBe(ORIGINAL_ERROR);
  });
});
