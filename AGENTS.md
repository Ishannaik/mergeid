# AGENTS.md

This file is the repository-level guide for coding agents and contributors working on MergeID.
It applies to the entire repository. Keep it concise and update it when architecture, tooling, or
contributor workflows materially change.

## Project purpose and status

MergeID is a privacy-first Discord bot that links Discord members to GitHub accounts through
GitHub OAuth, verifies organization/repository/team membership, and assigns Discord roles.

The project is **pre-alpha and under active implementation**. The design documents describe the
approved target architecture, while `src/` contains only the milestones implemented so far. Before
changing a subsystem:

1. Read the current source and tests for implemented behavior.
2. Read the matching design document for intended boundaries and security requirements.
3. Check the [roadmap](docs/roadmap.md) and GitHub issues for implementation status.

Do not assume that a component is implemented merely because a design document describes it. For
current automation, the workflow YAML and package scripts are authoritative. For the conceptual
data model, [`docs/database.md`](docs/database.md) explicitly takes precedence if it disagrees with
the Prisma schema until the schema is corrected.

## Architecture

### Runtime topology

[`src/index.ts`](src/index.ts) is the application entry point. `MERGEID_ROLES` selects a
comma-separated subset of three runtime roles, with all roles enabled by default:

- **`bot`** — Discord gateway, slash-command dispatch, and role interaction via discord.js.
- **`api`** — planned stateless Fastify HTTP service for OAuth callbacks and health checks.
- **`worker`** — planned BullMQ worker for periodic verification, retries, and rate budgeting.

The entry point starts roles in deterministic order and owns process signals, error handling,
reverse-order graceful shutdown, and the shutdown timeout. Runtime roles implement the small
`RuntimeRole` contract in [`src/lib/runtime.ts`](src/lib/runtime.ts).

Current implementation status:

- The Discord client, interaction boundary, command deployment CLI, and shared command registry are
  implemented under [`src/discord/`](src/discord/). The registry is currently empty.
- [`src/api/server.ts`](src/api/server.ts) and [`src/sync/worker.ts`](src/sync/worker.ts) are
  intentional no-op placeholders and do not bind Fastify or BullMQ yet.
- `src/config/`, `src/crypto/`, `src/github/`, `src/services/`, and `src/verification/` remain
  scaffolded for later milestones.

The target topology allows a small deployment to run all roles in one Node.js process and later
split them into independently scaled deployments. Cross-component coordination must use
PostgreSQL for durable state and Redis for ephemeral state, rate budgets, and queues—not process
memory. See [`docs/architecture.md`](docs/architecture.md).

### Module boundaries

Preserve these target boundaries when implementing new work:

| Area               | Owns                                                                          | Must not own                         |
| ------------------ | ----------------------------------------------------------------------------- | ------------------------------------ |
| `discord/commands` | Slash-command schemas, permission checks, ephemeral interaction UX            | Direct database or GitHub access     |
| `api/routes`       | OAuth callback validation and minimal HTTP responses                          | Local durable state or token logging |
| `github`           | OAuth exchange and normalized GitHub REST checks                              | Role decisions or database writes    |
| `verification`     | Pure rule evaluation and role-decision diffs                                  | Uninjected I/O                       |
| `sync`             | Scheduling, retries, backoff, and budgets                                     | Direct Discord calls                 |
| `services`         | Domain operations, all database writes, audit events, role-grant transactions | Parsing transport-specific payloads  |
| `crypto`           | Token encryption/decryption and key versioning                                | Database or network access           |

The principal designed flows are documented separately:

- OAuth account linking: [`docs/oauth-flow.md`](docs/oauth-flow.md)
- On-demand verification and periodic sync: [`docs/architecture.md`](docs/architecture.md)
- Role safety, error handling, and privacy: [`docs/security-model.md`](docs/security-model.md)

### Persistence

[`prisma/schema.prisma`](prisma/schema.prisma) is the concrete Prisma 7/PostgreSQL schema. Its main
models are `Guild`, `User`, `GithubLink`, `VerificationRule`, `MembershipResult`, `RoleGrant`,
`AuditEvent`, and `SyncRun`.

Important data rules:

- Store Discord snowflakes and GitHub numeric IDs as strings; they exceed JavaScript's safe integer
  range.
- Scope tenant data and queries by `guild_id`; never hardcode guild IDs or cross guild boundaries.
- Use immutable numeric GitHub user IDs for authorization, never mutable login names.
- Keep one GitHub account linked to at most one Discord account.
- Treat `role_grants` as the idempotency/ownership ledger; do not remove roles the bot did not
  record as granted.
- Store timestamps as PostgreSQL `timestamptz` in UTC and preserve documented cascade/retention
  behavior.

Migrations live in [`prisma/migrations/`](prisma/migrations/). Prisma generates its client into
`src/generated/prisma`; `src/generated/` is ignored and must never be hand-edited or intentionally
committed. Change the schema or generator inputs, then run `pnpm db:generate`.

## Infrastructure and external services

The designed runtime integrates with:

- **Discord Gateway and REST** for interactions, commands, and roles.
- **GitHub OAuth and REST** for identity and membership checks.
- **PostgreSQL** for all durable state through Prisma.
- **Redis** for OAuth state, BullMQ jobs, rate budgets, and other ephemeral coordination.
- **GHCR** for planned container image distribution.

Configuration is environment-based; copy `.env.example` to `.env` and follow
[`docs/configuration.md`](docs/configuration.md). Never commit `.env` files or print tokens,
OAuth codes, client secrets, encryption keys, authorization headers, or decrypted credentials.

The repository currently has schema/migration infrastructure but no committed Dockerfile or Compose
file: `docker/` contains only `.gitkeep`. Likewise, the release workflow supports Changesets only
when `.changeset/config.json` exists, and that directory is not present yet. Treat container and
Changesets details in the docs/workflows as planned infrastructure until those assets land.

## Language, libraries, and tools

- **Runtime:** Node.js >=22, ESM, TypeScript with `NodeNext` modules and ES2023 output.
- **Package manager:** pnpm 10, pinned by the `packageManager` field and `pnpm-lock.yaml`. Use pnpm,
  not npm, yarn, or bun.
- **Discord:** discord.js 14.
- **HTTP and validation:** Fastify 5 and zod 4.
- **Database:** Prisma 7, PostgreSQL, `@prisma/adapter-pg`, and `pg`.
- **Jobs/state:** BullMQ 6, ioredis 6, and Redis.
- **GitHub:** Octokit 5 and a GitHub OAuth App.
- **Logging:** pino 10 with secret redaction.
- **Testing:** Vitest 4 in the Node environment.
- **Quality:** strict TypeScript, ESLint 10 flat config, typescript-eslint, and Prettier 3.
- **Automation:** GitHub Actions, Dependabot, CodeQL, and gitleaks.

Use [`package.json`](package.json) and the lockfile for installed versions. Use
[`docs/tech-stack.md`](docs/tech-stack.md) for design rationale and rejected alternatives.

## Repository map

| Path                | Purpose                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `src/index.ts`      | Runtime role selection and process lifecycle                      |
| `src/discord/`      | Implemented Discord gateway, dispatch, commands, and registration |
| `src/api/`          | HTTP/API role; currently placeholder-only                         |
| `src/sync/`         | Background worker role; currently placeholder-only                |
| `src/github/`       | Planned OAuth and GitHub API adapter                              |
| `src/verification/` | Planned pure verification engine                                  |
| `src/services/`     | Planned domain/service layer and database-write boundary          |
| `src/crypto/`       | Planned token-crypto boundary                                     |
| `src/lib/`          | Shared runtime and logging primitives                             |
| `prisma/`           | Database schema, configuration, and committed migrations          |
| `test/`             | Vitest behavioral tests (`test/**/*.test.ts`)                     |
| `docs/`             | Architecture, security, data, operations, and roadmap references  |
| `.github/`          | Executable CI/security workflows and issue/PR templates           |
| `docker/`           | Reserved for future container assets                              |

## Development workflow

Prerequisites are Node.js >=22 and pnpm 10. PostgreSQL and Redis are required as their dependent
features land; Docker is the documented local-service option, but Compose assets are not yet
committed.

Common commands:

| Command                | Purpose                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `pnpm install`         | Install the locked dependency graph                          |
| `pnpm check`           | Run lint, typecheck, and tests                               |
| `pnpm lint`            | Run ESLint                                                   |
| `pnpm format:check`    | Verify formatting without writing                            |
| `pnpm format`          | Rewrite files with Prettier                                  |
| `pnpm typecheck`       | Generate Prisma client and run `tsc --noEmit`                |
| `pnpm test`            | Generate Prisma client and run Vitest once                   |
| `pnpm build`           | Generate Prisma client and compile `src/` to `dist/`         |
| `pnpm start`           | Run the compiled `dist/index.js`                             |
| `pnpm deploy-commands` | Build and bulk-register global or development-guild commands |
| `pnpm db:generate`     | Regenerate the ignored Prisma client                         |
| `pnpm db:migrate`      | Create/apply a development migration                         |
| `pnpm db:deploy`       | Apply committed migrations in deployment                     |
| `pnpm db:studio`       | Open Prisma Studio                                           |

CI uses Node.js 24 and `pnpm install --frozen-lockfile`, then runs lint, formatting check,
typecheck, tests, and build. Before pushing, run the checks relevant to the change; for normal code
changes, match the full CI sequence rather than relying only on `pnpm check`.

## Coding and test conventions

- Use ESM imports and include `.js` extensions in relative TypeScript imports.
- Keep strict TypeScript guarantees; do not weaken compiler or lint rules to bypass an error.
- Prefer small typed boundaries and dependency injection for Discord, GitHub, database, clock, and
  queue interactions.
- Keep verification/domain logic pure and move side effects to adapters/services.
- Use structured pino logging and existing redaction paths. User-facing errors must be fixed,
  non-sensitive messages; log operational context without secrets.
- Register Discord command definitions and handlers through the shared registry so deployment and
  dispatch cannot drift.
- Name tests `*.test.ts` under `test/`. Assert observable behavior, lifecycle ordering, security
  boundaries, error outcomes, and invariants; use narrow local fakes at external-library
  boundaries.
- Do not commit generated Prisma clients, `dist/`, coverage, dependencies, logs, editor state, or
  local environment files.

## Security and privacy invariants

Security behavior is load-bearing. Consult [`docs/security-model.md`](docs/security-model.md) and
[`docs/oauth-flow.md`](docs/oauth-flow.md) before changing authentication, authorization, tokens,
roles, logging, or persistence.

- Request no privileged Discord gateway intents; the implemented client currently uses `Guilds`
  only.
- Keep member-facing identity/link/verification responses ephemeral.
- Request only GitHub read scopes. Private-repository scope escalation requires explicit consent;
  never request write scopes.
- OAuth state must be high-entropy, single-use, user-bound, TTL-limited, and consumed atomically;
  use PKCE S256.
- Encrypt GitHub access tokens with versioned AES-256-GCM keys before persistence. Plaintext may
  exist only briefly at the use boundary and never in logs, URLs, audits, or error responses.
- Admin operations require `ManageGuild`. Only allowlisted, unprotected roles below the bot may be
  managed.
- Reconcile role changes by diff. Transient GitHub failures keep last-known state; do not flap or
  revoke roles because an upstream service is unavailable.
- Linking is user-initiated, stored data is minimal, and unlinking must revoke/delete recoverable
  identity and credential data according to the documented retention policy.

Never open a public issue for a vulnerability. Follow [`SECURITY.md`](SECURITY.md) and use GitHub's
private vulnerability reporting channel.

## Contributions and pull requests

Follow [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md):

- Branch from `main` using `feat/...`, `fix/...`, `docs/...`, or `chore/...`.
- Use Conventional Commit and PR-title prefixes such as `feat:`, `fix:`, `docs:`, `chore:`,
  `test:`, `refactor:`, or `security:`.
- Keep one concern per PR and link the issue with `Closes #N` when applicable.
- Add or update tests for observable behavior and update user-facing documentation.
- Expect maintainer review for `docs/` and `.github/` changes according to `CODEOWNERS`.
- Follow the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Documentation index

Start with [`README.md`](README.md), then use the specialist document instead of duplicating or
guessing its policy:

| Document                                           | Use it for                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)     | Target components, topology, module boundaries, and flows            |
| [`docs/tech-stack.md`](docs/tech-stack.md)         | Technology choices and rationale                                     |
| [`docs/database.md`](docs/database.md)             | Canonical data model, indexes, cascades, deletion, and retention     |
| [`docs/oauth-flow.md`](docs/oauth-flow.md)         | OAuth/PKCE flow, state handling, scopes, and failure cases           |
| [`docs/security-model.md`](docs/security-model.md) | Threat model, role safety, secrets, permissions, and privacy         |
| [`docs/configuration.md`](docs/configuration.md)   | Environment variables and Discord/GitHub app setup                   |
| [`docs/roadmap.md`](docs/roadmap.md)               | Milestones and issue taxonomy; GitHub issues win on status conflicts |
| [`docs/ci-cd.md`](docs/ci-cd.md)                   | Intended CI, release, scanning, and branch-protection policy         |
| [`docs/glossary.md`](docs/glossary.md)             | Discord and GitHub terminology                                       |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)               | Setup, branches, commits, tests, and PR workflow                     |
| [`SECURITY.md`](SECURITY.md)                       | Private vulnerability reporting procedure                            |
