import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

import { commands, type DiscordCommand } from '../src/discord/commands/index.js';

const REPOSITORY_URL = 'https://github.com/Ishannaik/mergeid';
const SUPPORT_DISCORD_URL = 'https://discord.gg/xpgQ2WxRNJ';
const COMMAND_DESCRIPTION = 'Show information about MergeID and its GitHub repository.';
const EMBED_DESCRIPTION =
  'MergeID is a privacy-first Discord bot that links Discord members to GitHub accounts, verifies organization, repository, and team membership, and assigns Discord roles.';

function requireInfoCommand(): DiscordCommand {
  const command = commands.find(({ data }) => data.name === 'info');
  expect(command, 'the shared registry should expose /info').toBeDefined();
  return command as DiscordCommand;
}

describe('/info command', () => {
  it('registers an options-free info command', () => {
    expect(requireInfoCommand().data).toMatchObject({
      name: 'info',
      description: COMMAND_DESCRIPTION,
      options: [],
    });
  });

  it('edits the deferred reply with the project, GitHub, and support links', async () => {
    const editReply = vi.fn(async () => undefined);
    const interaction = { editReply } as unknown as ChatInputCommandInteraction;

    await requireInfoCommand().execute(interaction);

    expect(editReply).toHaveBeenCalledOnce();
    expect(editReply).toHaveBeenCalledWith({
      embeds: [
        {
          color: 0x5865f2,
          title: 'MergeID',
          url: REPOSITORY_URL,
          description: EMBED_DESCRIPTION,
          fields: [
            {
              name: 'GitHub',
              value: `[View MergeID on GitHub](${REPOSITORY_URL})`,
              inline: false,
            },
            {
              name: 'Support Discord',
              value: `[Join the MergeID support server](${SUPPORT_DISCORD_URL})`,
              inline: false,
            },
          ],
        },
      ],
    });
  });
});
