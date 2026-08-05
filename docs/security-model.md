# Security model

> Threat model, permission model, and privacy architecture for MergeID.
> For vulnerability _reporting_, see [SECURITY.md](../SECURITY.md).

## 1. Assets

| Asset                      | Value                                            | Where it lives                       |
| -------------------------- | ------------------------------------------------ | ------------------------------------ |
| GitHub access tokens       | High — bearer credentials to users' GitHub reads | Encrypted in `github_links`          |
| Discord bot token          | High — controls the bot identity                 | Env/secret manager only, never in DB |
| GitHub OAuth client secret | High — can mint tokens via the flow              | Env/secret manager only              |
| Link graph (who is who)    | Medium — identity mapping, personal data         | PostgreSQL                           |
| Role grants                | Medium — authorization decisions                 | PostgreSQL + Discord roles           |
| Audit log                  | Medium — integrity matters                       | PostgreSQL                           |

## 2. Threat model and mitigations

| #   | Threat                                 | Attack sketch                                                                                                         | Mitigation                                                                                                                                                                                                 |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **DB breach exposes tokens**           | Attacker steals PostgreSQL dump                                                                                       | Tokens encrypted per-row with AES-256-GCM under a key held only in env/KMS (`TOKEN_ENCRYPTION_KEY`); key versioning enables rotation; backups inherit token controls; scopes are read-only, capping damage |
| 2   | **OAuth CSRF / link hijack**           | Attacker tricks victim's browser into completing attacker's OAuth flow, binding attacker's GitHub to victim's Discord | Single-use `state` nonce bound to the initiating Discord user id in Redis (TTL 600 s); callback rejected unless state resolves to the expected user                                                        |
| 3   | **OAuth mix-up**                       | Callback replayed against a different relying party                                                                   | Single GitHub OAuth app, strict redirect URI registered with GitHub, `state` lookup scoped to this deployment                                                                                              |
| 4   | **Impersonation via renamed accounts** | GitHub login changes; stale login used for checks                                                                     | Authorization keyed on numeric `github_user_id`, never login                                                                                                                                               |
| 5   | **Double-linking abuse**               | One GitHub account grants roles to many Discord accounts                                                              | Unique constraint: `github_user_id` → single Discord account                                                                                                                                               |
| 6   | **Privilege escalation via roles**     | Rule grants a role above the bot's own position or an admin role                                                      | Rules can only reference a guild-configured allowlist of roles; bot refuses roles higher than its own role or in `protectedRoleIds`; admin commands require `ManageGuild`                                  |
| 7   | **Malicious guild admin rules**        | Admin creates rule for an org they don't control                                                                      | Harmless by construction: rules only grant roles when the _member's own token_ proves membership — admin gains nothing; rule count per guild is capped                                                     |
| 8   | **Role flapping / denial of service**  | GitHub outage causes mass role revocation                                                                             | Diff-based reconciliation; transient errors keep last-known state; grace period before definitive removal; per-rule rate limits on re-checks                                                               |
| 9   | **Rate-limit exhaustion**              | Large guilds burn GitHub API budget                                                                                   | Redis token-bucket budgeter per GitHub token; exponential backoff + full jitter; membership cache fast-path; queue concurrency caps                                                                        |
| 10  | **Token leakage in logs**              | Secrets printed in stack traces/logs                                                                                  | pino redaction paths for token fields; tokens never in URLs/query strings; error types wrap without embedding credentials                                                                                  |
| 11  | **Secrets in repo**                    | Dev commits `.env`                                                                                                    | `.gitignore`, `.env.example` only, gitleaks scan in CI, GitHub secret scanning + push protection                                                                                                           |
| 12  | **SQL injection**                      | Malicious input into queries                                                                                          | Prisma parameterized queries exclusively; no raw string interpolation                                                                                                                                      |
| 13  | **Discord bot token theft**            | Host compromise                                                                                                       | Env-only secret, minimal bot permissions (no privileged intents), token rotation runbook, secret scanning                                                                                                  |
| 14  | **Callback endpoint abuse**            | Flood of callback requests                                                                                            | Stateless handler, Redis TTL caps stored state volume, standard HTTP rate limiting at proxy layer                                                                                                          |
| 15  | **Supply chain**                       | Malicious dependency                                                                                                  | Lockfiles committed, Dependabot, minimal dependency set, versions pinned to majors in CI review                                                                                                            |
| 16  | **Zombie access**                      | User leaves org but keeps roles                                                                                       | Periodic re-verification is a first-class feature (M5), not a bolt-on                                                                                                                                      |

## 3. Discord permission model

**Bot permissions requested (invite URL):** `Manage Roles` only (+ implicit view/send for
interactions). Bot's role must sit **above** the roles it manages and below privileged roles.

**No privileged gateway intents.** No message content, no full member list — member objects are
fetched on demand by id.

| Command                                  | Who           | Gate                     |
| ---------------------------------------- | ------------- | ------------------------ |
| `/link`, `/unlink`, `/status`, `/verify` | Any member    | Ephemeral responses only |
| `/mergeid rules add/list/remove`         | Server admins | `ManageGuild`            |
| `/mergeid settings …`                    | Server admins | `ManageGuild`            |
| `/mergeid audit`                         | Server admins | `ManageGuild`            |
| `/mergeid sync status`                   | Server admins | `ManageGuild`            |

**Role safety rails:**

- Roles must be added to a guild allowlist (`settings.assignableRoles`) before any rule can use them.
- The engine refuses roles above the bot's own role and any role flagged protected.
- Every grant/revoke is written to `role_grants` and audit before/after Discord API calls.

## 4. GitHub permission model

- Base scopes: `read:user,read:org`. Escalation to `repo` only for private-repo rules, and only
  with explicit user consent at re-link.
- **No write scopes, ever.** MergeID cannot push code, manage repos, or act as the user.
- Tokens are revoked on GitHub's side at unlink (`DELETE /applications/{client_id}/token`).

## 5. Secret handling

| Secret                      | Storage              | Rotation                                                                   |
| --------------------------- | -------------------- | -------------------------------------------------------------------------- |
| `DISCORD_TOKEN`             | Env / secret manager | Discord developer portal; redeploy                                         |
| `GITHUB_CLIENT_SECRET`      | Env / secret manager | GitHub OAuth app settings; both old+new honored during cutover             |
| `TOKEN_ENCRYPTION_KEY`      | Env / KMS, 32 bytes  | Key-versioned ciphertexts; rotate by re-encrypting rows lazily on next use |
| `DATABASE_URL`, `REDIS_URL` | Env                  | Credential rotation at the datastore                                       |

Rules: secrets load via env and are validated by zod at boot; they never appear in logs (pino
redaction), URLs, audit `meta`, or error responses.

## 6. Privacy principles

1. **User-initiated only.** MergeID never discovers or infers GitHub identities — a link exists
   only because the user completed OAuth.
2. **Minimum data.** What we store and why:

   | Data                      | Purpose                               | Retention                                 |
   | ------------------------- | ------------------------------------- | ----------------------------------------- |
   | Discord user id           | Link key                              | Until unlink                              |
   | GitHub numeric id + login | Verification identity                 | Until unlink                              |
   | Encrypted token + scopes  | Periodic re-verification              | Until unlink (revoked on GitHub side too) |
   | Membership results        | Role reconciliation + flap prevention | Until unlink                              |
   | Audit events              | Admin accountability                  | 90 days (configurable)                    |

3. **No tracking.** No analytics, no message content, no presence tracking, no cross-guild
   profiling. Audit is per-guild and only for that guild's admins.
4. **Deletion is real.** `/unlink` deletes token, results, and grants; leaving all servers purges
   per-guild state; self-hosters get a documented purge procedure.
5. **Transparency.** `/status` shows the user exactly what is stored and which scopes are granted.
