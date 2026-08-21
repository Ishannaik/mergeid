# Configuration

> Environment variables, external app setup, and runtime configuration for MergeID.
> Copy [`.env.example`](../.env.example) to `.env` to get started.

## 1. Environment variables

| Variable               | Required | Description                                                                                                                          |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DISCORD_TOKEN`        | yes      | Bot token from the Discord developer portal.                                                                                         |
| `DISCORD_CLIENT_ID`    | yes      | Application ID of the Discord application (used for slash-command registration and invite URL).                                      |
| `DISCORD_DEV_GUILD_ID` | no       | When set, slash commands register to this guild only (instant updates during development).                                           |
| `GITHUB_CLIENT_ID`     | yes      | GitHub OAuth App client ID.                                                                                                          |
| `GITHUB_CLIENT_SECRET` | yes      | GitHub OAuth App client secret.                                                                                                      |
| `GITHUB_BASE_SCOPES`   | no       | Comma-separated base scopes. Default `read:user,read:org`.                                                                           |
| `OAUTH_REDIRECT_URI`   | yes      | OAuth callback URL; must exactly match the GitHub OAuth App's registered callback URL.                                               |
| `PUBLIC_BASE_URL`      | yes      | Public HTTPS origin of the HTTP role (used to construct callback URLs).                                                              |
| `PORT`                 | no       | HTTP server port. Default `3000`.                                                                                                    |
| `DATABASE_URL`         | yes      | PostgreSQL connection string.                                                                                                        |
| `REDIS_URL`            | no       | Redis connection string. Required for multi-process deployments; optional in single-process dev (in-memory fallback planned for M1). |
| `TOKEN_ENCRYPTION_KEY` | yes      | 32-byte hex key for AES-256-GCM token encryption. Generate: `openssl rand -hex 32`.                                                  |
| `NODE_ENV`             | no       | `development` / `production`. Default `development`.                                                                                 |
| `LOG_LEVEL`            | no       | pino level. Default `info`.                                                                                                          |
| `MERGEID_ROLES`        | no       | Comma-separated subset of `bot,api,worker`. Default: all three in one process.                                                       |

All variables are parsed and validated at boot with zod — the process refuses to start on missing
or malformed configuration, with a precise error naming the offending variable. Note: Prisma 7
does not auto-load `.env`; MergeID loads environment explicitly at boot before initializing the
database client.

### Container stack variables

[`docker/compose.prod.yml`](../docker/compose.prod.yml) provisions PostgreSQL and Redis itself and
reads extra variables that the application never sees:

| Variable              | Required | Description                                                                  |
| --------------------- | -------- | ---------------------------------------------------------------------------- |
| `POSTGRES_DB`         | no       | Database name. Default `mergeid`.                                            |
| `POSTGRES_USER`       | no       | Database user. Default `mergeid`.                                            |
| `POSTGRES_PASSWORD`   | yes      | Database password. No default.                                               |
| `REDIS_PASSWORD`      | yes      | Redis password (`requirepass`). No default.                                  |
| `HTTP_BIND_HOST`      | no       | Host interface the bot's HTTP port publishes on. Default `0.0.0.0`.          |
| `HTTP_PUBLISHED_PORT` | no       | Host port mapped to the container's `PORT`. Defaults to the value of `PORT`. |

By default the compose file builds `DATABASE_URL` and `REDIS_URL` for the `migrate` and `bot`
services from those values. They are inserted verbatim, so a user or password containing a
character that is reserved in a URI — `@`, `:`, `/`, `?`, `#`, `%` — produces a connection string
Prisma parses differently from what PostgreSQL was configured with, and `pnpm db:deploy` fails to
authenticate. Because `bot` waits on `service_completed_successfully`, the bot never starts.

Either keep the credentials free of those characters, or set `DATABASE_URL` / `REDIS_URL`
explicitly with the credentials percent-encoded — an explicit value overrides the composed default:

```sh
# POSTGRES_USER=us@r, POSTGRES_PASSWORD=p@ss/word
DATABASE_URL=postgresql://us%40r:p%40ss%2Fword@postgres:5432/mergeid
REDIS_URL=redis://:p%40ss%2Fword@redis:6379
```

Note the hosts are `postgres` and `redis` (the compose service names), not `localhost`.

### Exposing the OAuth callback

GitHub redirects the user's browser to `OAUTH_REDIRECT_URI`, so the `api` role's listener has to be
reachable from the public internet. The `bot` service publishes its port on all interfaces by
default, which is the working configuration when the host itself is the public endpoint and TLS is
terminated upstream.

When a reverse proxy on the same host terminates TLS and forwards to the bot, keep the port off the
public interface:

```sh
HTTP_BIND_HOST=127.0.0.1
HTTP_PUBLISHED_PORT=3000
```

`PUBLIC_BASE_URL` and `OAUTH_REDIRECT_URI` must always name the **public** HTTPS origin, not the
published host port — they are what GitHub sees.

### Redis exposure

Redis is not published to the host, so it is reachable only from this compose project's network.
It nevertheless runs with `requirepass`: the AOF file on the `redis-data` volume holds queue
payloads, and on a host running other compose stacks an unauthenticated Redis is one shared network
away from anything else on the box. The healthcheck authenticates with the same password, so a
missing or wrong `REDIS_PASSWORD` fails the container's health gate rather than silently starting
an open instance.

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

### Deploy slash commands

Set `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`, then register the current shared command registry:

```sh
pnpm run deploy-commands
```

With `DISCORD_DEV_GUILD_ID` unset, registration is global. Set it during development to update
commands in only that guild, where changes propagate immediately. Registration is one bulk
replacement for the selected scope; deploying an empty registry clears commands in that scope.
Keep the bot token in the environment—never paste it into the command or print it in logs.

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
