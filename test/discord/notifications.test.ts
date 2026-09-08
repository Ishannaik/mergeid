import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';

import { createAccountStateNotifier } from '../../src/discord/notifications.js';
import { makeLogger } from './fixtures.js';

const USER_ID = '333333333333333333';

function setup(options: { client?: Client | null; sendError?: unknown } = {}) {
  const send = vi.fn(async () => {
    if (options.sendError) throw options.sendError;
  });
  const fetch = vi.fn(async () => ({ send }));
  const client =
    options.client === undefined ? ({ users: { fetch } } as unknown as Client) : options.client;
  const logger = makeLogger();
  const notifier = createAccountStateNotifier({ logger, getClient: () => client });
  return { notifier, logger, fetch, send };
}

describe('account state notifications', () => {
  it('DMs the linked GitHub account after a link succeeds', async () => {
    const { notifier, fetch, send } = setup();

    await notifier.notify(USER_ID, { kind: 'linked', githubLogin: 'octocat' });

    expect(fetch).toHaveBeenCalledExactlyOnceWith(USER_ID);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      'Your MergeID account is now linked to GitHub **@octocat**.',
    );
  });

  it('DMs the user after their account is unlinked', async () => {
    const { notifier, send } = setup();

    await notifier.notify(USER_ID, { kind: 'unlinked' });

    expect(send).toHaveBeenCalledExactlyOnceWith(
      'Your GitHub account is no longer linked to MergeID.',
    );
  });

  it('DMs only the role-change counts for a verification update', async () => {
    const { notifier, send } = setup();

    await notifier.notify(USER_ID, {
      kind: 'updated',
      guildId: '111111111111111111',
      granted: 2,
      revoked: 1,
    });

    expect(send).toHaveBeenCalledExactlyOnceWith(
      'Your MergeID verification state changed in a Discord server: 2 roles granted, 1 role removed.',
    );
  });

  it('does not fail the committed state change when Discord is unavailable', async () => {
    const { notifier, logger } = setup({ client: null });

    await expect(notifier.notify(USER_ID, { kind: 'unlinked' })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      { userId: USER_ID, kind: 'unlinked' },
      'account state DM skipped: Discord gateway unavailable',
    );
  });

  it('does not fail the committed state change when Discord rejects the DM', async () => {
    const error = new Error('Cannot send messages to this user');
    const { notifier, logger } = setup({ sendError: error });

    await expect(
      notifier.notify(USER_ID, { kind: 'linked', githubLogin: 'octocat' }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      { err: error, userId: USER_ID, kind: 'linked' },
      'failed to send account state DM',
    );
  });
});
