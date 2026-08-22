import { describe, expect, it, vi } from 'vitest';

import {
  checkOrgMembership,
  checkRepoPushAccess,
  checkTeamMembership,
  type MemberOctokit,
} from '../../src/github/membership.js';

/** Minimal fake octokit with vi.fn() endpoints — nothing else is touched. */
function fakeOctokit() {
  return {
    orgs: { getMembershipForAuthenticatedUser: vi.fn() },
    repos: { get: vi.fn() },
    teams: { getMembershipForUserInOrg: vi.fn() },
  } as unknown as MemberOctokit;
}

const notFound = { status: 404 };

describe('checkOrgMembership', () => {
  it('is a member when state is active', async () => {
    const octokit = fakeOctokit();
    (octokit.orgs.getMembershipForAuthenticatedUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { state: 'active' },
    });
    await expect(checkOrgMembership(octokit, 'acme')).resolves.toEqual({ member: true });
    expect(octokit.orgs.getMembershipForAuthenticatedUser).toHaveBeenCalledWith({ org: 'acme' });
  });

  it('is not a member when state is pending', async () => {
    const octokit = fakeOctokit();
    (octokit.orgs.getMembershipForAuthenticatedUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { state: 'pending' },
    });
    await expect(checkOrgMembership(octokit, 'acme')).resolves.toEqual({ member: false });
  });

  it('treats 404 as not a member with a detail', async () => {
    const octokit = fakeOctokit();
    (octokit.orgs.getMembershipForAuthenticatedUser as ReturnType<typeof vi.fn>).mockRejectedValue(
      notFound,
    );
    const result = await checkOrgMembership(octokit, 'acme');
    expect(result.member).toBe(false);
    expect(result.detail).toContain('not a member');
  });

  it('rethrows non-404 errors', async () => {
    const octokit = fakeOctokit();
    (octokit.orgs.getMembershipForAuthenticatedUser as ReturnType<typeof vi.fn>).mockRejectedValue({
      status: 500,
    });
    await expect(checkOrgMembership(octokit, 'acme')).rejects.toMatchObject({ status: 500 });
  });
});

describe('checkRepoPushAccess', () => {
  it('has push access when permissions.push is true', async () => {
    const octokit = fakeOctokit();
    (octokit.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { permissions: { push: true, pull: true } },
    });
    await expect(checkRepoPushAccess(octokit, 'acme', 'api')).resolves.toEqual({ member: true });
    expect(octokit.repos.get).toHaveBeenCalledWith({ owner: 'acme', repo: 'api' });
  });

  it('lacks push access when permissions.push is false', async () => {
    const octokit = fakeOctokit();
    (octokit.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { permissions: { push: false, pull: true } },
    });
    const result = await checkRepoPushAccess(octokit, 'acme', 'api');
    expect(result.member).toBe(false);
    expect(result.detail).toContain('push access');
  });

  it('lacks push access when permissions are missing', async () => {
    const octokit = fakeOctokit();
    (octokit.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} });
    const result = await checkRepoPushAccess(octokit, 'acme', 'api');
    expect(result.member).toBe(false);
  });

  it('treats 404 as not a member with a detail', async () => {
    const octokit = fakeOctokit();
    (octokit.repos.get as ReturnType<typeof vi.fn>).mockRejectedValue(notFound);
    const result = await checkRepoPushAccess(octokit, 'acme', 'api');
    expect(result.member).toBe(false);
    expect(result.detail).toContain('repository not found');
  });

  it('rethrows non-404 errors', async () => {
    const octokit = fakeOctokit();
    (octokit.repos.get as ReturnType<typeof vi.fn>).mockRejectedValue({ status: 403 });
    await expect(checkRepoPushAccess(octokit, 'acme', 'api')).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('checkTeamMembership', () => {
  it('is a member when state is active', async () => {
    const octokit = fakeOctokit();
    (octokit.teams.getMembershipForUserInOrg as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { state: 'active' },
    });
    await expect(checkTeamMembership(octokit, 'acme', 'core', 'octocat')).resolves.toEqual({
      member: true,
    });
    expect(octokit.teams.getMembershipForUserInOrg).toHaveBeenCalledWith({
      org: 'acme',
      team_slug: 'core',
      username: 'octocat',
    });
  });

  it('is not a member when state is pending', async () => {
    const octokit = fakeOctokit();
    (octokit.teams.getMembershipForUserInOrg as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { state: 'pending' },
    });
    await expect(checkTeamMembership(octokit, 'acme', 'core', 'octocat')).resolves.toEqual({
      member: false,
    });
  });

  it('treats 404 as not a member', async () => {
    const octokit = fakeOctokit();
    (octokit.teams.getMembershipForUserInOrg as ReturnType<typeof vi.fn>).mockRejectedValue(
      notFound,
    );
    const result = await checkTeamMembership(octokit, 'acme', 'core', 'octocat');
    expect(result.member).toBe(false);
    expect(result.detail).toContain('not a member of the team');
  });

  it('rethrows non-404 errors', async () => {
    const octokit = fakeOctokit();
    (octokit.teams.getMembershipForUserInOrg as ReturnType<typeof vi.fn>).mockRejectedValue({
      status: 403,
    });
    await expect(checkTeamMembership(octokit, 'acme', 'core', 'octocat')).rejects.toMatchObject({
      status: 403,
    });
  });
});
