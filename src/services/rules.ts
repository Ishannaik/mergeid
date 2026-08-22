/**
 * Verification-rule and guild-settings domain service.
 *
 * Rules are the admin-facing configuration the verification engine runs:
 * "members of org `acme` get `@Contributor`", "collaborators with push on
 * `acme/api` get `@Maintainer`", "members of team `core` get `@Core Team`".
 *
 * Safety model (docs/security-model.md §3):
 * - A rule can only reference a role on the guild's assignable-roles
 *   allowlist (`settings.assignableRoles`), so admins explicitly opt roles in
 *   before rules can hand them out.
 * - Rule count per guild is capped to keep a malicious admin from spamming
 *   role flapping and GitHub API load (threat #7/#8).
 * - Every change is written to the audit log.
 */

import { RuleKind } from '../generated/prisma/enums.js';
import { Prisma } from '../generated/prisma/client.js';
import { AppError } from '../lib/errors.js';
import type { PrismaClient } from '../lib/prisma.js';
import type { Logger } from '../lib/logger.js';

/** Hard cap on enabled rules per guild — guards GitHub rate budget and role flapping. */
export const MAX_RULES_PER_GUILD = 25;
/** Default re-check interval when an admin does not specify one (minutes). */
export const DEFAULT_RECHECK_MINUTES = 1440;
export const MIN_RECHECK_MINUTES = 30;

export interface GuildSettings {
  /** Roles admins have explicitly allowed rules to grant. */
  assignableRoles: string[];
  /** Roles the engine must never touch (admins/managed by other bots). */
  protectedRoleIds: string[];
  /** Optional channel MergeID posts sync failures and audit notices to. */
  logChannelId?: string;
}

const DEFAULT_SETTINGS: GuildSettings = { assignableRoles: [], protectedRoleIds: [] };

export type RuleKindInput = 'ORG' | 'REPO' | 'TEAM';

export interface AddRuleInput {
  guildId: string;
  kind: RuleKindInput;
  org: string;
  /** Required when kind === REPO. */
  repo?: string;
  /** Required when kind === TEAM. */
  teamSlug?: string;
  roleId: string;
  recheckMinutes?: number;
  /** Discord user id of the admin creating the rule (for audit). */
  createdBy: string;
}

export interface RuleView {
  id: string;
  guildId: string;
  kind: RuleKind;
  org: string;
  repo: string | null;
  teamSlug: string | null;
  roleId: string;
  recheckMinutes: number;
  requiredScopes: string;
  enabled: boolean;
  createdAt: Date;
}

export function createRulesService(deps: { prisma: PrismaClient; logger: Logger }) {
  const { prisma, logger } = deps;

  /**
   * Optional listener fired after a rule is created, removed, or reconfigured.
   * The worker registers one to keep BullMQ schedules aligned with the rules
   * table without polling. Absent in tests and single-role deployments.
   */
  let scheduleListener:
    | ((rule: { id: string; guildId: string; recheckMinutes: number; enabled: boolean }) => void)
    | null = null;

  /** Registers the schedule-change listener; returns the service for chaining. */
  function onScheduleChanged(
    listener: (rule: {
      id: string;
      guildId: string;
      recheckMinutes: number;
      enabled: boolean;
    }) => void,
  ): void {
    scheduleListener = listener;
  }

  function notifyScheduleChanged(rule: {
    id: string;
    guildId: string;
    recheckMinutes: number;
    enabled: boolean;
  }): void {
    try {
      scheduleListener?.(rule);
    } catch (err) {
      // A broken listener must never fail the admin operation itself.
      logger.warn({ err, ruleId: rule.id }, 'schedule listener threw');
    }
  }

  async function getSettings(guildId: string): Promise<GuildSettings> {
    const guild = await prisma.guild.findUnique({ where: { guildId } });
    if (!guild) return { ...DEFAULT_SETTINGS };
    const raw = (guild.settings ?? {}) as Partial<GuildSettings>;
    return {
      assignableRoles: Array.isArray(raw.assignableRoles) ? raw.assignableRoles : [],
      protectedRoleIds: Array.isArray(raw.protectedRoleIds) ? raw.protectedRoleIds : [],
      ...(typeof raw.logChannelId === 'string' && raw.logChannelId.length > 0
        ? { logChannelId: raw.logChannelId }
        : {}),
    };
  }

  async function updateSettings(
    guildId: string,
    patch: (current: GuildSettings) => GuildSettings,
  ): Promise<GuildSettings> {
    const current = await getSettings(guildId);
    const next = patch(current);
    await prisma.guild.upsert({
      where: { guildId },
      create: {
        guildId,
        enabled: true,
        settings: next as unknown as Prisma.InputJsonValue,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      update: { settings: next as unknown as Prisma.InputJsonValue, updatedAt: new Date() },
    });
    return next;
  }

  async function writeAudit(input: {
    guildId: string;
    actorDiscordId: string;
    action: string;
    subject?: string;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    await prisma.auditEvent.create({
      data: {
        guildId: input.guildId,
        actorDiscordId: input.actorDiscordId,
        action: input.action,
        subject: input.subject ?? null,
        meta: input.meta as unknown as Prisma.InputJsonValue,
        at: new Date(),
      },
    });
  }

  function normalizeOrg(org: string): string {
    const trimmed = org
      .trim()
      .replace(/^https?:\/\/github\.com\//, '')
      .replace(/\/+$/, '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(trimmed)) {
      throw new AppError(
        `"${org}" is not a valid GitHub org name. Paste the org name (or its github.com URL), e.g. "acme" or "https://github.com/acme".`,
        { code: 'invalid_org', statusCode: 400, expose: true },
      );
    }
    return trimmed;
  }

  function normalizeRepo(repo: string): string {
    const trimmed = repo.trim().replace(/\/+$/, '');
    if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
      throw new AppError(
        `"${repo}" is not a valid GitHub repository name (no slashes — pass just the repo name, e.g. "api").`,
        { code: 'invalid_repo', statusCode: 400, expose: true },
      );
    }
    return trimmed;
  }

  function normalizeTeamSlug(slug: string): string {
    const trimmed = slug.trim().replace(/\/+$/, '');
    if (!/^[a-zA-Z0-9-]+$/.test(trimmed)) {
      throw new AppError(
        `"${slug}" is not a valid GitHub team slug (use the team's URL slug, e.g. "core-team").`,
        { code: 'invalid_team_slug', statusCode: 400, expose: true },
      );
    }
    return trimmed;
  }

  return {
    getSettings,
    onScheduleChanged,

    async listRules(guildId: string): Promise<RuleView[]> {
      const rules = await prisma.verificationRule.findMany({
        where: { guildId },
        orderBy: { createdAt: 'asc' },
      });
      return rules.map((rule) => ({
        id: rule.id,
        guildId: rule.guildId,
        kind: rule.kind,
        org: rule.org,
        repo: rule.repo,
        teamSlug: rule.teamSlug,
        roleId: rule.roleId,
        recheckMinutes: rule.recheckMinutes,
        requiredScopes: rule.requiredScopes,
        enabled: rule.enabled,
        createdAt: rule.createdAt,
      }));
    },

    async addRule(input: AddRuleInput): Promise<RuleView> {
      const kind = input.kind;
      const org = normalizeOrg(input.org);

      // Presence checks come first so a missing repo/team surfaces the
      // actionable error instead of falling through to name validation.
      if (kind === 'REPO' && !input.repo) {
        throw new AppError('A REPO rule needs a repo name.', {
          code: 'repo_required',
          statusCode: 400,
          expose: true,
        });
      }
      if (kind === 'TEAM' && !input.teamSlug) {
        throw new AppError('A TEAM rule needs a team slug.', {
          code: 'team_required',
          statusCode: 400,
          expose: true,
        });
      }

      const repo = kind === 'REPO' ? normalizeRepo(input.repo ?? '') : null;
      const teamSlug = kind === 'TEAM' ? normalizeTeamSlug(input.teamSlug ?? '') : null;

      if (kind === 'ORG' && (input.repo || input.teamSlug)) {
        throw new AppError('ORG rules only take an org name.', {
          code: 'org_extra_fields',
          statusCode: 400,
          expose: true,
        });
      }

      const recheckMinutes =
        input.recheckMinutes !== undefined && input.recheckMinutes !== null
          ? input.recheckMinutes
          : DEFAULT_RECHECK_MINUTES;
      if (!Number.isInteger(recheckMinutes) || recheckMinutes < MIN_RECHECK_MINUTES) {
        throw new AppError(`Re-check interval must be at least ${MIN_RECHECK_MINUTES} minutes.`, {
          code: 'bad_recheck_interval',
          statusCode: 400,
          expose: true,
        });
      }

      // Allowlist gate: a rule may only reference a role the admin opted in.
      const settings = await getSettings(input.guildId);
      if (!settings.assignableRoles.includes(input.roleId)) {
        throw new AppError(
          'That role is not on the assignable-roles allowlist. Add it first with `/mergeid roles add`.',
          { code: 'role_not_allowlisted', statusCode: 400, expose: true },
        );
      }
      if (settings.protectedRoleIds.includes(input.roleId)) {
        throw new AppError('That role is protected and cannot be granted by rules.', {
          code: 'role_protected',
          statusCode: 400,
          expose: true,
        });
      }

      const ruleCount = await prisma.verificationRule.count({
        where: { guildId: input.guildId, enabled: true },
      });
      if (ruleCount >= MAX_RULES_PER_GUILD) {
        throw new AppError(
          `This server already has ${MAX_RULES_PER_GUILD} rules — the per-server cap. Remove one before adding another.`,
          { code: 'rule_cap_reached', statusCode: 400, expose: true },
        );
      }

      const rule = await prisma.verificationRule.create({
        data: {
          guildId: input.guildId,
          kind,
          org,
          repo,
          teamSlug,
          roleId: input.roleId,
          recheckMinutes,
          requiredScopes: 'read:user,read:org',
          enabled: true,
          createdBy: input.createdBy,
          createdAt: new Date(),
        },
      });

      await writeAudit({
        guildId: input.guildId,
        actorDiscordId: input.createdBy,
        action: 'rule.created',
        subject: rule.id,
        meta: { kind, org, repo, teamSlug, roleId: input.roleId, recheckMinutes },
      });

      logger.info(
        { guildId: input.guildId, ruleId: rule.id, kind, org },
        'verification rule created',
      );
      notifyScheduleChanged({
        id: rule.id,
        guildId: rule.guildId,
        recheckMinutes: rule.recheckMinutes,
        enabled: rule.enabled,
      });
      return {
        id: rule.id,
        guildId: rule.guildId,
        kind: rule.kind,
        org: rule.org,
        repo: rule.repo,
        teamSlug: rule.teamSlug,
        roleId: rule.roleId,
        recheckMinutes: rule.recheckMinutes,
        requiredScopes: rule.requiredScopes,
        enabled: rule.enabled,
        createdAt: rule.createdAt,
      };
    },

    async removeRule(input: {
      guildId: string;
      ruleId: string;
      actorDiscordId: string;
    }): Promise<{ removed: boolean }> {
      const existing = await prisma.verificationRule.findFirst({
        where: { id: input.ruleId, guildId: input.guildId },
      });
      if (!existing) return { removed: false };

      await prisma.$transaction(async (tx) => {
        await tx.roleGrant.deleteMany({ where: { ruleId: input.ruleId } });
        await tx.membershipResult.deleteMany({ where: { ruleId: input.ruleId } });
        await tx.verificationRule.delete({ where: { id: input.ruleId } });
      });

      await writeAudit({
        guildId: input.guildId,
        actorDiscordId: input.actorDiscordId,
        action: 'rule.removed',
        subject: input.ruleId,
        meta: { kind: existing.kind, org: existing.org, repo: existing.repo },
      });

      logger.info({ guildId: input.guildId, ruleId: input.ruleId }, 'verification rule removed');
      notifyScheduleChanged({
        id: existing.id,
        guildId: input.guildId,
        recheckMinutes: existing.recheckMinutes,
        enabled: false,
      });
      return { removed: true };
    },

    async addAssignableRole(input: {
      guildId: string;
      roleId: string;
      actorDiscordId: string;
    }): Promise<GuildSettings> {
      const next = await updateSettings(input.guildId, (current) => {
        if (current.assignableRoles.includes(input.roleId)) return current;
        return { ...current, assignableRoles: [...current.assignableRoles, input.roleId] };
      });
      await writeAudit({
        guildId: input.guildId,
        actorDiscordId: input.actorDiscordId,
        action: 'settings.assignable_role.added',
        subject: input.roleId,
      });
      return next;
    },

    async removeAssignableRole(input: {
      guildId: string;
      roleId: string;
      actorDiscordId: string;
    }): Promise<GuildSettings> {
      const next = await updateSettings(input.guildId, (current) => ({
        ...current,
        assignableRoles: current.assignableRoles.filter((id) => id !== input.roleId),
      }));
      await writeAudit({
        guildId: input.guildId,
        actorDiscordId: input.actorDiscordId,
        action: 'settings.assignable_role.removed',
        subject: input.roleId,
      });
      return next;
    },

    async addProtectedRole(input: {
      guildId: string;
      roleId: string;
      actorDiscordId: string;
    }): Promise<GuildSettings> {
      const next = await updateSettings(input.guildId, (current) => {
        if (current.protectedRoleIds.includes(input.roleId)) return current;
        return { ...current, protectedRoleIds: [...current.protectedRoleIds, input.roleId] };
      });
      // Guard in the other direction too: a role that becomes protected must
      // not stay allowlisted, or a later rule could still hand it out.
      const cleaned = next.assignableRoles.includes(input.roleId)
        ? { ...next, assignableRoles: next.assignableRoles.filter((id) => id !== input.roleId) }
        : next;
      if (cleaned !== next) {
        await updateSettings(input.guildId, () => cleaned);
      }
      await writeAudit({
        guildId: input.guildId,
        actorDiscordId: input.actorDiscordId,
        action: 'settings.protected_role.added',
        subject: input.roleId,
      });
      return cleaned;
    },

    async removeProtectedRole(input: {
      guildId: string;
      roleId: string;
      actorDiscordId: string;
    }): Promise<GuildSettings> {
      const next = await updateSettings(input.guildId, (current) => ({
        ...current,
        protectedRoleIds: current.protectedRoleIds.filter((id) => id !== input.roleId),
      }));
      await writeAudit({
        guildId: input.guildId,
        actorDiscordId: input.actorDiscordId,
        action: 'settings.protected_role.removed',
        subject: input.roleId,
      });
      return next;
    },

    async setLogChannel(input: {
      guildId: string;
      channelId: string | null;
      actorDiscordId: string;
    }): Promise<GuildSettings> {
      const channelId = input.channelId?.trim() || null;
      const next = await updateSettings(input.guildId, (current) => {
        const rest = { ...current };
        delete (rest as Partial<GuildSettings>).logChannelId;
        return channelId ? { ...rest, logChannelId: channelId } : rest;
      });
      await writeAudit({
        guildId: input.guildId,
        actorDiscordId: input.actorDiscordId,
        action: channelId ? 'settings.log_channel.set' : 'settings.log_channel.cleared',
        subject: channelId ?? undefined,
      });
      return next;
    },

    /**
     * Recent audit events for one guild, newest first. Read-only — no audit
     * row for the read itself, matching docs/security-model.md §4.
     */
    async listAuditEvents(input: { guildId: string; limit?: number }): Promise<
      Array<{
        id: string;
        actorDiscordId: string | null;
        action: string;
        subject: string | null;
        meta: unknown;
        at: Date;
      }>
    > {
      const limit = Math.min(Math.max(input.limit ?? 10, 1), 25);
      const rows = await prisma.auditEvent.findMany({
        where: { guildId: input.guildId },
        orderBy: { at: 'desc' },
        take: limit,
      });
      return rows.map((row) => ({
        id: row.id,
        actorDiscordId: row.actorDiscordId,
        action: row.action,
        subject: row.subject,
        meta: row.meta,
        at: row.at,
      }));
    },

    /**
     * Recent sync runs for one guild's rules with per-rule rollups and 24h
     * totals. Backs `/mergeid sync status` (M5 #6).
     */
    async syncStatus(input: { guildId: string }): Promise<{
      rules: Array<{
        ruleId: string;
        lastRunAt: Date | null;
        lastStatus: string | null;
        checked: number;
        errored: number;
        granted: number;
        revoked: number;
        runs24h: number;
      }>;
      totals: { runs24h: number; ok24h: number; partial24h: number; failed24h: number };
    }> {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const rules = await prisma.verificationRule.findMany({
        where: { guildId: input.guildId },
        select: { id: true },
      });
      if (rules.length === 0) {
        return { rules: [], totals: { runs24h: 0, ok24h: 0, partial24h: 0, failed24h: 0 } };
      }

      const recent = await prisma.syncRun.findMany({
        where: { ruleId: { in: rules.map((r) => r.id) }, startedAt: { gte: since } },
        orderBy: { startedAt: 'desc' },
      });

      interface SyncStats {
        checked?: number;
        errored?: number;
        granted?: number;
        revoked?: number;
      }
      const byRule = new Map<
        string,
        {
          lastRunAt: Date | null;
          lastStatus: string | null;
          checked: number;
          errored: number;
          granted: number;
          revoked: number;
          runs24h: number;
        }
      >();
      const totals = { runs24h: recent.length, ok24h: 0, partial24h: 0, failed24h: 0 };

      for (const run of recent) {
        if (run.status === 'OK') totals.ok24h += 1;
        else if (run.status === 'PARTIAL') totals.partial24h += 1;
        else totals.failed24h += 1;

        const entry = byRule.get(run.ruleId) ?? {
          lastRunAt: null as Date | null,
          lastStatus: null as string | null,
          checked: 0,
          errored: 0,
          granted: 0,
          revoked: 0,
          runs24h: 0,
        };
        // findMany is newest-first, so the first sighting is the latest run.
        if (entry.lastRunAt === null) {
          entry.lastRunAt = run.startedAt;
          entry.lastStatus = run.status;
        }
        const stats = (run.stats ?? {}) as SyncStats;
        entry.checked += stats.checked ?? 0;
        entry.errored += stats.errored ?? 0;
        entry.granted += stats.granted ?? 0;
        entry.revoked += stats.revoked ?? 0;
        entry.runs24h += 1;
        byRule.set(run.ruleId, entry);
      }

      return {
        rules: rules.map((rule) => ({
          ruleId: rule.id,
          ...(byRule.get(rule.id) ?? {
            lastRunAt: null,
            lastStatus: null,
            checked: 0,
            errored: 0,
            granted: 0,
            revoked: 0,
            runs24h: 0,
          }),
        })),
        totals,
      };
    },
  };
}

export type RulesService = ReturnType<typeof createRulesService>;
