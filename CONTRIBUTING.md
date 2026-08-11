# Contributing to MergeID

Thanks for your interest in contributing. MergeID is a privacy-first Discord
bot that links and verifies GitHub accounts with Discord accounts — GitHub
OAuth, org/repo/team verification, and automatic role sync.

> **Note:** MergeID is currently **pre-alpha** (design phase). Features and
> internal APIs are not stable. Check the [roadmap](docs/roadmap.md) and open
> an issue to discuss your idea before starting a large pull request.

## Local development in 5 minutes

```bash
git clone https://github.com/Ishannaik/mergeid.git
cd mergeid
pnpm install
pnpm check
```

On a clean clone with Node.js 22+ and pnpm 10, that last command runs lint,
format check, typecheck, and tests in sequence, and exits with 0.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [pnpm](https://pnpm.io/) 10
- [Docker](https://www.docker.com/) — for running PostgreSQL and Redis locally

## Setup

```bash
git clone https://github.com/Ishannaik/mergeid.git
cd mergeid
pnpm install
cp .env.example .env   # on Windows: copy .env.example .env — then fill in the values
```

### Scripts

| Command             | Description                                  |
| ------------------- | -------------------------------------------- |
| `pnpm build`        | Compile TypeScript to `dist/`                |
| `pnpm typecheck`    | Type-check without emitting files            |
| `pnpm check`        | Run lint, format check, typecheck, and tests |
| `pnpm lint`         | Run ESLint (warnings are errors)             |
| `pnpm lint:fix`     | Run ESLint and apply autofixes               |
| `pnpm format`       | Format the codebase                          |
| `pnpm format:check` | Check formatting without writing             |
| `pnpm test`         | Run the test suite                           |

Run `pnpm check` before pushing; `pnpm lint:fix` and `pnpm format` fix most of
what it reports.

## Branching

Use short-lived branches named by type, branched from `main`:

- `feat/...` — new features
- `fix/...` — bug fixes
- `docs/...` — documentation only
- `chore/...` — maintenance, tooling, dependencies

Keep the scope small and delete the branch after it is merged.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/). Your PR
title must follow the same convention:

- `feat:` — a new feature
- `fix:` — a bug fix
- `docs:` — documentation only
- `chore:` — maintenance and tooling
- `test:` — adding or updating tests
- `refactor:` — a code change that neither fixes a bug nor adds a feature
- `security:` — a security-related change

## Pull requests

Before opening a PR, make sure:

- [ ] Tests are added or updated for the change
- [ ] `pnpm check` passes (lint, format check, typecheck, tests)
- [ ] Documentation is updated if the change is user-facing
- [ ] The PR covers one concern — split larger changes into multiple PRs

Link the related issue with `Closes #N` in the PR description.

## Issues, milestones, and labels

- Search existing issues before opening a new one.
- Labels follow a `type:*` / `area:*` / `priority:*` scheme:
  - `type:*` — bug, feature, docs, and so on
  - `area:*` — the subsystem affected (bot commands, verification, role sync, ...)
  - `priority:*` — urgency, assigned by maintainers
- Looking for a first contribution? Filter by `good-first-issue`.
- Milestones group issues toward releases.

## Code of conduct

This project follows the
[Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating,
you agree to uphold it.

## Legal

A Developer Certificate of Origin (DCO) is not required, but all contributions
must be your own work. By submitting a pull request you agree to license your
contribution under the project's [MIT license](LICENSE).
