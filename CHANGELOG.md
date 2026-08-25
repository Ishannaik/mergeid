# mergeid

## 1.0.0

### Major Changes

- Mark the 1.0 release: security audit, OAuth e2e coverage, self-hosting guide, GHCR image publishing with latest tag, and README updated from pre-alpha to v1.0.

## 0.1.0

### Minor Changes

- [`dbd3829`](https://github.com/Ishannaik/mergeid/commit/dbd38298047fd4ecee4926f8b32194ff92df7f42) - First implementation release: OAuth account linking (`/link`, `/unlink`, `/status`),
  verification engine with org/repo/team rules, role reconciliation with allowlist and
  protected-role safety rails, `/mergeid` admin configuration (rules, settings, audit,
  sync-status), periodic sync worker (BullMQ) with rate budgeting and backoff.
