# Admin setup guide

Everything an admin needs to configure MergeID in one server. All admin commands live under
`/mergeid` and require the **Manage Server** permission. Replies are ephemeral — only the
admin who ran the command sees them.

## Quick start

1. `/mergeid roles add role:@Contributor` — allowlist the roles rules may grant.
2. `/mergeid rules add kind:Organization membership org:acme role:@Contributor` — create a rule.
3. Members run `/link`, then `/verify`. Matching members get the role.

## Command reference

### Roles allowlist

- `/mergeid roles add role:` — allow a role to be granted by verification rules.
- `/mergeid roles remove role:` — stop allowing it. Existing rules keep referencing it until
  they are removed.
- `/mergeid roles list` — show the allowlist.

A rule can only hand out allowlisted roles. This is the main safety rail: nothing is grantable
that an admin did not explicitly opt in.

### Verification rules

- `/mergeid rules add kind: org: role: [repo:] [team:] [recheck:]`
  - `kind` — Organization membership, Repository collaborator (push access), or Team membership.
  - `org` — GitHub org name or a github.com URL; the URL form is normalized to the name.
  - `repo` — repo name only (REPO rules), e.g. `api`.
  - `team` — team slug (TEAM rules), e.g. `core-team`.
  - `recheck` — minutes between automatic re-checks (default 1440 = daily, minimum 30).
- `/mergeid rules list` — list rule ids and targets. Rule ids are shown short; use the full id
  from the add confirmation for removal.
- `/mergeid rules remove rule:` — delete a rule along with its recorded grants.

Per-server cap: 25 enabled rules.

### Guild settings

- `/mergeid settings show` — current allowlist, protected roles, and log channel.
- `/mergeid settings protect-role role:` — never let rules grant this role. If the role was
  allowlisted, protection also removes it from the allowlist in the same step.
- `/mergeid settings unprotect-role role:` — lift protection. The role still needs
  `/mergeid roles add` before rules can use it again.
- `/mergeid settings log-channel channel:` — where sync failures will be posted once periodic
  sync ships (M5). Run it with no channel to clear.

Protected roles are checked twice: at rule creation time and by the engine before any grant.

### Audit trail

- `/mergeid audit [count:]` — recent events, newest first (default 10, max 25).

Every rule change, settings change, link/unlink, and completed verification writes an audit row.
The view shows when it happened, who triggered it, and what changed. Reading the audit log never
writes an audit row.

## Safety model in brief

- Rules can only grant allowlisted roles; protected roles can never be granted.
- The engine only ever revokes roles that MergeID itself granted and recorded.
- A GitHub API error during verification keeps the last-known role state — no flapping on outage.
- All admin actions are audited with the acting user's id.
