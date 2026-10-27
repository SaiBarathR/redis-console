# v0.4 S4 graph results: policy, sandbox and live QA

Date: 2026-10-27. Branch: `feat/v04-workbench-geo-graph`. Graph half only; the committed geo implementation was
preserved. All graph fixtures used `graph:20261027:` on the disposable `sandbox-graph` database and were removed.
No external dataset was used for graph QA.

## Implementation and security verdicts

| Area | Decision and evidence |
|---|---|
| Engine | Pinned `falkordb/falkordb:6.0.3`, Redis 8.10.2, graph key TYPE `graphdata`. The image launcher ignores its command; compose bypasses it, runs Redis as uid 999, and uses the generated ACL/config files. Read-only rootfs, ephemeral data/tmp, loopback-only port. |
| Execution bounds | Engine config GET verified TIMEOUT_DEFAULT 1000, TIMEOUT_MAX 1000, RESULTSET_SIZE 10000, MAX_QUEUED_QUERIES 25. The legacy TIMEOUT option cannot coexist with DEFAULT/MAX and leaves write queries unbounded. Application argv always includes a positive timeout <=1000 ms; malformed/duplicate options are refused. |
| Timed writes | Integration ran expensive read, QUERY write and PROFILE write queries with TIMEOUT 1. Each returned a Redis timeout error within 3 seconds, and the next command worked. No rollback guarantee is claimed; ambiguous writes are not retried. |
| Result limits | Direct sandbox query for 10,005 rows returned exactly 10,000. An app instance with a 2 KiB measured reply cap returned 413 for graph entities and then successfully read a small query. Ordinary app display caps still apply. |
| Roles and tiers | Viewer RO_QUERY/EXPLAIN/LIST/INFO ObjectPool/MEMORY reads succeed. Each effective role uses `rc-<role>` (CLIENT INFO verified). Viewer writes, readOnly writes and maxRole=viewer writes fail before confirmation. EXPLAIN on an absent key does not create it. |
| Mutations | Every QUERY/PROFILE requires operator and confirmation, even RETURN-only queries. Destructive Cypher changes nothing before confirmation; swapping its token to another argv is refused. Prod adds typed database name/reason. GRAPH.DELETE requires admin and typed confirmation. |
| Host I/O | Default file CSV probe reached the import-folder loader; plain HTTP was refused, and HTTPS loopback was refused by FalkorDB's own address guard. With a temporary sandbox import directory, LOAD CSV successfully read a canary file. The file/key were deleted and the generated config restored. Application guards refuse LOAD on all four query/plan commands before dispatch, including comments between keywords and binary argv. No public network request was needed for this probe. |
| User code and procedures | GRAPH.UDF and namespaced/quoted function calls are refused, including calls to code preloaded by another client. A harmless prefixed UDF was loaded/executed directly for the quoted-identifier regression below, then deleted. Only no-argument db.labels(), db.relationshipTypes(), db.propertyKeys() are enabled; all three succeeded as viewer. Other CALLs are refused. |
| Module administration | CONFIG SET, SLOWLOG RESET, binary BULK/RESTORE, COPY/CONSTRAINT management and internal DEBUG/EFFECT/RECORD are refused. Admin alone reads CONFIG GET/SLOWLOG. Redis ACL independently refused UDF, binary bulk, CONFIG SET, viewer QUERY and non-admin DELETE. First-argument ACLs restrict INFO to ObjectPool, MEMORY to USAGE and CONFIG to GET; the pinned Redis warns these first-argument grants are deprecated. |
| Cross-user disclosure | Bare INFO and running/waiting query sections are refused because they contain query text. SLOWLOG is admin-only. Denied requests are audited; Cypher/UDF source and graph key names do not appear in audit output. |
| Sampling | GRAPH.MEMORY accepts only USAGE, with SAMPLES <=100; zero/all becomes 100. Unit coverage includes invalid, omitted and oversized samples. |
| Renderer | Verbose header/rows/statistics, stats-only writes, scalars, nested entities, large decimal IDs, duplicate columns and incomplete replies are covered. Diagram caps: 200 unique nodes, 400 edges, remaining received entities counted. Edge-only replies have dashed endpoint placeholders. Table: 1000 rows/40 columns. Plan: 1000 lines/40 levels. Compact/unknown shapes use the generic reply. |

The conservative lexer is a feature guard, not a general Cypher parser or a write classifier. Its deliberate
restrictions and false positives are documented in [D21](../DECISIONS.md#d21-falkordb-queries-are-bounded-and-cannot-run-host-io-or-user-code).

## Implementation commits

- `6a34eaf`: pinned graph sandbox, isolated config/ACL generation and CI readiness.
- `a4b251a`: e2e harness retains the dedicated FalkorDB target.
- `778cefd`: command policy, Cypher guard, confirmations, time/sample bounds and integration tests.
- `c86ff1a`: bounded graph/plan renderer, key-browser hint and component tests.
- `2c834f3`: Workbench role e2e specs and six-account built-SPA Chromium tour.
- `aaff10d`, `c2f0b0d`: database discovery/landing assertions include the graph sandbox.
- `c6fc8f0`: accurate warnings for server-omitted graph rows, with reproduced regression coverage.
- `af70066`: Cypher backtick escaping matches FalkorDB; a preloaded-UDF bypass fails before the fix and is refused after it.

## Automated gates

| Gate | Result |
|---|---|
| `pnpm -r typecheck` | All four workspace packages passed. |
| `pnpm --filter @rconsole/shared test` | 51 passed, 0 failed. |
| `pnpm --filter @rconsole/web test` | 495 passed, 0 failed. |
| `pnpm --filter @rconsole/server test` | 971 passed, 44 skipped, 0 failed. Includes all 16 live FalkorDB integration tests and 3 graph policy unit tests. |
| `pnpm test:e2e` | Pending final run under the machine-wide lock. |
| Built-SPA graph tour | 6 passed, 0 failed; Chromium, local and OIDC roles, 20.3 seconds. |

The 44 server skips are 36 topology tests (no Cluster/Sentinel/mTLS topology started for this standalone graph
stream) and 8 optional external-remote tests (no external upstream configured). These are unqualified, not passes.
CI bootstrap was edited and its individual graph generation/startup/readiness steps were exercised; the full
`scripts/dev-setup.sh` was deliberately not run on a shared sandbox, and no hosted CI run is claimed.

A partial-row display-count regression was also reproduced: the component test fails with the previous calculation
(which treated server-omitted rows as a 1000-row renderer cut), and passes with the separate server-omission warning.

## Quoted-identifier UDF regression

During the final security check, a backslash/comment combination in a backtick-quoted library name reproduced a
guard bypass: a valid GRAPH.RO_QUERY calling a harmless preloaded UDF returned HTTP 200 with the canary integer 7.
The guard had treated the backslash as escaping the closing backtick, while FalkorDB treats it as a literal in a
quoted identifier. A trailing comment made the guard's mistaken quote span appear balanced.

The integration test `blocks preloaded UDF calls with backtick/backslash/comment quoting (live lexer regression)`
creates its library under the run's `graph:20261027:` prefix, proves that the exact query executes in FalkorDB,
and requires application refusal for all four query/plan commands as every role. It **failed before the fix**
(200 instead of 403) and passes after matching Cypher's identifier quoting: only doubled backticks escape a
backtick; backslashes remain literal. The API now returns 403 command_blocked before confirmation/dispatch.
The library is removed in finally. Shared unit coverage preserves the exact token sequence too.

This is a regression in the new, unreleased graph implementation; the geo implementation is unaffected.

## Live Chromium QA

Built SPA served by the stream's own instance on port 4300, disposable app data, and the generic dev config.
`scripts/qa-accounts.mjs` provisioned local QA accounts on that instance. The repeatable tour is
`apps/web/qa/graph-live.browser.spec.ts` with `graph-live.config.ts` (WEB_QA_ORIGIN may override the origin).

| Identity | Graph read/diagram/table/plan | Keyboard node properties | Key-browser hint | Write boundary | CSV/UDF/config refusal |
|---|---|---|---|---|---|
| qa-viewer | passed | passed | passed | disabled before send | passed |
| qa-operator | passed | passed | passed | QUERY/PROFILE confirmed | passed |
| qa-admin | passed | passed | passed | QUERY/PROFILE confirmed | passed |
| viewer1 (Keycloak) | passed | passed | passed | disabled before send | passed |
| operator1 (Keycloak) | passed | passed | passed | QUERY/PROFILE confirmed | passed |
| admin1 (Keycloak) | passed | passed | passed | QUERY/PROFILE confirmed | passed |

Each role inspected 300 nodes and 299 edges: a node query drew 200 nodes and counted 100 omitted; an edge-only
query returned 250 edges, drew 199 between 200 endpoint placeholders and counted omitted entities. All roles saw
statistics, escaped hostile property text, and an EXPLAIN tree. Operators/admins executed confirmed QUERY and
mutating PROFILE from the Workbench. No graph rendering request left the application origin. Authentication used
the configured Keycloak issuer. Every tour recorded **0 CSP/Trusted Types violations and 0 page errors**.

Initial tour failures were test assumptions: the browser disables known forbidden scripts before sending, and
returning to the Workbench resets the reply mode to terminal. The tour was corrected to assert disabled controls
and explicitly choose Tree; it then passed twice. These were investigated harness failures, not silently retried
product flakes. The first full e2e run completed with 643 passes and two failures: the pre-graph three-database discovery
and landing-row expectations. Both were updated for the fourth target; discovery also asserts its connection/module. Early integration-test failures similarly came from reusing rate-limited accounts and reusing a
confirmation token after a mismatched request consumed it; fresh sessions/challenges corrected those assumptions.

## Cleanup and scope

Graph fixtures and the temporary CSV canary were deleted. All temporary canary UDF libraries were deleted. The full setup script was
never run; existing generated sandbox files and shared containers were not changed. Only the new graph service
was created/restarted. The graph sandbox is intentionally left running for e2e/CI use. The QA app was stopped and its disposable app data/local QA credential file removed. Processes
started by the e2e harness are stopped at completion; disposable e2e containers are removed by its teardown.

Standalone FalkorDB and desktop Chromium are qualified here. Graph behavior on Cluster/Sentinel/failover, mobile,
and assistive technology beyond keyboard access is unqualified. No push was performed.
