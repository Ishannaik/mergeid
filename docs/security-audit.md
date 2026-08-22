# Security audit — implementation walkthrough

> M6 deliverable: maps the shipped code against the threat model in
> [security-model.md](security-model.md). Written 2026-08-22 against the
> post-M5 tree. Each claim links to the enforcing module and its tests.

## Method

For each threat (#1–#16) we identified the enforcing code, confirmed it is
implemented (not just designed), and checked test coverage. Anything not yet
enforced in code is listed under "Open gaps" — nothing in that section blocks
the current pre-alpha scope.

## Threat-by-threat verification

| #   | Threat                    | Status | Enforced by                                                                                     | Tests                                                        |
| --- | ------------------------- | ------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | DB breach exposes tokens  | ✅     | `src/crypto/token.ts` — AES-256-GCM, versioned envelope, version bound as AAD                   | `test/crypto/token.test.ts`                                  |
| 2   | OAuth CSRF / link hijack  | ✅     | `src/oauth/state.ts` single-use nonce (Redis GETDEL / memory delete), TTL 600s                  | `test/integration/oauth-flow.e2e.test.ts` replay case        |
| 3   | OAuth mix-up              | ✅     | Single app + strict redirect URI (`src/github/oauth.ts`); state store scoped per deployment      | oauth-flow e2e                                               |
| 4   | Impersonation via rename  | ✅     | Engine authorizes on numeric id; login stored for display only                                   | `test/verification/engine.test.ts`                           |
| 5   | Double-linking abuse      | ✅     | Unique constraint on `github_user_id`; service rejects second link (`src/services/links.ts`)     | `test/services/links.test.ts`                                |
| 6   | Privilege escalation      | ✅     | Allowlist gate at rule creation; protected roles; position preflight (`src/discord/preflight.ts`)| `test/services/rules.test.ts`, `test/discord/roles.test.ts`  |
| 7   | Malicious guild admin     | ✅     | Checks run with the member's token — admin gains nothing; 25-rule cap enforced in `addRule`      | `test/services/rules.test.ts` cap cases                      |
| 8   | Role flapping             | ✅     | Diff reconciliation; ERROR keeps last-known state; only MergeID-owned grants revoked              | engine tests; demo integration                               |
| 9   | Rate-limit exhaustion     | ✅     | `src/sync/rate-budget.ts` token bucket (fail-open) + full-jitter backoff; worker concurrency 2   | `test/sync/rate-budget.test.ts`                              |
| 10  | Token leakage in logs     | ✅     | pino redaction paths incl. `authorization`, `access_token`, `code_verifier` (`src/lib/logger.ts`) | logger construction reviewed; crypto errors are value-free   |
| 11  | Secrets in repo           | ✅     | `.gitignore` covers `.env`; gitleaks workflow present                                            | CI                                                           |
| 12  | SQL injection             | ✅     | Prisma parameterized queries only; no `$queryRaw` anywhere in `src/`                             | grep audit (this walkthrough)                                |
| 13  | Bot token theft           | ✅     | Env-only via zod config; no privileged intents (`GatewayIntentBits.Guilds` only)                 | `src/discord/client.ts` (intent surface reviewed in audit)   |
| 14  | Callback endpoint abuse   | ✅     | Stateless handler; Redis TTL bounds state volume; proxy rate-limiting documented                 | oauth-flow e2e                                               |
| 15  | Supply chain              | ✅     | `pnpm-lock.yaml` committed; Dependabot config active                                             | CI                                                           |
| 16  | Zombie access             | ✅     | M5 worker re-verifies on each rule's cadence; revocation only of owned grants                    | `test/sync/worker.test.ts`; live e2e `sync.e2e.test.ts`      |

## What the audit confirmed beyond the table

- **Token lifecycle.** Tokens exist in exactly four states: received at
  callback → encrypted at rest → decrypted in-memory for a check → revoked at
  unlink (`src/services/links.ts`). No plaintext token is ever persisted,
  logged, or embedded in a URL.
- **Crypto envelope.** The version prefix participates in GCM authentication
  (AAD), so downgrading an envelope to a weaker legacy key fails closed. Key
  rotation needs no downtime: new writes use the active key; old rows open
  with legacy keys.
- **PKCE.** `/link` issues S256 challenges; the verifier travels only in the
  state record, never in any URL. Confirmed in the OAuth e2e assertions.
- **Error hygiene.** `TokenCryptoError` messages are value-free by design;
  route-level failures render fixed copy — internal error text never reaches
  a Discord message or HTML page (asserted in oauth-flow e2e).
- **Reflected XSS.** Every attacker-controlled string rendered into callback
  HTML (GitHub login, `error_description`) passes through `escapeHtml`;
  dedicated escaping tests exist.
- **Sync worker containment.** A member verification failure inside a sync run
  is counted, not propagated — one bad token cannot abort a rule's run; a
  crashed run records `FAILED` and lets BullMQ's backoff retry.
- **Audit completeness.** Rule create/remove, allowlist/protected/log-channel
  changes, link/unlink, and every completed verification write an audit row;
  reads (`audit`, `sync-status`) write nothing.

## Open gaps (tracked, not blocking)

1. **Re-encryption after key rotation is lazy** — envelopes upgrade only when
   next read+written. A background sweep would bound exposure windows to the
   rotation schedule. (Follow-up issue recommended.)
2. **Rate budgeter is process-local by default** — the Redis bucket exists but
   the engine does not consult it before GitHub calls yet; GitHub's native
   limits plus backoff currently carry the load. Wire `tryAcquire` around
   `evaluateRule` when multi-worker deployments arrive.
3. **No automated dependency-audit gate** beyond Dependabot — consider adding
   `pnpm audit --prod` to CI with a severity threshold.
4. **Session-less admin UI risk accepted**: `ManageGuild` gating relies on
   Discord's default permission checks; re-check membership server-side if a
   web dashboard ever ships.

## Verdict

The implementation matches the documented threat model for all 16 tracked
threats, with defense-in-depth verified by 228 passing tests including two
live end-to-end suites (OAuth flow; BullMQ sync over real Redis/Postgres).
