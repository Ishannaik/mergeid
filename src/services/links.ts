/**
 * Account-link domain service — the only layer that writes github_links.
 *
 * Tokens are encrypted before insert. Duplicate GitHub↔Discord bindings are
 * rejected (docs/database.md, docs/oauth-flow.md). Audit rows never include
 * the token.
 */

import { Prisma } from '../generated/prisma/client.js';

import { encryptToken, decryptToken } from '../crypto/index.js';
import { AppError } from '../lib/errors.js';
import type { PrismaClient } from '../lib/prisma.js';
import type { Config } from '../config/index.js';
import type { Logger } from '../lib/logger.js';
import { revokeGithubToken } from '../github/oauth.js';

type JsonValue = Prisma.InputJsonValue;

export interface CreateLinkInput {
  discordUserId: string;
  githubUserId: string;
  githubLogin: string;
  accessToken: string;
  scopes: string[];
}

export interface LinkStatus {
  linked: boolean;
  githubLogin?: string;
  githubUserId?: string;
  scopes?: string[];
  linkedAt?: Date;
  lastVerifiedAt?: Date | null;
}

export function createLinkService(deps: {
  prisma: PrismaClient;
  config: Config;
  logger: Logger;
}) {
  const { prisma, config, logger } = deps;

  async function ensureUser(discordUserId: string): Promise<void> {
    await prisma.user.upsert({
      where: { discordUserId },
      create: { discordUserId, createdAt: new Date() },
      update: {},
    });
  }

  async function writeAudit(input: {
    action: string;
    actorDiscordId?: string;
    subject?: string;
    meta?: JsonValue;
    guildId?: string | null;
  }): Promise<void> {
    await prisma.auditEvent.create({
      data: {
        guildId: input.guildId ?? null,
        actorDiscordId: input.actorDiscordId ?? null,
        action: input.action,
        subject: input.subject ?? null,
        meta: input.meta ?? {},
        at: new Date(),
      },
    });
  }

  return {
    async getStatus(discordUserId: string): Promise<LinkStatus> {
      const link = await prisma.githubLink.findUnique({ where: { discordUserId } });
      if (!link) return { linked: false };
      return {
        linked: true,
        githubLogin: link.githubLogin,
        githubUserId: link.githubUserId,
        scopes: link.tokenScopes.split(',').filter(Boolean),
        linkedAt: link.linkedAt,
        lastVerifiedAt: link.lastVerifiedAt,
      };
    },

    async createLink(input: CreateLinkInput): Promise<{ id: string }> {
      await ensureUser(input.discordUserId);

      const existingDiscord = await prisma.githubLink.findUnique({
        where: { discordUserId: input.discordUserId },
      });
      if (existingDiscord) {
        await writeAudit({
          action: 'link.blocked',
          actorDiscordId: input.discordUserId,
          subject: input.githubUserId,
          meta: { reason: 'discord_already_linked' },
        });
        throw new AppError('This Discord account is already linked to a GitHub account.', {
          code: 'discord_already_linked',
          statusCode: 409,
          expose: true,
        });
      }

      const existingGithub = await prisma.githubLink.findUnique({
        where: { githubUserId: input.githubUserId },
      });
      if (existingGithub) {
        await writeAudit({
          action: 'link.blocked',
          actorDiscordId: input.discordUserId,
          subject: input.githubUserId,
          meta: { reason: 'github_already_linked' },
        });
        throw new AppError(
          'That GitHub account is already linked to a different Discord account.',
          {
            code: 'github_already_linked',
            statusCode: 409,
            expose: true,
          },
        );
      }

      const tokenEncrypted = encryptToken(input.accessToken, {
        keyHex: config.TOKEN_ENCRYPTION_KEY,
        keyVersion: config.TOKEN_ENCRYPTION_KEY_VERSION,
      });

      try {
        const link = await prisma.githubLink.create({
          data: {
            discordUserId: input.discordUserId,
            githubUserId: input.githubUserId,
            githubLogin: input.githubLogin,
            tokenEncrypted,
            tokenKeyVersion: config.TOKEN_ENCRYPTION_KEY_VERSION,
            tokenScopes: input.scopes.join(','),
            linkedAt: new Date(),
          },
        });

        await writeAudit({
          action: 'link.created',
          actorDiscordId: input.discordUserId,
          subject: input.githubUserId,
          meta: {
            githubLogin: input.githubLogin,
            scopes: input.scopes,
          },
        });

        return { id: link.id };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new AppError('Link already exists.', {
            code: 'link_conflict',
            statusCode: 409,
            expose: true,
            cause: err,
          });
        }
        throw err;
      }
    },

    async unlink(discordUserId: string): Promise<{ unlinked: boolean }> {
      const link = await prisma.githubLink.findUnique({ where: { discordUserId } });
      if (!link) {
        return { unlinked: false };
      }

      let accessToken: string | null = null;
      try {
        accessToken = decryptToken(link.tokenEncrypted, {
          keyHex: config.TOKEN_ENCRYPTION_KEY,
        });
      } catch (err) {
        logger.error({ err }, 'failed to decrypt token during unlink; continuing with delete');
      }

      if (accessToken) {
        try {
          await revokeGithubToken(config, accessToken, logger);
        } catch (err) {
          // Still delete local state — user asked to unlink. Log for operators.
          logger.error({ err }, 'github revocation failed during unlink');
        }
      }

      await prisma.$transaction(async (tx) => {
        await tx.membershipResult.deleteMany({ where: { linkId: link.id } });
        await tx.roleGrant.deleteMany({ where: { discordUserId } });
        await tx.githubLink.delete({ where: { id: link.id } });
        await tx.auditEvent.create({
          data: {
            guildId: null,
            actorDiscordId: discordUserId,
            action: 'link.removed',
            subject: link.githubUserId,
            meta: { githubLogin: link.githubLogin },
            at: new Date(),
          },
        });
      });

      return { unlinked: true };
    },
  };
}

export type LinkService = ReturnType<typeof createLinkService>;
