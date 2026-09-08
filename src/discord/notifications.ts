import type { Logger } from '../lib/logger.js';

export type AccountStateChange =
  | { kind: 'linked'; githubLogin: string }
  | { kind: 'unlinked' }
  | { kind: 'updated'; guildId: string; granted: number; revoked: number };

export interface AccountStateNotifier {
  notify(discordUserId: string, change: AccountStateChange): Promise<void>;
}

/** The narrow, late-bound Discord gateway surface used to deliver account DMs. */
interface AccountStateGatewayClient {
  users: {
    fetch(discordUserId: string): Promise<{
      send(content: string): Promise<unknown>;
    }>;
  };
}

function messageFor(change: AccountStateChange): string {
  switch (change.kind) {
    case 'linked':
      return `Your MergeID account is now linked to GitHub **@${change.githubLogin}**.`;
    case 'unlinked':
      return 'Your GitHub account is no longer linked to MergeID.';
    case 'updated': {
      const changes = [
        change.granted > 0
          ? `${change.granted} ${change.granted === 1 ? 'role' : 'roles'} granted`
          : null,
        change.revoked > 0
          ? `${change.revoked} ${change.revoked === 1 ? 'role' : 'roles'} removed`
          : null,
      ].filter((entry): entry is string => entry !== null);
      return `Your MergeID verification state changed in a Discord server: ${changes.join(', ')}.`;
    }
  }
}

export function createAccountStateNotifier(deps: {
  logger: Logger;
  getClient: () => AccountStateGatewayClient | null;
}): AccountStateNotifier {
  return {
    async notify(discordUserId, change): Promise<void> {
      const client = deps.getClient();
      if (!client) {
        deps.logger.warn(
          { userId: discordUserId, kind: change.kind },
          'account state DM skipped: Discord gateway unavailable',
        );
        return;
      }

      try {
        const user = await client.users.fetch(discordUserId);
        await user.send(messageFor(change));
      } catch (err) {
        deps.logger.warn(
          { err, userId: discordUserId, kind: change.kind },
          'failed to send account state DM',
        );
      }
    },
  };
}
