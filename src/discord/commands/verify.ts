import { SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

import type { VerificationEngine } from '../../verification/engine.js';
import type { Logger } from '../../lib/logger.js';

export const verifyCommandData = new SlashCommandBuilder()
  .setName('verify')
  .setDescription("Re-check your GitHub membership against this server's rules and refresh roles");

export async function executeVerify(
  interaction: ChatInputCommandInteraction,
  deps: { logger: Logger; engine: VerificationEngine },
): Promise<void> {
  if (!interaction.guildId) {
    // The router already deferred ephemerally; complete that initial reply.
    await interaction.editReply(
      'Run `/verify` inside a server — it checks the rules configured for that server.',
    );
    return;
  }

  const summary = await deps.engine.verifyUser({
    discordUserId: interaction.user.id,
    guildId: interaction.guildId,
  });

  if (summary.notVerified === 'not_linked') {
    await interaction.editReply('You have no GitHub account linked. Run `/link` first.');
    return;
  }
  if (summary.notVerified === 'no_rules') {
    await interaction.editReply(
      'This server has no verification rules configured yet. Ask an admin to add some with `/mergeid rules add`.',
    );
    return;
  }
  if (summary.notVerified === 'token_unavailable') {
    await interaction.editReply(
      "Could not verify: your stored GitHub token is unreadable or was revoked on GitHub's side. Re-link with `/link` (after `/unlink`).",
    );
    return;
  }

  const lines: string[] = [];
  lines.push(
    `**Verification complete** — ${summary.checked} rule${summary.checked === 1 ? '' : 's'} checked`,
  );
  lines.push(
    `✅ passed ${summary.passed} · ❌ failed ${summary.failed} · ⚠️ errored ${summary.errored}`,
  );

  const roleNames = summary.granted.map((id) => `<@&${id}>`);
  const revokedNames = summary.revoked.map((id) => `<@&${id}>`);
  if (roleNames.length > 0) lines.push(`🎖️ granted: ${roleNames.join(', ')}`);
  if (revokedNames.length > 0) lines.push(`🗑️ removed: ${revokedNames.join(', ')}`);
  if (summary.failures.length > 0) {
    lines.push(
      "⚠️ Some role changes were skipped by Discord (check the bot's role position and permissions).",
    );
  }

  await interaction.editReply(lines.join('\n'));
}
