# Redis Console v0.2 — independent backend review, round 2

Reviewed 2026-10-23 at **d44574749b82bb42556b3826ccd789d94420450a**, including all fixes in `8a11704..d445747`.

**Result: 1 High, 5 Medium, 1 Low confirmed findings.** No new privilege escalation or Redis-credential disclosure was reproduced. Important round-1 mechanisms now work, but JSON/search allocation limits and the broader audit/logging requirements are not complete. The new grammar also refuses one verified legitimate option. This is not a security sign-off.

Review was read-only in the requested detached worktree. Read the five specification documents, round-1 report, review log, fix diff and scoped backend/shared/config/deployment/scripts. Ran `pnpm install`, sourced the linked `.env`, started the real server at **http://localhost:4500**, with **/tmp/rc-review-s2** storage, and provisioned the requested QA accounts. Used an absolute `RCONSOLE_CONFIG` because `pnpm --filter` starts in the server package directory. Independent HTTP checks used these accounts; additional small app/RESP fixtures and existing tests exercised races and timeouts. No source changes or commits.

All new findings below were reproduced against this running instance. Evidence scripts/results are in **/tmp/rc-review-s2-tests/**; they import the removed review checkout, so recreate this snapshot before rerunning. Their fixtures use only synthetic `rc-review-s2:*` keys on 6411; direct comparison reads also used 6412. Remote 6390 was accessed only through the app, with expected write refusals. Never connected to 6380, ran dev setup or snapshot refresh, touched port 4000, or used the owner's data directory. No E2E suite was run.

## Round-1 fix verification

“Confirmed” means the reported fix held within the stated evidence. “Not confirmed complete” distinguishes a remaining gap from a failure to reproduce the original case.

| Round-1 ID | Verification | Evidence and legitimate use |
|---|---|---|
| H1 — JSON amplification | **Not confirmed complete** | Original huge `INDENT` and 100,001-match `JSON.TYPE` now give **413**. Definite, recursive and sliced selections on ordinary documents give **200**. An 18 MiB document's `$.id` returns exactly `[1]`. However, ordinary JSON escaping still defeats byte sizing: **R2-H1**. `probes.mjs`, `probe-results.json`; existing JSON regression tests passed. |
| M1 — search option interpretation | **Not confirmed complete** | Query/parameter `NOCONTENT` no longer lifts the 1,000-content-row cap (**413**); query text `LIMIT` works (**200**). `RETURN ... AS`, SUMMARIZE/HIGHLIGHT arguments containing option-looking text, and SORTBY work in additional live comparisons. But the new grammar rejects valid `FORMAT STRING`: **R2-L1**. `probes.mjs`, `search-grammar-extra.mjs` and their results. |
| M2 — search endpoint budgets | **Not confirmed complete** | Original 20 × 20 × 4 KiB page now has bounded field payload: **1,051,267 HTTP bytes**, 20 IDs preserved, eight documents explicitly truncated; the small extra is response structure. A document over the raw-read budget is returned with empty fields and `truncated:true`. But IDs are outside both budgets: **R2-M2**. `probes.mjs`, `search-ids.mjs` and their results. |
| M3 — timeout collateral/recovery | **Confirmed, standalone** | Independent running app + local RESP fixture: A's unanswered command **504**; B's command, still in flight when A times out but within B's own deadline, **200**; subsequent request **200**; metrics received four INFO calls and **zero error events**. Real-Redis regression also passed, including ACL identity after replacement. Code holds the acquired client until replacement and metrics reacquires the manager connection each tick. Collateral disconnect errors now map to 503. Cluster/sentinel live behavior is **unconfirmed** here: 16 topology tests skipped. `timeout-collateral.mjs`, `timeout-results.json`, `server-tests.log`. |
| M4 — production credential check | **Confirmed** | Real production entrypoint: mixed viewer/default credentials and duplicate reachable usernames each exit **78**; distinct per-tier users start; explicit risk acceptance starts. A missing tier without default is intentionally allowed at config time and remains fail-closed by the manager. Reachability is checked under `maxRole`, so unused tiers need not exist. `prod-config.mjs`, `prod-config-results.json`, individual entrypoint logs; config tests passed. No production Redis TLS handshake is claimed. |
| M5 — admin re-check | **Confirmed** | Live create vs disable: disable **200**, in-flight administrator creation **401**, no account persisted; the QA actor was then re-enabled. All four app-level admin-race tests passed, covering PATCH revocation, concurrent target password changes and successful normal create/update. The synchronous post-hash check/write sequence avoids partial PATCH application and rechecks target generation. `verification.mjs`, `verification-results.json`, `server-tests.log`. |
| M6 — read auditing | **Not confirmed complete for the audit specification** | Every tested newly covered key/scan/stream/time-series/search read produces exactly one event, including 404 and Redis-error outcomes; keys are hashed and synthetic value/pattern canaries are absent. But the stated exclusion of slowlog as metadata leaves a data-bearing read unaudited (**R2-M4**), and ordinary error logging bypasses query redaction (**R2-M5**). `verification.mjs`, `slowlog-audit.mjs`, `error-logging.mjs` and results. The original key-browser omission itself is fixed. |
| L1 — safe small projections/scalar | **Not confirmed complete; documented partial fix verified** | `SUNIONCARD` returns integer **3**, and `JSON.GET huge $.id` returns **[1]**. HKEYS on one short field plus an 18 MiB value still gives **413**. The stated conservative reason is reasonable: no bounded name-only sizing primitive was demonstrated, and sampling names is not itself safely bounded. Do not reopen this as an unexpected regression; document the restriction and retain the key-browser alternative. `probes.mjs`, `probe-results.json`. |

## New findings by severity

### High — R2-H1. JSON serialized bytes still exceed the new preflight estimate

**Locations:** `apps/server/src/policy/replyGuard.ts:581`, `:583`, `:598`; the same representation assumption appears in JSON.MGET at `:555`. Send-before-browser-cap order: `apps/server/src/routes/cli.ts:87`.

**Reproduction:** `probes.mjs` / `probe-results.json`.

1. On sandbox-e2e, create a JSON object whose `data` is `"\u0001".repeat(3 * 1024 * 1024)` using JSON.SET.
2. Its `MEMORY USAGE` is **3,145,864 bytes**. Direct JSON.GET is **18,874,379 bytes** because each control byte serializes as six ASCII bytes.
3. As qa-viewer, POST `/api/v1/databases/sandbox-e2e/cli` with `argv: ['JSON.GET', key]`.
4. The app returns **200**, reply type `truncated`, after buffering that reply. The configured preflight limit is **16,777,216 bytes**.

**Observed vs expected:** the new path/format analysis treats stored/selected memory as a serialized-byte ceiling. JSON escaping alone invalidates that ceiling, without padding or complicated paths. Expected: refuse before reading a representation beyond the raw-read budget. The original H1 examples are fixed, but this is another confirmed instance of its underlying representation-sizing problem.

**Impact:** viewers can trigger larger allocations than the advertised guard permits; concurrent reads affect the shared server. The browser's tiny truncation marker comes too late. This test stopped at about 18 MiB and did not attempt a crash. JSON.MGET shares the unsafe assumption in source; a separate live JSON.MGET expansion test is **unconfirmed**.

**Minimal fix:** apply a conservative worst-case JSON serialization bound to selected string/key bytes, including escaping and structural overhead, then the existing path/format expansion factors. Keep scalar/small projections usable. Add regression coverage with control characters and escaped object names; retain the final reply cap.

### Medium — R2-M1. CLI search caps rows, but never sizes document bytes

**Locations:** `apps/server/src/policy/replyGuard.ts:184`, `:268`; `apps/server/src/routes/cli.ts:87`.

**Reproduction:** `probes.mjs` / `probe-results.json`.

1. Create a temporary HASH search index on sandbox-e2e. Add one hash with indexed `text=oversize` and an **18 MiB payload**.
2. Viewer CLI `FT.SEARCH index oversize LIMIT 0 1` returns **200**.
3. Direct response measurement is **18,874,551 serialized bytes**, above the **16 MiB** preflight budget. The app's eventual capped response is only 702 bytes. The dedicated `/search/query` route correctly omits that document's fields in the same experiment.

**Observed vs expected:** `searchGrammarRows` emits `checks: []`; passing the row count passes preflight regardless of document size. Expected: a content-bearing search must satisfy byte sizing before execution as well as row sizing. This is distinct from M1's repaired keyword parsing and M2's separate feature route.

**Impact:** one matching wide cache document bypasses the guard for a viewer; 1,000 rows are not a meaningful allocation ceiling. Workbench uses the same execution/preflight path. Its live variant is **unconfirmed** separately.

**Minimal fix:** share a byte-aware search planner across CLI and the typed route: safely discover candidate IDs, size/restrict the selected document content and enforce a total budget, or refuse content-bearing forms that cannot be sized. Cover FT.SEARCH and the related aggregate/profile forms individually; merely applying `toReply` afterwards is insufficient.

### Medium — R2-M2. The new search planner reads and returns unbudgeted document IDs

**Locations:** `apps/server/src/routes/modules.ts:81`, `:102`, `:118`.

**Reproduction:** `search-ids.mjs` / `search-id-results.json`.

1. On sandbox-e2e, create one indexed hash with a key consisting of `rc-review-s2:ids:` plus **18 MiB** of `k`, and a tiny `text=single` field.
2. Viewer POST `/api/v1/databases/sandbox-e2e/search/query` with `{index, query:'single', limit:1}`.
3. Observe **200**, **18,874,444 response bytes**, containing an ID of **18,874,385 bytes**, `fields:{}`, `truncated:true`.

**Observed vs expected:** NOCONTENT returns complete IDs before the first size probe. The planner then correctly omits the content, but copies the complete ID into the response outside `left`. Thus both the **16 MiB raw-read** and **1 MiB response-payload** budgets are defeated by one ID. Expected: IDs must have a supported bounded representation and participate in both budgets.

**Impact:** the new preflight itself can allocate an oversized reply and send it to the browser. No giant payload field is necessary. Existing Redis keys can exceed this application's 64 KiB typed-key limit, so input validation elsewhere does not protect search discovery.

**Minimal fix:** add bounded ID discovery (for example a reviewed server-side projection/length gate, or a transport-level reply limit that aborts oversized decoding), and include IDs in output budgeting. Use explicit truncation/opaque references for IDs that cannot fit; do not return a shortened ID as if it were actionable. A post-read length check fixes HTTP amplification only, not the initial allocation.

Additional measurement: control-character field values produce a **6,289,707-byte HTTP page** under the raw 1 MiB field-content budget (`probe-results.json`). That is JSON serialization overhead rather than independent evidence of raw-field-budget failure; define an encoded-response limit too if bounded HTTP bytes are intended.

### Medium — R2-M3. Key-browser pagination silently discards scanned keys

**Locations:** `apps/server/src/routes/keys.ts:201`, `:202`; `apps/server/src/redis/scan.ts:57`, `:64`.

**Reproduction:** `scan-check.mjs` / `scan-results.json`.

1. Create **12,000 stable synthetic keys** under `rc-review-s2:scan:` on sandbox-e2e.
2. As viewer, repeatedly POST `/keys/scan` with `{match:'rc-review-s2:scan:*', count:1000, cursor}` until the returned cursor is `"0"`.
3. Seven pages return **6,253 distinct keys**, leaving **5,747 missing**. A direct EXISTS check confirms all 5,747 still exist. Fixtures are deleted afterwards.

**Observed vs expected:** the scan helper accumulates complete Redis pages until it reaches its target or deadline. With MATCH filtering, this can take multiple calls and overshoot 1,000 substantially. The handler slices the result to 1,000 but returns the cursor *after* the discarded tail. Following that cursor never visits the omitted keys. Expected: a complete iteration over continuously existing matching keys must not silently omit them.

**Impact:** developers can conclude that keys/namespaces are absent even after completing a scan. The loss is backend pagination, not Redis expiry or merely duplicate SCAN results.

**Minimal fix:** preserve every match consumed by the returned cursor. Either carry overflow in a bounded server-side continuation, or stop after a safely smaller Redis page and return all its matches with a short-page continuation. Do not slice a consumed batch without preserving its tail. Add a filtered, multi-page integration test asserting coverage of the stable fixture set.

### Medium — R2-M4. Slowlog data reads remain unaudited

**Location:** `apps/server/src/routes/diagnostics.ts:55`.

**Reproduction:** `slowlog-audit.mjs` / `slowlog-audit-results.json`, read-only inspection of this instance's SQLite audit table.

- Viewer GET `/api/v1/databases/sandbox-e2e/slowlog?count=5`: **200**, five entries containing command arguments, **zero** new audit events.
- The same viewer's CLI `SLOWLOG GET 5`: **200**, **one** new audit event.

**Observed vs expected:** the review log explicitly excludes slowlog as polling metadata. However, its API returns argv, including key names and potentially value fragments. ARCHITECTURE requires every command/op to be audited; this is a data disclosure surface even though its input is only `count`. Expected: a redacted logical read event with actor/database/outcome and counts.

**Impact:** an authorized user can inspect data-bearing command histories without the access trail that the equivalent CLI path produces. This does not claim that allowing these roles to see slowlog is itself an authorization defect; that visibility is documented behavior.

**Minimal fix:** wrap slowlog reads with `auditedRead`, recording counts and outcome only. Never add the returned argv/client fields to the event. Other excluded metadata endpoints need an explicit audit-spec decision; their data sensitivity is not assumed to be identical to slowlog.

### Medium — R2-M5. Ordinary error logging writes search query fragments to stdout

**Locations:** `apps/server/src/app.ts:234`; message propagation at `apps/server/src/redis/exec.ts:12` and `apps/server/src/redis/manager.ts:486` onward (`sanitizeRedisError`).

**Reproduction:** `error-logging.mjs` / `error-logging-results.json`.

1. Create a small disposable search index on sandbox-e2e.
2. Viewer POST `/search/query` with `query: '@text:(private_review_r2_canary'`.
3. Receive **502** with Redis's syntax-error message. The ordinary Pino stdout line contains **`SEARCH_SYNTAX Syntax error at offset 7 near private_review_r2_canary`**.
4. The corresponding `audit:true` line contains no canary. A second malformed numeric query reproduces the leak.

**Observed vs expected:** read auditing redacts Redis error text, but the common HTTP error handler independently logs `err.message`. Redis errors deliberately retain useful text for the requesting user; host/URL sanitization does not remove quoted data. Expected: server logs, including non-audit logs, must not persist Redis query/value text.

**Impact:** sensitive query literals can enter stdout, log collection and retention systems despite correct audit redaction. No real credential or company value was used or observed leaking in this test; the canary is synthetic.

**Minimal fix:** log only the API error code plus a reviewed Redis error-code token for Redis failures, using the same redaction discipline as `failureDetail`; keep detailed text only in the authorized API response where appropriate. Cover both ordinary logger output and audit output with canary tests. Pino emits duplicate `msg` members here, but the first still exists in raw stdout; parsing away a duplicate is not a confidentiality control.

### Low — R2-L1. New search grammar refuses legitimate `FORMAT STRING`

**Location:** `apps/server/src/policy/replyGuard.ts:120`.

**Reproduction:** `search-grammar-extra.mjs` / `search-grammar-extra-results.json`.

On a small indexed hash, direct `FT.SEARCH index hello FORMAT STRING` succeeds. The same viewer CLI argv returns **413 `too_large`** because FORMAT is absent from `FT_SEARCH_OPTIONS`. Removing that option succeeds. Other tested normal option combinations work.

**Observed vs expected:** refusing unknown forms is the correct fallback, but a supported default representation should be recognized by the grammar replacement. Expected: accept the verified safe default form without weakening sizing. This is a compatibility limitation, not a policy bypass.

**Impact:** valid copied Redis commands fail on tiny documents with an unrelated size error. Workaround: omit the default FORMAT STRING option.

**Minimal fix:** parse FORMAT's one argument; accept STRING with the existing sizing behavior and separately review/budget EXPAND before enabling it. Do not blindly allow expanding output. No independent live JSON-index FORMAT EXPAND success is claimed.

## Checked and correct

- **Validation:** server suite **594 passed, 16 skipped**, 42 test files passed and the topology file skipped; server TypeScript check passed. Independent matrix **195 assertions passed**, covering all 21 typed writes across viewer/operator/admin on readOnly and maxRole-restricted databases, CLI/workbench writes, publish/bulk/admin diagnostics gates, global admin endpoints, and actual Redis tier identities. Registry audit reported zero advisories at review time (271 dependencies); this is a time-specific result, not a permanent guarantee. Artifacts: `server-tests.log`, `typecheck.log`, `role-matrix-results.json`, `pnpm-audit.json`.
- **Access control:** tested write restrictions remain effective across UI-independent routes. Admin capped to operator connects as rc-operator; ordinary tiers identify as their configured ACL users. Remote-6390 PING succeeds for all three app roles, while SET/PUBLISH/JSON.SET receive 403 before execution. No viewer write or ordinary operator server-admin escape was reproduced. These results do not establish arbitrary module safety on every Redis version.
- **Authentication and revocation:** source review and passing local/OIDC/TOTP/session tests cover password hashing, lockout, pending-session restrictions, TOTP replay, encrypted seeds, token rotation, auth generation and current-session checks. The new admin re-check is synchronous with its mutations after hashing; tested PATCH generation conflicts preserve the other administrator's password. OIDC group changes remain sign-in-time only, as documented; no new immediate IdP revocation guarantee is implied.
- **Credentials/configuration:** browser database summaries omit credentials and URLs; hosts and TLS come only from server configuration. Production reachable-tier validation now closes the original mixed-default loophole and rejects shared reachable usernames. `rediss://` is normalized to enabled verified TLS, even without a tls block. Actual cluster/sentinel failover, redirects, mTLS and production certificate handshakes were **unconfirmed** in this review; the absent topology was not provisioned.
- **Timeouts:** independent collateral/recovery test and real-Redis regression agree for standalone. The replacement authenticates with the same options and is kept out of the pool until reconnected. Tier-wide fallback and cluster/sentinel behavior are source-checked and have regression code, but were not live-qualified here.
- **Functional use:** snapshot string GET, hash HGETALL and sorted-set ZRANGE, plus each type's key-browser read, return 200 without Redis errors. The sampled string is exactly equal to a direct read. JSON projections, recursive selection, slices, search aliases/summaries/highlights/sorting and SUNIONCARD were exercised as described above. No claim is made that all real hash/zset bytes or every grammar form were compared.
- **Confirmations:** independent live requests confirmed 428 challenge, changed-body rejection, exact-body execution once, and replay rejection. Existing production reason/typed-name, preview, expiry, route/database/session-binding tests passed. Workbench/bulk cancellation and limits passed existing regressions. SCAN key-browser coverage is the separate R2-M3 defect; it must not be inferred correct from these tests.
- **Auditing/data handling:** newly instrumented reads record one redacted success/failure event for each tested request. SQLite audit UPDATE/DELETE protection, hashed keys, error-code-only audit records, CSRF-before-body parsing, security headers, URL-parameter restrictions, inert binary reply handling, static-file containment and SSE caps passed their tests. Ordinary error stdout and slowlog auditing have the exceptions above.
- **Deployment/scripts:** inspected Dockerfile, compose/Kubernetes examples and scripts without running dev setup, refresh, or deployment. Examples retain server-held secret references, per-tier production identities, non-root/read-only runtime configuration and a single SQLite-backed replica. Actual Kubernetes file ownership, ingress/network policy, image startup and compose deployment are **unconfirmed** here. The mutable base-image tag is already documented as needing release digest pinning.
- **Cleanup:** all `rc-review-s2:*` fixture keys were verified absent on 6411 and 6412; disposable search indexes were dropped. No source changes or commits. The review server (PID 2140) received SIGTERM and exited; port 4500 has no listener. `git status --short` was empty and `git diff --exit-code` passed immediately before removal. The requested `git -C <repo> worktree remove --force ../redis-console-wt/review-s2` completed successfully; the checkout is absent. The temporary production-entrypoint processes and RESP fixture were also stopped. Evidence and the isolated review data directory remain under `/tmp`; the owner's instance and data were untouched.
