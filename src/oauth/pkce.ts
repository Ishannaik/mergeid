/**
 * PKCE (S256) helpers for the GitHub OAuth App flow.
 *
 * GitHub strongly recommends PKCE for OAuth apps; we generate a per-attempt
 * verifier, send its S256 challenge on authorize, and present the verifier at
 * token exchange (docs/oauth-flow.md).
 */

import { createHash, randomBytes } from 'node:crypto';

/** RFC 7636: code_verifier length 43–128. We use 64 bytes → 86 base64url chars. */
export function generateCodeVerifier(): string {
  return randomBytes(64).toString('base64url');
}

export function createCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** 128-bit CSPRNG nonce for the OAuth `state` parameter. */
export function generateOAuthState(): string {
  return randomBytes(16).toString('base64url');
}
