/**
 * Verification engine — the M3 core.
 *
 * For one linked user in one guild: evaluate every enabled rule against the
 * user's own GitHub token, persist the membership result, and reconcile
 * Discord roles so they match current access.
 *
 * Reconciliation is diff-based and conservative (docs/security-model.md
 * threat #8): a role is only *revoked* when MergeID previously granted it for
 * that rule (recorded in `role_grants`), and an ERROR (GitHub outage, rate
 * limit, missing scopes) never changes roles — last-known state stands until
 * the next successful run.
 *
 * Runs on demand: after a successful link (OAuth callback), from `/verify`,
 * and later from the M5 periodic worker.
 */

import { Octokit } from '@octokit/rest';

import { decryptToken } from '../crypto/index.js';
import {
  checkOrgMembership,
  checkRepoPushAccess,
  checkTeamMembership,
} from '../github/membership.js';
import { MembershipStatus, RuleKind } from '../generated/prisma/enums.js';
import type { PrismaClient } from '../lib/prisma.js';
import type { Logger } from '../lib/logger.js';
import type { Config } from '../config/index.js';
import type { RulesService } from '../services/index.js';
import type { RuleRoleService } from '../discord/rule-roles.js';

export interface VerifySummary {
  guildId: string | null;
  /** Short-circuit reason when verification did not run. */
  notVerified?: 'not_linked' | 'no_rules' | 'token_unavailable' | 'guild_missing';
  checked: number;
  passed: number;
  failed: number;
  errored: number;
  /** Role ids granted in this run. */
  granted: string[];
  /** Role ids revoked in this run. */
  revoked: string[];
  /** Role ids already in the desired state (no Discord call needed). */
  kept: string[];
  /** roleId → why the change failed (for logs; never rendered verbatim). */
  failures: Array<{ roleId: string; kind: string; detail?: string }>;
}

interface RuleWithStatus {
  ruleId: string;
  roleId: string;
  status: MembershipStatus;
  detail?: string;
}

export function createVerificationEngine(deps: {
  prisma: PrismaClient;
  config: Config;
  logger: Logger;
  rules: RulesService;
  roles: RuleRoleService;
}) {
  const { prisma, config, logger } = deps;
  const log = logger.child({ component: 'verification' });

  const emptySummary = (guildId: string | null): VerifySummary => ({
    guildId,
    checked: 0,
    passed: 0,
    failed: 0,
    errored: 0,
    granted: [],
    revoked: [],
    kept: [],
    failures: [],
  });

  function hasRequiredScopes(tokenScopes: string[], requiredScopes: string[]): boolean {
    const have = new Set(tokenScopes);
    return requiredScopes.every((scope) => have.has(scope));
  }

  async function evaluateRule(input: {
    ruleId: string;
    kind: RuleKind;
    org: string;
    repo: string | null;
    teamSlug: string | null;
    requiredScopes: string;
    octokit: Octokit;
    username: string;
    tokenScopes: string[];
  }): Promise<RuleWithStatus> {
    const required = input.requiredScopes
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!hasRequiredScopes(input.tokenScopes, required)) {
      return {
        ruleId: input.ruleId,
        roleId: '',
        status: MembershipStatus.ERROR,
        detail: `token missing required scopes: ${required.join(', ')}`,
      };
    }

    try {
      switch (input.kind) {
        case RuleKind.ORG: {
          const result = await checkOrgMembership(input.octokit, input.org);
          return {
            ruleId: input.ruleId,
            roleId: '',
            status: result.member ? MembershipStatus.PASS : MembershipStatus.FAIL,
            detail: result.detail,
          };
        }
        case RuleKind.REPO: {
          if (!input.repo) {
            return { ruleId: input.ruleId, roleId: '', status: MembershipStatus.ERROR, detail: 'repo missing on REPO rule' };
          }
          const result = await checkRepoPushAccess(input.octokit, input.org, input.repo);
          return {
            ruleId: input.ruleId,
            roleId: '',
            status: result.member ? MembershipStatus.PASS : MembershipStatus.FAIL,
            detail: result.detail,
          };
        }
        case RuleKind.TEAM: {
          if (!input.teamSlug) {
            return { ruleId: input.ruleId, roleId: '', status: MembershipStatus.ERROR, detail: 'team slug missing on TEAM rule' };
          }
          const result = await checkTeamMembership(input.octokit, input.org, input.teamSlug, input.username);
          return {
            ruleId: input.ruleId,
            roleId: '',
            status: result.member ? MembershipStatus.PASS : MembershipStatus.FAIL,
            detail: result.detail,
          };
        }
        default:
          return { ruleId: input.ruleId, roleId: '', status: MembershipStatus.ERROR, detail: 'unknown rule kind' };
      }
    } catch (err) {
      log.warn(
        { err, ruleId: input.ruleId, kind: input.kind, org: input.org },
        'github membership check errored',
      );
      return { ruleId: input.ruleId, roleId: '', status: MembershipStatus.ERROR, detail: 'github check errored' };
    }
  }

  async function verifyUser(input: { discordUserId: string; guildId: string }): Promise<VerifySummary> {
    const summary = emptySummary(input.guildId);

    const link = await prisma.githubLink.findUnique({
      where: { discordUserId: input.discordUserId },
    });
    if (!link) return { ...summary, notVerified: 'not_linked' };

    const rules = (await deps.rules.listRules(input.guildId)).filter((rule) => rule.enabled);
    if (rules.length === 0) return { ...summary, notVerified: 'no_rules' };

    let accessToken: string;
    try {
      accessToken = decryptToken(link.tokenEncrypted, { keyHex: config.TOKEN_ENCRYPTION_KEY });
    } catch (err) {
      log.error({ err, userId: input.discordUserId }, 'failed to decrypt token for verification');
      return { ...summary, notVerified: 'token_unavailable' };
    }

    const octokit = new Octokit({ auth: accessToken });
    let username: string;
    try {
      const { data } = await octokit.users.getAuthenticated();
      username = data.login;
    } catch (err) {
      // Token revoked or expired on GitHub's side.
      log.warn({ err, userId: input.discordUserId }, 'github token rejected during verification');
      return { ...summary, notVerified: 'token_unavailable' };
    }

    const tokenScopes = link.tokenScopes.split(',').filter(Boolean);

    const evaluated: Array<RuleWithStatus & { roleId: string }> = [];
    for (const rule of rules) {
      const result = await evaluateRule({
        ruleId: rule.id,
        kind: rule.kind,
        org: rule.org,
        repo: rule.repo,
        teamSlug: rule.teamSlug,
        requiredScopes: rule.requiredScopes,
        octokit,
        username,
        tokenScopes,
      });
      evaluated.push({ ...result, roleId: rule.roleId });
      summary.checked += 1;
      if (result.status === MembershipStatus.PASS) summary.passed += 1;
      else if (result.status === MembershipStatus.FAIL) summary.failed += 1;
      else summary.errored += 1;

      await prisma.membershipResult.upsert({
        where: { linkId_ruleId: { linkId: link.id, ruleId: rule.id } },
        create: {
          linkId: link.id,
          ruleId: rule.id,
          status: result.status,
          detail: result.detail ?? null,
          checkedAt: new Date(),
        },
        update: { status: result.status, detail: result.detail ?? null, checkedAt: new Date() },
      });
    }

    // Diff-based role reconciliation. Only roles MergeID granted before are
    // ever revoked; ERRORs keep last-known state untouched.
    const existingGrants = await prisma.roleGrant.findMany({
      where: { guildId: input.guildId, discordUserId: input.discordUserId },
    });
    const grantByRule = new Map(existingGrants.map((grant) => [grant.ruleId, grant.roleId]));

    for (const item of evaluated) {
      if (item.status === MembershipStatus.ERROR) continue;

      const shouldHave = item.status === MembershipStatus.PASS;
      const ruleOwnsRole = grantByRule.get(item.ruleId) === item.roleId;

      if (shouldHave) {
        const outcome = await deps.roles.sync(
          { guildId: input.guildId, userId: input.discordUserId },
          item.roleId,
          true,
        );
        if (outcome.kind === 'granted') {
          summary.granted.push(item.roleId);
          await prisma.roleGrant.upsert({
            where: {
              guildId_discordUserId_roleId: {
                guildId: input.guildId,
                discordUserId: input.discordUserId,
                roleId: item.roleId,
              },
            },
            create: {
              guildId: input.guildId,
              discordUserId: input.discordUserId,
              roleId: item.roleId,
              ruleId: item.ruleId,
              grantedAt: new Date(),
            },
            update: { ruleId: item.ruleId },
          });
        } else if (outcome.kind === 'unchanged') {
          summary.kept.push(item.roleId);
          await prisma.roleGrant.upsert({
            where: {
              guildId_discordUserId_roleId: {
                guildId: input.guildId,
                discordUserId: input.discordUserId,
                roleId: item.roleId,
              },
            },
            create: {
              guildId: input.guildId,
              discordUserId: input.discordUserId,
              roleId: item.roleId,
              ruleId: item.ruleId,
              grantedAt: new Date(),
            },
            update: { ruleId: item.ruleId },
          });
        } else {
          summary.failures.push({
            roleId: item.roleId,
            kind: outcome.kind,
            detail: outcome.detail,
          });
        }
      } else if (ruleOwnsRole) {
        const outcome = await deps.roles.sync(
          { guildId: input.guildId, userId: input.discordUserId },
          item.roleId,
          false,
        );
        if (outcome.kind === 'removed') {
          summary.revoked.push(item.roleId);
          await prisma.roleGrant.deleteMany({ where: { guildId: input.guildId, discordUserId: input.discordUserId, roleId: item.roleId, ruleId: item.ruleId } });
        } else if (outcome.kind === 'unchanged') {
          summary.kept.push(item.roleId);
          await prisma.roleGrant.deleteMany({ where: { guildId: input.guildId, discordUserId: input.discordUserId, roleId: item.roleId, ruleId: item.ruleId } });
        } else {
          summary.failures.push({ roleId: item.roleId, kind: outcome.kind, detail: outcome.detail });
        }
      }
    }

    await prisma.githubLink.update({
      where: { id: link.id },
      data: { lastVerifiedAt: new Date() },
    });

    await prisma.auditEvent.create({
      data: {
        guildId: input.guildId,
        actorDiscordId: input.discordUserId,
        action: 'verification.completed',
        subject: link.githubUserId,
        meta: {
          checked: summary.checked,
          passed: summary.passed,
          failed: summary.failed,
          errored: summary.errored,
          granted: summary.granted,
          revoked: summary.revoked,
        },
        at: new Date(),
      },
    });

    log.info(
      {
        guildId: input.guildId,
        userId: input.discordUserId,
        checked: summary.checked,
        passed: summary.passed,
        failed: summary.failed,
        errored: summary.errored,
      },
      'verification completed',
    );

    return summary;
  }

  return { verifyUser };
}

export type VerificationEngine = ReturnType<typeof createVerificationEngine>;
