/**
 * Rule-role applier — grants/revokes the role a verification rule points at.
 *
 * Shares every preflight rail with the linked-role service (`preflight.ts`):
 * the role must exist, be below the bot's own role, be unmanaged, and the bot
 * must hold Manage Roles. Verification failures never roll back the link, and
 * a role refusal never fails the verification run — the outcome is logged and
 * surfaced in the summary.
 */

import type { Client } from 'discord.js';

import type { Logger } from '../lib/logger.js';
import { applyRoleChange, type RoleOutcome } from './preflight.js';

export interface RuleRoleService {
  /**
   * Make `roleId` match `shouldHave` for `userId` in `guildId`.
   * Returns an outcome; never throws.
   */
  sync(target: { guildId: string | null; userId: string }, roleId: string, shouldHave: boolean): Promise<RoleOutcome>;
}

export function createRuleRoleService(deps: {
  logger: Logger;
  /** Late-bound, same contract as the linked-role service. */
  getClient: () => Client | null;
}): RuleRoleService {
  const log = deps.logger.child({ component: 'rule-role' });

  return {
    sync(target, roleId, shouldHave) {
      return applyRoleChange(
        { guildId: target.guildId, userId: target.userId },
        roleId,
        shouldHave ? 'grant' : 'revoke',
        { logger: log, getClient: deps.getClient },
      );
    },
  };
}
