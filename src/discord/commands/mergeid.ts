import {
  SlashCommandBuilder,
  SlashCommandSubcommandGroupBuilder,
  SlashCommandSubcommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

import { AppError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { RulesService } from '../../services/index.js';

const RULE_KIND_CHOICES = [
  { name: 'Organization membership (member of an org)', value: 'ORG' },
  { name: 'Repository collaborator (push access)', value: 'REPO' },
  { name: 'Team membership (member of a team)', value: 'TEAM' },
];

function rolesGroup(): SlashCommandSubcommandGroupBuilder {
  return new SlashCommandSubcommandGroupBuilder()
    .setName('roles')
    .setDescription('Manage the assignable-roles allowlist')
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName('add')
        .setDescription('Allow a role to be granted by verification rules')
        .addRoleOption((o) =>
          o.setName('role').setDescription('The role to allow').setRequired(true),
        ),
    )
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName('remove')
        .setDescription('Stop allowing a role to be granted by rules')
        .addRoleOption((o) =>
          o.setName('role').setDescription('The role to disallow').setRequired(true),
        ),
    )
    .addSubcommand(
      new SlashCommandSubcommandBuilder().setName('list').setDescription('List allowlisted roles'),
    );
}

function rulesGroup(): SlashCommandSubcommandGroupBuilder {
  return new SlashCommandSubcommandGroupBuilder()
    .setName('rules')
    .setDescription('Manage verification rules')
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName('add')
        .setDescription('Add a verification rule (org/repo/team membership → role)')
        .addStringOption((o) =>
          o
            .setName('kind')
            .setDescription('What to verify against')
            .setRequired(true)
            .addChoices(...RULE_KIND_CHOICES),
        )
        .addStringOption((o) =>
          o.setName('org').setDescription('GitHub org name or URL, e.g. "acme"').setRequired(true),
        )
        .addRoleOption((o) =>
          o.setName('role').setDescription('Role to grant when the check passes').setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName('repo')
            .setDescription('Repo name (REPO rules only), e.g. "api"')
            .setRequired(false),
        )
        .addStringOption((o) =>
          o
            .setName('team')
            .setDescription('Team slug (TEAM rules only), e.g. "core-team"')
            .setRequired(false),
        )
        .addIntegerOption((o) =>
          o
            .setName('recheck')
            .setDescription('Minutes between automatic re-checks (default 1440 = daily)')
            .setRequired(false),
        ),
    )
    .addSubcommand(
      new SlashCommandSubcommandBuilder().setName('list').setDescription('List verification rules'),
    )
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName('remove')
        .setDescription('Remove a verification rule')
        .addStringOption((o) =>
          o.setName('rule').setDescription('Rule id (see /mergeid rules list)').setRequired(true),
        ),
    );
}

function settingsGroup(): SlashCommandSubcommandGroupBuilder {
  return new SlashCommandSubcommandGroupBuilder()
    .setName('settings')
    .setDescription('View and change guild settings')
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName('show')
        .setDescription('Show current MergeID settings'),
    )
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName('protect-role')
        .setDescription('Never let verification rules grant a role')
        .addRoleOption((o) =>
          o.setName('role').setDescription('The role to protect').setRequired(true),
        ),
    )
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName('unprotect-role')
        .setDescription('Allow a protected role to be allowlisted again')
        .addRoleOption((o) =>
          o.setName('role').setDescription('The role to unprotect').setRequired(true),
        ),
    )
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName('log-channel')
        .setDescription('Channel where MergeID posts sync failures (leave empty to clear)')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('The log channel; omit to clear')
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText),
        ),
    );
}

export const mergeidCommandData = new SlashCommandBuilder()
  .setName('mergeid')
  .setDescription('MergeID admin configuration')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommandGroup(rolesGroup())
  .addSubcommandGroup(rulesGroup())
  .addSubcommandGroup(settingsGroup())
  .addSubcommand(
    new SlashCommandSubcommandBuilder()
      .setName('sync-status')
      .setDescription('Periodic sync health: last runs per rule and 24h totals'),
  )
  .addSubcommand(
    new SlashCommandSubcommandBuilder()
      .setName('audit')
      .setDescription('Show recent admin and verification activity')
      .addIntegerOption((o) =>
        o
          .setName('count')
          .setDescription('How many events to show (default 10, max 25)')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(25),
      ),
  );

function requireGuild(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) {
    throw new AppError('Run this command inside a server, not a DM.', {
      code: 'guild_required',
      statusCode: 400,
      expose: true,
    });
  }
  return interaction.guildId;
}

function mention(roleId: string): string {
  return `<@&${roleId}>`;
}

export async function executeMergeid(
  interaction: ChatInputCommandInteraction,
  deps: { logger: Logger; rules: RulesService },
): Promise<void> {
  const { rules } = deps;

  try {
    const guildId = requireGuild(interaction);
    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();
    const actor = interaction.user.id;

    if (group === 'roles') {
      const role = interaction.options.getRole('role');

      if (sub === 'add') {
        if (!role)
          throw new AppError('Pick a role with /mergeid roles add.', {
            code: 'role_required',
            statusCode: 400,
            expose: true,
          });
        await rules.addAssignableRole({ guildId, roleId: role.id, actorDiscordId: actor });
        await interaction.editReply(
          `Allowed ${mention(role.id)} to be granted by verification rules. Rules referencing it can now be added with \`/mergeid rules add\`.`,
        );
        return;
      }

      if (sub === 'remove') {
        if (!role)
          throw new AppError('Pick a role with /mergeid roles remove.', {
            code: 'role_required',
            statusCode: 400,
            expose: true,
          });
        await rules.removeAssignableRole({ guildId, roleId: role.id, actorDiscordId: actor });
        await interaction.editReply(
          `Removed ${mention(role.id)} from the allowlist. Existing rules still reference it until removed.`,
        );
        return;
      }

      if (sub === 'list') {
        const settings = await rules.getSettings(guildId);
        const ids = settings.assignableRoles;
        await interaction.editReply(
          ids.length === 0
            ? 'No roles are allowlisted yet. Add one with `/mergeid roles add`.'
            : `**Allowlisted roles:** ${ids.map(mention).join(', ')}`,
        );
        return;
      }
    }

    if (group === 'rules') {
      if (sub === 'add') {
        const kind = interaction.options.getString('kind', true) as 'ORG' | 'REPO' | 'TEAM';
        const org = interaction.options.getString('org', true);
        const repo = interaction.options.getString('repo') ?? undefined;
        const teamSlug = interaction.options.getString('team') ?? undefined;
        const role = interaction.options.getRole('role');
        const recheck = interaction.options.getInteger('recheck') ?? undefined;

        if (!role)
          throw new AppError('Pick a role with /mergeid rules add.', {
            code: 'role_required',
            statusCode: 400,
            expose: true,
          });

        const rule = await rules.addRule({
          guildId,
          kind,
          org,
          repo,
          teamSlug,
          roleId: role.id,
          recheckMinutes: recheck,
          createdBy: actor,
        });

        const target =
          kind === 'ORG'
            ? `org **${rule.org}**`
            : kind === 'REPO'
              ? `repo **${rule.org}/${rule.repo}**`
              : `team **${rule.org}/${rule.teamSlug}**`;

        await interaction.editReply(
          [
            `✅ Rule added (\`${rule.id.slice(0, 8)}…\`)`,
            `When a linked member is in ${target}, they get ${mention(rule.roleId)}.`,
            `Re-check every ${rule.recheckMinutes} min. Members run \`/verify\` (or re-link) to apply it now.`,
          ].join('\n'),
        );
        return;
      }

      if (sub === 'list') {
        const all = await rules.listRules(guildId);
        if (all.length === 0) {
          await interaction.editReply(
            'No verification rules in this server. Add one with `/mergeid rules add`.',
          );
          return;
        }
        const lines = all.map((rule) => {
          const target =
            rule.kind === 'ORG'
              ? `org \`${rule.org}\``
              : rule.kind === 'REPO'
                ? `repo \`${rule.org}/${rule.repo}\``
                : `team \`${rule.org}/${rule.teamSlug}\``;
          const state = rule.enabled ? '' : ' (disabled)';
          return `\`${rule.id.slice(0, 8)}…\` · ${target} → ${mention(rule.roleId)} · every ${rule.recheckMinutes} min${state}`;
        });
        await interaction.editReply(
          [`**Verification rules (${all.length}):**`, ...lines].join('\n'),
        );
        return;
      }

      if (sub === 'remove') {
        const ruleId = interaction.options.getString('rule', true);
        const result = await rules.removeRule({ guildId, ruleId, actorDiscordId: actor });
        await interaction.editReply(
          result.removed
            ? `Removed rule \`${ruleId.slice(0, 8)}…\` and any roles it had granted.`
            : 'No rule with that id in this server. Run `/mergeid rules list` for ids.',
        );
        return;
      }
    }

    if (group === 'settings') {
      if (sub === 'show') {
        const settings = await rules.getSettings(guildId);
        const lines = [
          `**Allowlisted roles:** ${
            settings.assignableRoles.length
              ? settings.assignableRoles.map(mention).join(', ')
              : 'none'
          }`,
          `**Protected roles:** ${
            settings.protectedRoleIds.length
              ? settings.protectedRoleIds.map(mention).join(', ')
              : 'none'
          }`,
          `**Log channel:** ${settings.logChannelId ? `<#${settings.logChannelId}>` : 'not set'}`,
        ];
        await interaction.editReply(lines.join('\n'));
        return;
      }

      if (sub === 'protect-role' || sub === 'unprotect-role') {
        const role = interaction.options.getRole('role');
        if (!role) {
          throw new AppError('Pick a role with /mergeid settings protect-role.', {
            code: 'role_required',
            statusCode: 400,
            expose: true,
          });
        }
        if (sub === 'protect-role') {
          await rules.addProtectedRole({ guildId, roleId: role.id, actorDiscordId: actor });
          await interaction.editReply(
            `Protected ${mention(role.id)}. Verification rules can no longer grant it; it was also removed from the allowlist if it was there.`,
          );
        } else {
          await rules.removeProtectedRole({
            guildId: guildId,
            roleId: role.id,
            actorDiscordId: actor,
          });
          await interaction.editReply(
            `Unprotected ${mention(role.id)}. It can be added back to the allowlist with \`/mergeid roles add\`.`,
          );
        }
        return;
      }

      if (sub === 'log-channel') {
        const channel = interaction.options.getChannel('channel');
        await rules.setLogChannel({
          guildId,
          channelId: channel?.id ?? null,
          actorDiscordId: actor,
        });
        await interaction.editReply(
          channel
            ? `Log channel set to <#${channel.id}>. Sync failures will post there.`
            : 'Log channel cleared.',
        );
        return;
      }
    }

    if (group === null && sub === 'sync-status') {
      const status = await rules.syncStatus({ guildId });
      if (status.rules.length === 0) {
        await interaction.editReply(
          'No verification rules yet — nothing to sync. Add one with `/mergeid rules add`.',
        );
        return;
      }
      const lines = status.rules.map((rule) => {
        const shortId = `\`${rule.ruleId.slice(0, 8)}…\``;
        if (rule.runs24h === 0 || rule.lastStatus === null) {
          return `${shortId} · no runs in the last 24h (worker idle or schedule pending)`;
        }
        const when = `<t:${Math.floor((rule.lastRunAt?.getTime() ?? Date.now()) / 1000)}:R>`;
        return `${shortId} · last run ${when} (${rule.lastStatus}) · ${rule.checked} checks, ${rule.errored} errored, +${rule.granted}/-${rule.revoked} roles over ${rule.runs24h} run(s)`;
      });
      const t = status.totals;
      await interaction.editReply(
        [
          `**Sync health (last 24h):** ${t.runs24h} run(s) — ✅ ${t.ok24h} ok, ⚠️ ${t.partial24h} partial, ❌ ${t.failed24h} failed`,
          ...lines,
        ].join('\n'),
      );
      return;
    }

    if (group === null && sub === 'audit') {
      const count = interaction.options.getInteger('count') ?? 10;
      const events = await rules.listAuditEvents({ guildId, limit: count });
      if (events.length === 0) {
        await interaction.editReply(
          'No audit events in this server yet. Rule and settings changes appear here.',
        );
        return;
      }
      const lines = events.map((event) => {
        const when = `<t:${Math.floor(event.at.getTime() / 1000)}:R>`;
        const who = event.actorDiscordId ? `<@${event.actorDiscordId}>` : 'system';
        return `${when} · ${who} · \`${event.action}\`${event.subject ? ` · \`${event.subject.slice(0, 16)}\`` : ''}`;
      });
      await interaction.editReply(
        [`**Recent audit events (${events.length}):**`, ...lines].join('\n'),
      );
      return;
    }

    await interaction.editReply(
      'Usage: `/mergeid roles add|remove|list`, `/mergeid rules add|list|remove`, `/mergeid settings show|protect-role|unprotect-role|log-channel`, `/mergeid audit`.',
    );
  } catch (err) {
    if (err instanceof AppError && err.expose) {
      await interaction.editReply(err.message);
      return;
    }
    throw err;
  }
}
