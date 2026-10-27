# Live QA: v0.4 review round 2 fixes

Date: 2026-10-27. Tree: `release/v0.4` @ `ec8d2e6` (both round-2 reports fixed). Instance: a local server on its own
port and data directory with the built SPA and the generic sandbox config. Databases: `sandbox-main` (Redis 8.10.2)
and `sandbox-graph` (FalkorDB 6.0.3, recreated from the hardened template: `QUERY_MEM_CAPACITY`, a missing
`IMPORT_FOLDER`, a 1 GiB container limit). Browser: Playwright Chromium, headless. Accounts: `qa-viewer`,
`qa-operator`, `qa-admin` (TOTP) from `scripts/qa-accounts.mjs`.

## Data

Under the prefix `qa:20261027:r2:`, deleted after each run: an array of 5,000 values of 4 KiB plus one value of 9 MiB
at index 5000; a vector set with the empty member name, `a`, and `big` with 600 KB of attributes; a slow `SADD` whose
first member is a canary string (it lands in the slow log); a 20-node graph.

## Results (viewer 12/12, operator 13/13, admin 13/13)

| Check | Finding | Viewer | Operator | Admin |
|---|---|---|---|---|
| Array search: one request reads at most 16 MiB ("0 matches in indices 0–4075 (4,076 elements searched)"), Continue offered | data H2 | pass | pass | pass |
| Continuing reaches the 9 MiB value: "Not searched (each value is larger than one search reads, 8.0 MiB): index 5000" | data H2 | pass | pass | pass |
| Console `ARGREP …`: blocked, hint points to the inspector's search, Run disabled | data H1 | pass | pass | pass |
| Find similar on the empty member name: "(the empty name)", Search enabled, results returned | data L1 | pass | pass | pass |
| Invalid filter `.x == "…CANARY" &&&&`: "Invalid filter expression: Redis could not read it from character 1 on." (no canary) | data M1 | pass | pass | pass |
| Member `big` (600 KB attributes): the panel opens, says the attributes are too large, shows "2 of 2 values" | data M2 | pass | pass | pass |
| Console `SLOWLOG GET 128`: the canary is hidden from viewer and operator, shown to admin; through the API the viewer's entry reads `SADD qa:…:slow <17 bytes> …` | graph M2 | pass | pass | pass |
| Viewer `GRAPH.QUERY …`: "requires the operator role on this database (you have viewer)" | e2e regression | pass | – | – |
| `GRAPH.QUERY … WHERE n.age > 30 AND n.country = 'DE' DETACH DELETE n`: the confirmation shows the whole Cypher; cancelling changes nothing (20 nodes) | graph M1 | – | pass | pass |
| Workbench `GRAPH.RO_QUERY`, Graph view: exactly one node is a tab stop | graph L5 | pass | pass | pass |
| No page errors or console errors (other than expected 4xx responses); no CSP or Trusted Types violations | | pass | pass | pass |
| No Redis data in request URLs | | pass | pass | pass |

Two first-run failures were script errors, investigated and corrected: the Workbench opens with a starter draft, so the
graph line was appended to it (the policy line read "DBSIZEGRAPH.RO_QUERY … unavailable"); and the result opens in
Reply mode, so the Graph view had to be chosen. Account setup first failed because a stale accounts file from an
earlier instance was reused; the instance was restarted on a fresh data directory.

Covered by tests rather than this flow: the guard's lone-CR refusal and the differential probe (`graph.test.ts`), the
graph slot hold (a unit test and a live check: 504 at 7.0 s, an immediate retry 429, the slot freed at 13.6 s), admin
reads on a read-only database (no read-only graph database in the dev config; `lib/policy.test.ts`), and the graph key
size and edge list (live-checked by the L4/L5 fixer, `docs/REVIEW-LOG.md`). Keycloak sign-in was exercised by both
round-2 reviewers.

## Cleanup

All seeded keys were deleted after each run; the instance was stopped by its PID and its data directory removed.
