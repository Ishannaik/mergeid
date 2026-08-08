# Configuration

> Environment variables, external app setup, and runtime configuration for MergeID.
> Copy [`.env.example`](../.env.example) to `.env` to get started.

## 1. Environment variables

| Variable                 | Required | Description                                                                                                                                                                                  |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`          | yes      | Bot token from the Discord developer portal.                                                                                                                                                 |
| `DISCORD_CLIENT_ID`      | yes      | Application ID of the Discord application (used for slash-command registration and invite URL).                                                                                              |
| `DISCORD_DEV_GUILD_ID`   | no       | When set, slash commands register to this guild only (instant updates during development).                                                                                                   |
| `MERGEID_LINKED_ROLE_ID` | no       | Role snowflake granted on a successful link and removed on `/unlink`. Unset disables the feature. Needs `Manage Roles` and the bot's role positioned above it. Unrelated to `MERGEID_ROLES`. |
| `GITHUB_CLIENT_ID`       | yes      | GitHub OAuth App client ID.                                                                                                                                                                  |
| `GITHUB_CLIENT_SECRET`   | yes      | GitHub OAuth App client secret.                                                                                                                                                              |
| `GITHUB_BASE_SCOPES`     | no       | Comma-separated base scopes. Default `read:user,read:org`.                                                                                                                                   |
| `OAUTH_REDIRECT_URI`     | yes      | OAuth callback URL; must exactly match the GitHub OAuth App's registered callback URL.                                                                                                       |
| `PUBLIC_BASE_URL`        | yes      | Public HTTPS origin of the HTTP role (used to construct callback URLs).                                                                                                                      |
| `PORT`                   | no       | HTTP server port. Default `3000`.                                                                                                                                                            |
| `DATABASE_URL`           | yes      | PostgreSQL connection string.                                                                                                                                                                |
| `REDIS_URL`              | no       | Redis connection string. Required for multi-process deployments; optional in single-process dev (in-memory fallback planned for M1).                                                         |
| `TOKEN_ENCRYPTION_KEY`   | yes      | 32-byte hex key for AES-256-GCM token encryption. Generate: `openssl rand -hex 32`.                                                                                                          |
| `NODE_ENV`               | no       | `development` / `production`. Default `development`.                                                                                                                                         |
| `LOG_LEVEL`              | no       | pino level. Default `info`.                                                                                                                                                                  |
| `MERGEID_ROLES`          | no       | Comma-separated subset of `bot,api,worker`. Default: all three in one process.                                                                                                               |

All variables are parsed and validated at boot with zod — the process refuses to start on missing
or malformed configuration, with a precise error naming the offending variable. Note: Prisma 7
does not auto-load `.env`; MergeID loads environment explicitly at boot before initializing the
database client.

## 2. Discord application setup

1. <https://discord.com/developers/applications> → **New Application** → name it.
2. **Bot** tab → Reset Token → copy into `DISCORD_TOKEN`.
3. Leave **Privileged Gateway Intents OFF** — MergeID needs none.
4. **OAuth2 → URL Generator**: scopes `bot`, `applications.commands`; bot permission
   `Manage Roles` (integer `268435456`).
   Invite URL:
   `https://discord.com/oauth2/authorize?client_id=<DISCORD_CLIENT_ID>&scope=bot%20applications.commands&permissions=268435456`
5. In each server, place MergeID's role **above** every role it should manage and **below**
   privileged roles (admin, owner-level).

## 3. GitHub OAuth App setup

1. Profile → Settings → Developer settings → **OAuth Apps** → **New OAuth App**.
2. **Homepage URL**: your project or instance page.
3. **Authorization callback URL**: `https://<your-host>/oauth/callback` → same value into
   `OAUTH_REDIRECT_URI`.
4. Copy **Client ID**; generate **Client Secret** → env.

## 4. Per-guild runtime configuration (stored in DB)

Managed by admins through `/mergeid settings` (milestone M4) — **not** env vars:

| Setting              | Default | Meaning                                             |
| -------------------- | ------- | --------------------------------------------------- |
| `enabled`            | `true`  | Master switch for the guild                         |
| `logChannelId`       | unset   | Channel for sync/audit notifications                |
| `assignableRoles`    | `[]`    | Allowlist of role IDs rules may grant               |
| `protectedRoleIds`   | `[]`    | Roles MergeID will never touch                      |
| `gracePeriodMinutes` | `60`    | Grace before definitive role removal after failures |
| `minRecheckMinutes`  | `60`    | Floor for rule `recheck_minutes`                    |
| `auditRetentionDays` | `90`    | Audit event retention                               |

## 5. External services summary

| Service                      | Used for                                           | Required                                        |
| ---------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| Discord API (gateway + REST) | Interactions, roles, DMs                           | yes                                             |
| GitHub REST API + OAuth      | Identity, membership checks, token exchange/revoke | yes                                             |
| PostgreSQL                   | All durable state                                  | yes                                             |
| Redis                        | OAuth state, rate budgets, BullMQ jobs             | yes (in-memory fallback for single-process dev) |
| Sentry _(optional)_          | Error tracking                                     | no                                              |
| GHCR _(self-host infra)_     | Docker image distribution                          | no                                              |
