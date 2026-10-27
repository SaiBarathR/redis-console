# Live QA: v0.4 review rounds 3 and 4 fixes

Date: 2026-10-27. Tree: `release/v0.4` @ `145e889`. Instance: a local server on its own port and data directory with the
built SPA and the generic sandbox config. Databases: `sandbox-main` (Redis 8.10.2) and `sandbox-graph` (FalkorDB 6.0.3).
Browser: Playwright Chromium, headless. Accounts: `qa-viewer`, `qa-operator`, `qa-admin` (TOTP) from
`scripts/qa-accounts.mjs`.

Data under the prefix `qa:20261027:r4:`, deleted after each run: an array whose index 0 holds 1,000,000 `a` and index 1
`needle`; an array whose index 0 holds 8 MiB − 1 byte and index 1 `b`; a one-node graph.

| Check | Finding | Viewer | Operator | Admin |
|---|---|---|---|---|
| Search with a 1,024-byte glob `*a…ab` over the 1 MB value: "Not searched (larger than one search reads, 8.0 MiB, or too costly to match within one request): index 0", answered in 140–143 ms | r3 H1 | pass | pass | pass |
| Search for `b` from index 0 past the 8 MiB − 1 byte value: Continue reaches index 1, "1 match … The whole range was searched" | r3 M1 | pass | pass | pass |
| Guided → Import of one slow `GRAPH.RO_QUERY` line, cancelled while it runs: the job ends `cancelled`, "Cancelled while line 1 was running; it finished and is counted above" (not `done`, not "may have run") | r4 L1 | – (import needs operator) | pass | pass |
| No page errors or console errors; no CSP or Trusted Types violations | | pass | pass | pass |

The round-4 reviewer (Claude Sonnet 5.5) checked the round-3 graph fixes live as viewer, operator, admin and Keycloak
`operator1`; the round-4 data reviewer (GPT-6.1 Sol) recorded the round-3 data fixes as viewer, operator, admin and
Keycloak `viewer1` (costly and near-cap searches skipped as designed, the slow log redacted for non-admins).
Covered by tests: the slow-log redaction of cut entries (`unit/redaction.test.ts`), the Import retry cancel
(`unit/graph-engine-slots.test.ts`), a pool of one (`integration/graph.test.ts`) and the browser's byte counting
(`lib/policy.test.ts`).

## Cleanup

All seeded keys were deleted after each run; the instance was stopped by its PID and its data directory removed.
