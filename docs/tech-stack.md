# Technology stack

> Every choice with justification and the alternatives considered. Versions verified against the
> npm registry and official docs on 2026-08-05; majors are pinned in `package.json` and Dependabot
> handles the rest.

## Runtime & language

| Choice                                | Why                                                                                                                                                                                                                                                                                             | Alternatives considered                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TypeScript (strict), 5.x/6.x line** | A bot with this much configuration surface (env, guild settings, rules) benefits from compile-time shape checking; first-class discord.js typings. TypeScript 7 (the native Go rewrite) exists but typescript-eslint doesn't support it yet — pinned to the latest supported line until it does | Python — viable, but the TS ecosystem around discord.js is deeper for interaction-heavy bots; plain JS — rejected, config/rule modeling gets sloppy |
| **Node.js ≥ 22 (CI on 24)**           | Node 24 is active LTS; 22 stays in maintenance until 2027-04. Native `fetch`, stable ESM, and the crypto APIs needed for token encryption                                                                                                                                                       | Node 20 — EOL April 2026, avoided; Bun/Deno — rejected for ecosystem conservatism in a security-sensitive project                                   |
| **pnpm**                              | Fast, disk-efficient, strict dependency isolation (no phantom deps)                                                                                                                                                                                                                             | npm — acceptable fallback; yarn — no compelling win                                                                                                 |

## Discord integration

| Choice                      | Why                                                                                                                                                                                            | Alternatives considered                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **discord.js v14 (14.27+)** | Mature, dominant library; typed slash-command builders; `ShardingManager` for later scale; huge community for edge cases. v15 is still prerelease-only as of 2026-08 — revisit at M6 hardening | discord-api-types + raw REST — more control, far more work; other wrappers — smaller communities, risk of abandonment |

## HTTP & validation

| Choice        | Why                                                                                           | Alternatives considered                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fastify 5** | Tiny surface (one route + health), fast, schema hooks pair well with zod                      | Express — fine but untyped by default; Hono — good, but Node deployment story slightly less boring; raw `node:http` — rejected, no middleware ergonomics |
| **zod**       | One library validating env, DB-ish payloads, and HTTP params; schemas double as documentation | yup — weaker inference; io-ts — steeper learning curve for contributors                                                                                  |

## Data

| Choice         | Why                                                                                                                                                                                                                                                                        | Alternatives considered                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **PostgreSQL** | Relational integrity for links/rules/grants, JSONB for guild settings, works for 1 server or 10,000                                                                                                                                                                        | SQLite — single-writer constraint kills horizontal scale; Mongo — relations are the core of this domain                              |
| **Prisma 7**   | Typed client from one schema file; migrations as reviewed code; familiar to contributors. Prisma 7 specifics we design around: mandatory driver adapter (`@prisma/adapter-pg`), `prisma-client` generator with explicit output, `prisma.config.ts`, no auto `.env` loading | Drizzle — excellent and lighter; may revisit, Prisma chosen for contributor familiarity; Kysely — more SQL control, more boilerplate |
| **Redis**      | TTL-native storage for OAuth state, atomic counters for rate budgets, BullMQ backend                                                                                                                                                                                       | Postgres-only state — possible for MVP, but TTL semantics and queue throughput argue for Redis                                       |
| **BullMQ 6**   | Durable, retry-aware job queue with repeatable jobs (periodic sync) on top of Redis; active maintenance. v6 notes: `QueueScheduler` is gone (stalled-job handling lives in the `Worker`), `add`/`addBulk` signatures changed                                               | node-cron — no durability/retries; custom queue — rejected, this is solved infrastructure                                            |

## GitHub integration

| Choice                             | Why                                                                                                                                                                                | Alternatives considered                                                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Octokit (@octokit/rest v22)**    | Official SDK; typed endpoints; pagination + rate-limit metadata handled                                                                                                            | Raw fetch — loses typed pagination/rate-limit helpers for little gain                                                                                                             |
| **GitHub OAuth App + PKCE (S256)** | User tokens with `read:org` cover all v1 checks; zero installation UX; PKCE is now "strongly recommended" by GitHub and is part of our flow (see [`oauth-flow.md`](oauth-flow.md)) | GitHub App — better long-term (installation-level limits, fine-grained perms, expiring tokens) but heavier setup; revisit at scale (see [`architecture.md`](architecture.md) §10) |

## Observability & ops

| Choice                      | Why                                                                                  | Alternatives considered                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **pino**                    | Fast structured JSON logs; redaction paths are a security feature here               | winston — slower, less ergonomic; console — rejected                                                 |
| **Docker + docker-compose** | One-command self-hosting (bot + Postgres + Redis); same image for hosted deployments | Bare node — fine for devs, bad for self-hosters; Kubernetes — overkill to require, easy to add later |
| **GHCR**                    | Images live next to the code, free for public repos                                  | Docker Hub — another account/surface; self-registry — burden on self-hosters                         |

## Quality & delivery

| Choice                                          | Why                                                                                                                       | Alternatives considered                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **ESLint 10 (flat config) + typescript-eslint** | ESLint 9 EOLs 2026-08-06; v10 is flat-config-only, which matches our scaffold; typescript-eslint catches real bug classes | Biome — fast and promising; ESLint chosen for ecosystem familiarity (revisit if config pain appears) |
| **Prettier**                                    | Zero-debate formatting in PRs                                                                                             | Built into ESLint — rejected, formatter/linter separation is cleaner                                 |
| **Vitest 4**                                    | TS-native, fast, first-class mocking for the GitHub adapter                                                               | Jest — heavier setup for ESM                                                                         |
| **GitHub Actions**                              | Lives in the repo, free for public projects, all integrations used here                                                   | CircleCI etc. — no win over GHA for this repo                                                        |
| **changesets**                                  | Explicit, reviewable versioning; git-tag releases without npm publishing                                                  | semantic-release — fully automated but noisier for a young repo; manual tags — error-prone           |
| **Dependabot + CodeQL + gitleaks**              | Free, native, covers deps, code, and secrets respectively                                                                 | Renovate — nicer grouping, extra service; Snyk — vendor lock-in for marginal gain at this size       |

## Version support policy

- **Node:** 24.x (active LTS) in CI; 22.x (maintenance LTS until 2027-04) supported via
  `engines: ">=22"`.
- **discord.js:** pinned to v14 major; v15 evaluated during M6 hardening if it has shipped stable.
- **TypeScript:** latest line supported by typescript-eslint (currently 5.x/6.x); TS 7 adoption
  tracked separately.
- **Breaking upstream changes:** handled through Dependabot PRs + CI; major bumps get a dedicated
  issue per milestone planning.
