/**
 * GitHub OAuth token exchange, profile fetch, and token revocation.
 *
 * Token exchange talks to github.com (not api.github.com). Profile uses
 * Octokit. Revocation uses Basic auth with the OAuth app credentials
 * (docs/oauth-flow.md, docs/architecture.md §8).
 */

import { Octokit } from '@octokit/rest';

import { AppError } from '../lib/errors.js';
import type { Config } from '../config/index.js';
import type { Logger } from '../lib/logger.js';

export interface GithubTokenExchangeResult {
  accessToken: string;
  scopes: string[];
  tokenType: string;
}

export interface GithubProfile {
  id: string;
  login: string;
}

interface TokenErrorBody {
  error?: string;
  error_description?: string;
  access_token?: string;
  scope?: string;
  token_type?: string;
}

export async function exchangeCodeForToken(
  config: Pick<Config, 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET' | 'OAUTH_REDIRECT_URI'>,
  input: { code: string; codeVerifier: string },
  logger: Logger,
): Promise<GithubTokenExchangeResult> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: config.GITHUB_CLIENT_ID,
      client_secret: config.GITHUB_CLIENT_SECRET,
      code: input.code,
      redirect_uri: config.OAUTH_REDIRECT_URI,
      code_verifier: input.codeVerifier,
    }),
  });

  const body = (await response.json()) as TokenErrorBody;

  if (!response.ok || body.error || !body.access_token) {
    logger.error({ status: response.status, error: body.error }, 'github token exchange failed');
    throw new AppError('GitHub token exchange failed', {
      code: 'github_token_exchange_failed',
      statusCode: 502,
      expose: true,
    });
  }

  const scopes = (body.scope ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    accessToken: body.access_token,
    scopes,
    tokenType: body.token_type ?? 'bearer',
  };
}

export async function fetchGithubProfile(accessToken: string): Promise<GithubProfile> {
  const octokit = new Octokit({ auth: accessToken });
  const { data } = await octokit.users.getAuthenticated();
  return {
    id: String(data.id),
    login: data.login,
  };
}

export async function revokeGithubToken(
  config: Pick<Config, 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET'>,
  accessToken: string,
  logger: Logger,
): Promise<void> {
  const credentials = Buffer.from(
    `${config.GITHUB_CLIENT_ID}:${config.GITHUB_CLIENT_SECRET}`,
  ).toString('base64');

  const response = await fetch(
    `https://api.github.com/applications/${config.GITHUB_CLIENT_ID}/token`,
    {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ access_token: accessToken }),
    },
  );

  // 204 = revoked; 404 = already gone — both are fine for unlink.
  if (response.status !== 204 && response.status !== 404) {
    logger.warn({ status: response.status }, 'github token revocation returned unexpected status');
    throw new AppError('GitHub token revocation failed', {
      code: 'github_token_revoke_failed',
      statusCode: 502,
      expose: false,
    });
  }
}

export function buildAuthorizeUrl(
  config: Pick<Config, 'GITHUB_CLIENT_ID' | 'OAUTH_REDIRECT_URI' | 'GITHUB_BASE_SCOPES'>,
  input: { state: string; codeChallenge: string },
): string {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', config.OAUTH_REDIRECT_URI);
  url.searchParams.set('scope', config.GITHUB_BASE_SCOPES.join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}
