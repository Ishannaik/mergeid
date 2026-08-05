# Roadmap

> Mirrors the [GitHub milestones](https://github.com/Ishannaik/mergeid/milestones). If this
> document and the issue tracker disagree, the issue tracker wins.

## Milestones

| ID  | Milestone                   | Goal                                                              | Exit criteria                                                       |
| --- | --------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| M1  | Foundations & tooling       | Runtime deps, config, DB, Docker, CI green with real dependencies | Bot boots to a ready state with no commands                         |
| M2  | Core account linking        | GitHub OAuth end-to-end: `/link`, `/unlink`, `/status`            | A user can link, see status, and unlink with GitHub-side revocation |
| M3  | Verification engine & roles | Org/repo/team checks → role assignment                            | Rules grant and revoke roles correctly in a test server             |
| M4  | Admin configuration         | Rule CRUD, guild settings, audit                                  | Full self-serve admin UX with audit trail                           |
| M5  | Periodic sync & reliability | BullMQ worker, budgets, retries, caching                          | Roles converge automatically and survive API failures               |
| M6  | Hardening & v1.0 launch     | Security audit, e2e tests, docs, GHCR image, launch               | Public v1.0.0 release                                               |

## Issue breakdown

### M1 — Foundations & tooling

1. Install runtime dependencies & create entry skeleton — discord.js, fastify, prisma, bullmq, ioredis, octokit, zod, pino
2. Env loading & validation with zod (`src/config`)
3. Prisma schema + initial migration (from `docs/database.md`)
4. docker-compose for local development (Postgres + Redis)
5. Dockerfile + production compose skeleton
6. Enable GitHub secret scanning + verify CodeQL/gitleaks pipelines

### M2 — Core account linking (GitHub OAuth)

1. Discord client bootstrap + interaction framework + command registration
2. OAuth state store in Redis (single-use nonce, TTL)
3. `/link` command with ephemeral personalized OAuth URL
4. Fastify server + `GET /oauth/callback` route
5. GitHub token exchange + profile fetch (Octokit)
6. AES-256-GCM token encryption module (`src/crypto`) + key versioning
7. Link persistence + duplicate-link guards
8. `/unlink` (with GitHub-side token revocation) + `/status`

### M3 — Verification engine & roles

1. Rule model + verification engine core
2. Org membership check (`read:org`)
3. Repo collaborator check (`permissions.push`)
4. Team membership check (`/user/teams`)
5. Role grant/revoke service with hierarchy + allowlist safety rails
6. `/verify` manual re-check command
7. Verification engine unit tests (mocked GitHub responses)

### M4 — Admin configuration

1. `/mergeid` admin command group gated by `ManageGuild`
2. Rule CRUD subcommands (`rules add/list/remove`)
3. Guild settings (log channel, assignable/protected roles, sync limits)
4. Audit event recording + audit query command
5. Admin setup guide (docs)

### M5 — Periodic sync & reliability

1. BullMQ worker + queue wiring
2. Repeatable per-rule re-verification jobs (jittered schedules)
3. GitHub API rate budgeter + exponential backoff with jitter
4. Membership result caching + diff-only role changes
5. Retry / dead-letter handling + error surfacing to guild log channel
6. `/mergeid sync status` command + structured metrics logging
7. Sharding readiness review + load test plan

### M6 — Hardening & v1.0 launch

1. Security audit: token handling + threat-model walkthrough
2. End-to-end OAuth flow tests (mocked GitHub + Discord)
3. README polish + self-hosting guide
4. changesets config + v1.0.0 release dry run
5. Publish Docker image to GHCR + production compose
6. Support server + public invite link + launch checklist

## Labels

| Label                                                                                                                                                                                    | Meaning                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `type:feature` / `type:bug` / `type:docs` / `type:chore` / `type:security` / `type:test` / `type:refactor`                                                                               | Kind of work                               |
| `area:discord` / `area:github-api` / `area:oauth` / `area:database` / `area:http-api` / `area:verification` / `area:sync` / `area:config` / `area:ci-cd` / `area:docs` / `area:security` | Component touched                          |
| `priority:high` / `priority:medium` / `priority:low`                                                                                                                                     | Urgency within a milestone                 |
| `good first issue` / `help wanted`                                                                                                                                                       | Contribution signals                       |
| `blocked`                                                                                                                                                                                | Waiting on external input or another issue |

## Definition of done (per issue)

- Code merged via PR with green CI (lint, typecheck, tests, build).
- Tests added/updated where behavior changed.
- Docs updated if user-facing behavior or configuration changed.
- Conventional commit history; squash-merge keeps `main` linear.
