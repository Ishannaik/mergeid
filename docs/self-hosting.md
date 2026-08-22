# Self-hosting MergeID

Run your own instance in ~10 minutes. Requirements: a server with Docker (or
Node 22+), a PostgreSQL database, a Redis instance, a Discord application, and
a GitHub OAuth app.

## 1. Discord application

1. Go to the [Discord developer portal](https://discord.com/developers/applications) →
   **New Application**.
2. **Bot** tab → copy the token → `DISCORD_TOKEN`.
3. **Bot** tab → enable **no privileged intents** (leave all three switches off).
4. **OAuth2 → URL Generator**: scope `bot` + `applications.commands`, permission
   `Manage Roles`. Open the generated URL to invite the bot to your server.
5. Copy the **Application ID** → `DISCORD_CLIENT_ID`.

## 2. GitHub OAuth app

1. GitHub → Settings → Developer settings → **OAuth Apps** → New.
2. Homepage URL: your deployment's public URL. Callback URL:
   `https://YOUR-DOMAIN/oauth/callback` (must match `OAUTH_REDIRECT_URI`).
3. Copy the client id → `GITHUB_CLIENT_ID`, and the secret → `GITHUB_CLIENT_SECRET`.
4. Leave scopes at the default requested by the bot: `read:user,read:org`.

## 3. Data stores

- **PostgreSQL** — any 14+ instance. Set `DATABASE_URL`.
- **Redis** — any 6+ instance. Set `REDIS_URL`. Holds OAuth nonces (TTL-bounded)
  and BullMQ sync schedules.

## 4. Encryption key

Generate once, store like a password:

```
openssl rand -hex 32   # → TOKEN_ENCRYPTION_KEY
```

Rotating later: add the old key as a legacy key, bump
`TOKEN_ENCRYPTION_KEY_VERSION`, keep both mounted until rows re-encrypt.

## 5. Configure and run

Copy `.env.example` → `.env`, fill it in, then:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm db:deploy        # apply migrations
pnpm deploy-commands  # register slash commands
pnpm start            # runs bot + api + worker roles in one process
```

Or with Docker Compose (dev stack):

```bash
docker compose -f docker/compose.dev.yaml up -d postgres redis
```

### Splitting roles across processes

`MERGEID_ROLES` selects which roles a process runs:

- `bot,api` — the gateway + HTTP roles; required together so links complete.
- `worker` — periodic verification; can be a separate scaled process.

## 6. First-run checklist

1. `/mergeid roles add role:@Verified` — allowlist the roles rules may grant.
2. `/mergeid rules add kind:Organization membership org:your-org role:@Verified`
3. Members run `/link`, then `/verify`.
4. `/mergeid settings log-channel #mergeid-logs` — where failures will post.
5. `/mergeid sync-status` — confirm the worker is converging.

## Operations

- **Health:** `GET /healthz` on the api role's port returns `{"ok":true}`.
- **Logs:** structured pino JSON; secrets are redacted at the logger level.
- **Backups:** Postgres dumps contain encrypted tokens only — still treat them
  as sensitive and keep `TOKEN_ENCRYPTION_KEY` out of backup storage.
- **Upgrades:** pull, `pnpm db:deploy`, restart. Migrations are forward-only.

## Uninstall / data deletion

1. `/unlink` removes a user's link, token (revoked on GitHub's side), results,
   and grants.
2. Drop the database schema (`prisma migrate reset` or drop) for full purge.
3. Remove the bot from the guild; no data remains outside your database.
