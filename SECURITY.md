# Security Policy

## Supported versions

MergeID has not been released yet, so there are currently no supported versions.

Once 1.0 is released, security fixes will be provided for the latest minor
version only.

| Version                           | Supported                  |
| --------------------------------- | -------------------------- |
| Pre-release (current, unreleased) | No — no public release yet |
| Latest minor (after 1.0)          | Yes                        |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting feature instead:

1. Open the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Fill in the report with as much detail as you can.

### What to include

- Step-by-step instructions to reproduce the issue
- The potential impact of the vulnerability and who could exploit it
- The affected version(s), commit, or deployment configuration
- A proof of concept or script, if you have one

### What to expect

- We aim to acknowledge your report within **48 hours**.
- We aim to have a fix ready within **90 days** of confirming the issue.
- We follow coordinated disclosure: we will agree on a disclosure timeline with
  you before details are made public, and we will credit you in the release
  notes unless you prefer to stay anonymous.

## Out of scope

Issues caused by misconfiguration of self-hosted deployments are out of scope
for this policy. Examples include exposed database or Redis ports, leaked or
weak environment secrets, and missing TLS. If you self-host MergeID, follow the
deployment documentation to secure your instance.

## Security model

For the design-level security model — how GitHub OAuth tokens, Discord
identities, and verification data are handled — see
[docs/security-model.md](docs/security-model.md).
