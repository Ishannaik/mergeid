---
'mergeid': minor
---

First implementation release: OAuth account linking (`/link`, `/unlink`, `/status`),
verification engine with org/repo/team rules, role reconciliation with allowlist and
protected-role safety rails, `/mergeid` admin configuration (rules, settings, audit,
sync-status), periodic sync worker (BullMQ) with rate budgeting and backoff.
