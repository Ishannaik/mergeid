/**
 * GitHub membership checks used by the verification engine.
 *
 * Every check runs against the *member's own* access token (decrypted from
 * the link record). That is the security model's core property: a rule can
 * only grant a role when the member's own credentials prove membership, so a
 * malicious guild admin gains nothing by writing a rule for an org they do
 * not control (docs/security-model.md threat #7).
 *
 * All checks are read-only and need only `read:org` (private-repo rules
 * additionally need `repo`, enforced by the engine via the rule's
 * `requiredScopes`).
 */

import { Octokit } from '@octokit/rest';

export type MembershipCheckResult = { member: boolean; detail?: string };

/** Octokit instance already authenticated as the member under verification. */
export type MemberOctokit = Octokit;

/**
 * Organization membership for the authenticated user.
 *
 * `GET /user/memberships/orgs/{org}` returns the authenticated user's own
 * membership; state is `active` for members, `pending` for invited users who
 * have not accepted. We only count `active`.
 */
export async function checkOrgMembership(
  octokit: MemberOctokit,
  org: string,
): Promise<MembershipCheckResult> {
  try {
    const { data } = await octokit.orgs.getMembershipForAuthenticatedUser({ org });
    return { member: data.state === 'active' };
  } catch (err) {
    // 404 = not a member. Anything else (403 rate limit, network) must NOT
    // be treated as "not a member" — the engine decides how to classify
    // transient errors and keep last-known state.
    if (isNotFound(err)) {
      return { member: false, detail: 'not a member of the organization' };
    }
    throw err;
  }
}

/**
 * Repository push access for the authenticated user.
 *
 * `GET /repos/{owner}/{repo}` includes a `permissions` object when the token
 * can see the repo. Public repos resolve for any token; private repos require
 * the `repo` scope (checked by the engine before this runs). Push access is
 * required — `read` alone does not satisfy a collaborator rule.
 */
export async function checkRepoPushAccess(
  octokit: MemberOctokit,
  owner: string,
  repo: string,
): Promise<MembershipCheckResult> {
  try {
    const { data } = await octokit.repos.get({ owner, repo });
    const push = data.permissions?.push ?? false;
    return {
      member: push,
      detail: push ? undefined : 'does not have push access to the repository',
    };
  } catch (err) {
    if (isNotFound(err)) {
      return { member: false, detail: 'repository not found or not accessible' };
    }
    throw err;
  }
}

/**
 * Team membership for the authenticated user.
 *
 * `GET /orgs/{org}/teams/{team_slug}/memberships/{username}` — the username is
 * resolved once per verification run and reused. State `active` counts;
 * `pending` invites do not.
 */
export async function checkTeamMembership(
  octokit: MemberOctokit,
  org: string,
  teamSlug: string,
  username: string,
): Promise<MembershipCheckResult> {
  try {
    const { data } = await octokit.teams.getMembershipForUserInOrg({
      org,
      team_slug: teamSlug,
      username,
    });
    return { member: data.state === 'active' };
  } catch (err) {
    if (isNotFound(err)) {
      return { member: false, detail: 'not a member of the team' };
    }
    throw err;
  }
}

/** True for Octokit/axios 404 errors (the only error we treat as "no"). */
function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { status?: number }).status;
  return status === 404;
}
