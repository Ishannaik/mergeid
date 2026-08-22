/**
 * GET /oauth/callback — complete GitHub OAuth and persist the encrypted link.
 */

import type { FastifyInstance } from 'fastify';

import { OAuthStateError, type OAuthStateStore } from '../../oauth/index.js';
import { describeRoleOutcome, type LinkedRoleService } from '../../discord/roles.js';
import { exchangeCodeForToken, fetchGithubProfile } from '../../github/index.js';
import { AppError } from '../../lib/errors.js';
import { escapeHtml } from '../../lib/html.js';
import type { Config } from '../../config/index.js';
import type { Logger } from '../../lib/logger.js';
import type { LinkService } from '../../services/index.js';
import type { VerificationEngine } from '../../verification/engine.js';

function htmlPage(title: string, body: string, statusHint?: string): string {
  const hint = statusHint ? `<p class="hint">${escapeHtml(statusHint)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · MergeID</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem; color: #111; }
    h1 { font-size: 1.5rem; }
    .hint { color: #555; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p>${body}</p>
  ${hint}
</body>
</html>`;
}

export function registerOAuthRoutes(
  app: FastifyInstance,
  deps: {
    config: Config;
    logger: Logger;
    oauthState: OAuthStateStore;
    links: LinkService;
    linkedRoles: LinkedRoleService;
    engine: VerificationEngine | null;
  },
): void {
  const { config, logger, oauthState, links, linkedRoles, engine } = deps;

  app.get<{
    Querystring: { code?: string; state?: string; error?: string; error_description?: string };
  }>('/oauth/callback', async (request, reply) => {
    const { code, state, error, error_description: errorDescription } = request.query;

    if (error) {
      logger.info({ error }, 'oauth denied by user');
      return reply
        .status(400)
        .type('text/html')
        .send(
          htmlPage(
            'Authorization cancelled',
            'GitHub authorization was cancelled. You can close this tab and run <code>/link</code> again in Discord if you change your mind.',
            errorDescription,
          ),
        );
    }

    if (!code || !state) {
      return reply
        .status(400)
        .type('text/html')
        .send(
          htmlPage(
            'Invalid callback',
            'Missing code or state. Run <code>/link</code> again in Discord.',
          ),
        );
    }

    let record;
    try {
      record = await oauthState.consume(state);
    } catch (err) {
      if (err instanceof OAuthStateError) {
        return reply
          .status(400)
          .type('text/html')
          .send(
            htmlPage(
              'Link expired',
              'This link expired or was already used. Run <code>/link</code> again in Discord.',
            ),
          );
      }
      throw err;
    }

    try {
      const token = await exchangeCodeForToken(
        config,
        { code, codeVerifier: record.codeVerifier },
        logger,
      );
      const profile = await fetchGithubProfile(token.accessToken);

      await links.createLink({
        discordUserId: record.discordUserId,
        githubUserId: profile.id,
        githubLogin: profile.login,
        accessToken: token.accessToken,
        scopes: token.scopes.length > 0 ? token.scopes : config.GITHUB_BASE_SCOPES,
      });

      // This is the only place a link actually succeeds — /link merely hands out
      // an authorize URL — so the linked role is applied here, in the guild
      // recorded on the OAuth state. A refusal is reported on the page and
      // never unwinds the link that already committed above.
      const roleOutcome = await linkedRoles.grant({
        guildId: record.guildId ?? null,
        userId: record.discordUserId,
      });
      if (!roleOutcome.ok) {
        logger.warn(
          {
            outcome: roleOutcome.kind,
            detail: roleOutcome.detail,
            guildId: record.guildId ?? null,
          },
          'linked role grant failed after successful link',
        );
      }
      const roleNote = describeRoleOutcome(roleOutcome, 'grant');

      // M3: run the initial verification pass right away so the new link's
      // roles land without waiting for the user to run /verify. Runs only for
      // links started in a guild (DMs have no roles to apply).
      let verifyNote: string | null = null;
      if (engine && record.guildId) {
        try {
          const summary = await engine.verifyUser({
            discordUserId: record.discordUserId,
            guildId: record.guildId,
          });
          if (summary.notVerified === 'no_rules') {
            verifyNote =
              'This server has no verification rules yet — an admin can add them with /mergeid rules add.';
          } else if (
            summary.notVerified !== 'not_linked' &&
            summary.notVerified !== 'token_unavailable'
          ) {
            const granted = summary.granted.length;
            const removed = summary.revoked.length;
            verifyNote =
              granted > 0 || removed > 0
                ? `Verification done: ${granted} role${granted === 1 ? '' : 's'} granted, ${removed} removed.`
                : `Verification done: ${summary.checked} rule${summary.checked === 1 ? '' : 's'} checked. Run /status in Discord to confirm.`;
          }
        } catch (err) {
          // Verification is best-effort after a successful link — never let it
          // turn a successful link into an error page.
          logger.error({ err }, 'initial verification after link failed');
        }
      }

      return reply
        .status(200)
        .type('text/html')
        .send(
          htmlPage(
            'Linked!',
            `Your GitHub account <strong>@${escapeHtml(profile.login)}</strong> is now linked. You can close this tab and return to Discord.`,
            [roleNote, verifyNote, 'Run /status in Discord to confirm.'].filter(Boolean).join(' '),
          ),
        );
    } catch (err) {
      if (err instanceof AppError && err.expose) {
        const status = err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 400;
        return reply
          .status(status)
          .type('text/html')
          .send(
            htmlPage(status === 409 ? 'Already linked' : 'Link failed', escapeHtml(err.message)),
          );
      }

      logger.error({ err }, 'oauth callback failed');
      return reply
        .status(502)
        .type('text/html')
        .send(
          htmlPage(
            'Something went wrong',
            'We could not finish linking. Run <code>/link</code> again in Discord.',
          ),
        );
    }
  });
}
