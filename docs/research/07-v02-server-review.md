# Redis Console v0.2 — independent backend review

Reviewed 2026-10-23. Snapshot: `release/v0.2`, commit `8a11704b7eda6cc6fc25d800c9ef2e818271ce19`.

**Result: 1 High, 6 Medium, 1 Low confirmed findings; no Critical finding.** Ordinary role, readOnly and maxRole enforcement held in the exercised matrix. Remaining problems concern allocation/reply budgets, argument interpretation, production credential validation, revocation during an administrative mutation, and audit completeness. This is not an unconditional security sign-off.

## Method and evidence

- Read `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/CONTRACT-CHANGES.md`, `apps/server/README.md`, `docs/V0.2-PLAN.md`, and the earlier `06-server-review.md`. Inspected scoped source and `git log v0.1..release/v0.2 -- apps/server packages/shared`. Earlier findings were not simply re-reported: the new findings below have current independent reproductions.
- Checkout: `../redis-console-wt/review-s1`; linked the requested `.env`, ran `pnpm install`, and made no tracked source changes or commits. `pnpm --filter` runs from the package directory, so the supplied relative config path initially failed; used its absolute path.
- Port **4500 was already occupied** by a pre-existing process. Left it alone and started this review's server on **4600**, public URL `http://localhost:4600`, data directory `/tmp/rc-review-s1`. Provisioned/verified QA accounts using `node scripts/qa-accounts.mjs http://localhost:4600`. Credentials and TOTP seeds are deliberately absent from this report.
- Existing server suite: **40 files passed, 566 tests passed; 14 topology tests skipped**. Server TypeScript check passed. `pnpm audit --json`: **0 critical/high/moderate/low/info advisories**, 271 dependencies in its reported total. Install did not change the lockfile or require additional dependency build approvals.
- Independent role matrix: **195 assertions passed**, covering all **21 typed write operations**, viewer/operator/admin, readOnly, maxRole=viewer, maxRole=operator, administrative route gates, and actual tier identities from `CLIENT INFO`.
- Direct data comparison used only disposable **6411/6412**. The development copy contained several thousand strings and a small number of collection keys at inspection. Exercised real GET, HGET, HGETALL, ZRANGE and SCAN; other types used shaped disposable fixtures. Remote 6390 was accessed only through the app; write attempts were requests expected to be denied before execution. Never connected to 6380 or ran `scripts/dev-setup.sh`.
- Reproduction scripts, machine-readable results, suite log and Docker build log are under `/tmp/rc-review-s1-tests/`. Scripts import the reviewed checkout; to rerun after its mandated removal, recreate that snapshot and adjust their `root` path if necessary. This evidence directory contains synthetic fixture descriptions and results, not a credential export.

## Critical

None confirmed.

## High

### H1. JSON reads can amplify small stored values beyond the preflight allocation budget

**Locations:** `apps/server/src/policy/replyGuard.ts:308-309`, `:416`, `:488-498`; execution/capping order at `apps/server/src/routes/cli.ts:87-104`.

**Reproduction:** `/tmp/rc-review-s1-tests/probes.mjs` and `allowlist-json.mjs`; results in `probe-results.json` and `json-allowlist-results.json`.

1. On sandbox-e2e, store `JSON.SET <unique-key> $ <JSON.stringify(Array(128).fill(1))>` using the disposable fixture connection.
2. As qa-viewer, POST `/api/v1/databases/sandbox-e2e/cli` with argv `['JSON.GET', key, 'INDENT', ' '.repeat(140000), '$']`.
3. Compare with the same direct Redis read. The document's `MEMORY USAGE` is **200 bytes**; the serialized Redis reply is **36,120,259 bytes**.
4. The app returns **HTTP 200**, with a small truncated reply marker only **after** node-redis has received/decoded the full response. The configured preflight byte ceiling is `16 × 1,048,576 = 16,777,216`, so the amplified reply exceeds it despite the tiny stored value.
5. Separately store a JSON array of **100,001** integers. `JSON.TYPE key '$[*]'` returns **HTTP 200** and direct Redis returns an outer array containing **100,001** type results. The document uses **131,144 bytes**. `JSON.TYPE` is on `BOUNDED_READS`, so this data-dependent fan-out skips the advertised 100k-element preflight entirely.

**Observed vs expected:** JSON.GET is sized solely by stored memory; arbitrary INDENT/NEWLINE/SPACE strings, path expansion and response representation are not reflected in that estimate. Other JSON path reads are treated as inherently bounded even though selectors can return arbitrarily many matches. Expected: bound the actual requested representation and result cardinality before issuing it, or reject unsupported forms.

**Impact:** a viewer can request disproportionately large Redis/node-redis allocations, with a request well below the HTTP body limit. Repetition/concurrency can affect availability for every role. The experiment stopped at about 36 MB; it did **not** intentionally exhaust memory or demonstrate a server crash. A hard timeout cannot reliably prevent allocation that completes within its time budget.

**Minimal fix:** reject or tightly limit formatting strings and unsupported expanding JSON.GET forms until their expansion is budgeted. Remove wildcard/multi-match JSON commands from the unconditional bounded list; introduce explicit size/cardinality planning or fail closed for those forms. Cover JSON.GET `FORMAT` variants and multiple/distinct paths when defining the supported grammar. Retain the post-decoding browser cap as an additional layer.

## Medium

### M1. Search sizing mistakes query/parameter data for options, both weakening caps and rejecting valid reads

**Location:** `apps/server/src/policy/replyGuard.ts:120-141`.

**Reproduction:** `probes.mjs`, `edge-cases.mjs`; `probe-results.json`, `edge-results.json`.

1. Create a temporary FT index on disposable hashes; insert 1,002 documents whose indexed text is `NOCONTENT` and which also contain a payload field.
2. Viewer CLI `FT.SEARCH idx * LIMIT 0 1001` returns **413 too_large**, correctly enforcing the 1,000-row content cap.
3. Change only the query to `NOCONTENT`: `FT.SEARCH idx NOCONTENT LIMIT 0 1001` returns **200**, with document content. The query is data, not the NOCONTENT option.
4. `FT.SEARCH idx * PARAMS 2 unused NOCONTENT LIMIT 0 1001 DIALECT 2` also returns **200** with content: a parameter value raises the cap to 100k.
5. Conversely, on an index containing a document with text `LIMIT`, valid `FT.SEARCH idx LIMIT` returns **413** although direct Redis returns one match. A `PARAMS` value of `LIMIT` produces the same false refusal.

**Observed vs expected:** the parser scans every token starting at the query, without skipping positional query data or option argument blocks. Expected: only actual NOCONTENT and LIMIT options affect the bound; searching ordinary terms and passing arbitrary parameter values must work.

**Impact:** a viewer can bypass the deliberate 1,000-content-row limit, increasing backend allocation, and routine developer queries can fail even with a single small match. The final CLI response cap still applies after buffering.

**Minimal fix:** parse the supported FT.SEARCH/AGGREGATE/PROFILE grammar, starting after the query and skipping counted PARAMS, RETURN and other argument blocks. Fail closed on unsupported syntax; do not detect options by matching arbitrary data tokens. Add both bypass and false-positive regressions.

### M2. The dedicated search endpoint bypasses the aggregate reply budget

**Location:** `apps/server/src/routes/modules.ts:85-102`, especially the per-field-only truncation at `:99-100`.

**Reproduction:** `search-route-budget.mjs`; `search-route-results.json`.

1. Create a disposable FT index over hashes.
2. Insert **20 documents**, each containing one indexed text field and **20 payload fields of 4,096 bytes** each.
3. As viewer, POST `/api/v1/databases/sandbox-e2e/search/query` with `{index, query:'*', limit:20}`.
4. Observe **200**, 20 documents, 21 fields/document, and a **1,645,871-byte HTTP response**, despite `policy.maxReplyBytes = 1,048,576`.

**Observed vs expected:** the route caps each field's character length but neither all fields/documents together nor the underlying decoded Redis reply. Unlike CLI/workbench, it does not apply an aggregate output budget. Expected: the configured reply limit must hold across the result and truncation must be explicit.

**Impact:** legitimate wide hashes exceed the promised API limit; many fields and/or large raw values cause much larger backend allocations and responses. A row count alone does not bound document bytes.

**Minimal fix:** share a byte/element budget across all returned documents/fields, with an explicit continuation/truncation indication. Constrain the raw search projection/document sizes before node-redis buffers them; at minimum request an explicit bounded projection and use a conservative preflight for supported queries.

### M3. One hard timeout destroys other users' tier connections and leaves existing metrics streams permanently stale

**Locations:** `apps/server/src/redis/manager.ts:152-155`, `:386-395`; `apps/server/src/routes/databases.ts:152-162`, `:191-196`.

**Reproduction:** `timeout-collateral.mjs`; `timeout-results.json`.

This small test runs the real app/manager against a temporary local RESP fixture, without delaying or modifying any real Redis. Two different viewer accounts share a configured tier pool; the fixture allows normal INFO/PING and delays selected PING replies.

1. Open user B's metrics SSE stream and receive its initial sample.
2. User A sends an allowed PING that the fixture does not answer. While it is pending, B sends another PING whose reply is delayed but whose own deadline has not yet expired.
3. A receives **504 timeout**. B's in-flight command receives **500 internal**, not the documented one-time 503; a fresh ordinary B request then succeeds with **200**.
4. B's existing metrics stream emits `The client is closed` errors on **two successive ticks**, even after that successful fresh request. INFO was called only during initial setup; the stream never reacquired the replacement connection.

**Observed vs expected:** timeout handling destroys the entire database/tier Conn, not only the affected socket. This shared reset is documented, but the metrics handler captures that Conn permanently and the collateral error is not mapped as documented. Expected: reset scope should be minimal, and long-lived streams should recover with the manager's current connection (or close cleanly so the client reconnects).

**Impact:** one slow request disrupts other users of the same tier and can break their dashboards for the remainder of a stream (up to an hour). This is a pool-isolation/recovery defect, not evidence that normal fast commands time out on a healthy real Redis.

**Minimal fix:** destroy/replace only the stuck acquired socket where the client library permits it. Reacquire a Conn on each metrics tick or after a reset, and map collateral reset failures to 503. For cluster/sentinel, explicitly define and test the smallest feasible reset scope.

### M4. A mixed default/per-tier credential config bypasses production risk acceptance

**Locations:** `apps/server/src/config.ts:374-376`; fallback at `apps/server/src/redis/manager.ts:341-345`.

**Reproduction:** `config-and-race.mjs`; `config-race-results.json`.

1. Use `NODE_ENV=production`, secure cookies, HTTPS public URL and a prod database with a verified `rediss://` URL.
2. Configure `credentials = {viewer: <viewer credential>, default: <admin credential>}` and omit `acceptRisks`.
3. `resolveConfig` accepts the configuration: the `perTier` predicate only requires **one** named tier.
4. In the same credential arrangement on disposable plaintext test Redis, an operator's CLI `ACL WHOAMI` returns **rc-admin**. This runtime part uses test mode because the sandbox does not offer TLS; no claim of a completed production TLS handshake is made.

**Observed vs expected:** adding a viewer credential hides default fallback for the other effective roles from the production risk check. The runtime fallback itself is documented behavior, but production's stated requirement is per-tier ACL identities unless `default-credentials` is explicitly accepted.

**Impact:** a deployment can silently lose the intended Redis ACL defense for operator/admin roles without recording the required reviewed exception. Application role checks still hold; this test did **not** find a direct viewer-to-admin application authorization bypass.

**Minimal fix:** determine which effective tiers are reachable under maxRole, then require explicit tier credentials for each, unless the default-credential risk is accepted. Missing credentials without a default should continue to fail closed at runtime. Also reject/review duplicate ACL usernames if distinct per-role Redis identities are the intended guarantee.

### M5. An administrative create can commit after the acting administrator has been disabled

**Locations:** `apps/server/src/routes/admin.ts:30-37`; analogous unchecked asynchronous password reset at `:79-88`.

**Reproduction:** `config-and-race.mjs`; `config-race-results.json`.

1. Start an isolated app with two local administrators A and B, no required TOTP for this small fixture.
2. A POSTs `/api/v1/admin/users` to create another administrator. The route awaits real Argon2 password hashing.
3. While the hash is pending, B disables A through PATCH `/api/v1/admin/users/:id`; B receives **200** before A's create finishes.
4. A's create then returns **201** and the new **admin** account exists. A's next admin request correctly returns **401**.

**Observed vs expected:** the request gate validates A only before the asynchronous hash. Unlike sign-in/password-change and multi-command routes, no current-generation/session check guards the final administrative write. Expected for a revocation boundary: reject the mutation if its actor was revoked before commit.

**Impact:** a revoked administrator can leave an additional privileged account behind through a request already in flight. This is a narrowly timed **already-authorized request** race; it does not let a viewer start an admin operation, and an administrator could of course create an account before revocation.

**Minimal fix:** compute expensive hashes first, then synchronously recheck the actor with `sessionStillValid`, its current admin role, and target-dependent invariants immediately before the mutation. For PATCH, stage changes rather than applying some before an await; check the target generation to avoid overwriting a concurrent credential change. Only the create race was independently reproduced here; the PATCH counterpart is a source-level extension, **unconfirmed** by a separate race test.

### M6. Key-browser reads leave no security audit event

**Locations:** `apps/server/src/routes/keys.ts:193-200`, `:203-324`; similar unaudited module reads start at `apps/server/src/routes/modules.ts:106`.

**Reproduction:** `audit-check.mjs`; `audit-results.json`.

1. Put a synthetic string under a unique key in sandbox-e2e.
2. Count qa-viewer's rows in this review instance's SQLite audit table using a read-only SQLite connection.
3. Viewer POST `/api/v1/databases/sandbox-e2e/key/read` succeeds with **200** and returns the value, but the audit-row delta is **0**.
4. Read the exact same key through viewer CLI GET; audit-row delta is **1**.

**Observed vs expected:** the key-browser handler issues several Redis commands and returns data without any audit event. This violates ARCHITECTURE's requirement to audit every command/op; using a different UI surface changes whether data access is recorded. SCAN and several feature-read handlers have the same missing instrumentation in source.

**Impact:** data can be browsed without a durable actor/database/key-correlation trail even though the CLI path is audited. Successful redaction of existing audit events does not repair missing events.

**Minimal fix:** audit each logical read operation and its denied/error outcome, including a hashed key or redacted pattern/argument metadata, counts and truncation. Do not record returned values, full keys or query text. Centralize this for typed/read feature routes to prevent future omissions. The positive and negative delta test above confirms key/read; other listed read surfaces were inspected in source rather than each independently counted.

## Low

### L1. Conservative sizing unnecessarily refuses tiny projections and a bounded scalar read

**Locations:** `apps/server/src/policy/replyGuard.ts:244-245`, `:308-309`, `:401-420`, `:494-498`.

**Reproduction:** `edge-cases.mjs`, `false-refusals.mjs`; respective JSON result files.

- A hash with **one small field name** and an **18 MB value**: viewer `HKEYS key` gets **413**, although direct Redis returns **14 serialized bytes**. Sizing charges HKEYS for the field values it never returns.
- A JSON document `{id:1,payload:<18 MB string>}`: `JSON.GET key $.id` gets **413**, although direct Redis returns **`[1]`**. The suggested key-browser fallback cannot select this path either.
- `SUNIONCARD 2 setA setB` gets **403 command_blocked** with a cannot-bound-reply hint, although direct Redis returns the integer **3**. Live COMMAND DOCS identifies it as a scalar cardinality read; it is absent from the reviewed bounded list. New array/count commands intentionally refused pending review are listed below separately.

**Observed vs expected:** avoiding unbounded allocations is correct, but a safe small projection/scalar read should not be treated as returning all underlying payload bytes. These examples have no confidentiality or role bypass.

**Impact:** ordinary developer inspection becomes unavailable precisely on large cache documents/hashes, encouraging broader or less efficient workarounds.

**Minimal fix:** add individually reviewed scalar commands such as SUNIONCARD to the bounded list. Size HKEYS by field-name output and support safely bounded JSON projections, or explicitly document unsupported projection forms with a usable alternative. Preserve fail-closed behavior for genuinely unknown commands. Search keyword false positives are the separate grammar bug M1.

## Checked and correct

The following conclusions combine current source inspection, the passing existing suite, and the independent checks described above. They apply to this snapshot and exercised standalone environment; they do not imply exhaustive proof over every possible Redis argument or topology.

### Authentication, sessions and TOTP

- Local login, password change, required TOTP onboarding, pending-session restrictions, replay protection, parallel consumption, lockout and username canonicalization passed the server tests and live QA-account flow. Passwords use Node Argon2id and constant-time comparison.
- TOTP seeds and pending seeds are encrypted with AES-256-GCM, fresh IVs, an HKDF-derived server key and user-id AAD. Encryption, migration, copied-ciphertext rejection, tampering and wrong-key failures passed the current tests. Config requires at least 32 key characters and startup verifies encrypted records. QA account credentials are mode 0600. The key must remain separate from the database/backup; changing it is not transparent key rotation.
- Session identifiers are random 256-bit values with only their hashes stored. Login/TOTP/password-change rotation, idle/absolute/pending expiry, logout invalidation and auth-generation rejection passed. The earlier in-flight sign-in/password-change races remain covered and passed; M5 is a different administrative mutation path.
- OIDC with live Keycloak passed the 10-test flow suite: advertised providers, normal roles, no-group refusal, state/browser binding, flow replay and failure handling. PKCE, state and nonce are supplied to the library. Own-key role lookup handles prototype-looking group names safely in current tests. Tokens remain backend-side; RP-initiated logout no longer includes an ID-token hint.
- `auth.oidc.sessionTtlMinutes` is parsed and passed to session creation; current unit tests verify it only shortens the absolute server TTL and that rotation preserves an active session's deadline. This review did not wait days or modify shared Keycloak group membership. Sign-in-only group refresh and lack of back-channel logout are documented limitations, not immediate revocation guarantees.

### Role and database rules

- All API routes traverse the session/auth gate unless explicitly public; administrative users/audit routes require global admin. Database handlers use `dbScope`, which computes `min(user role, maxRole)` and obtains that role's connection. Public health/provider/OIDC entry points expose no Redis credentials.
- Independent checks exercised **all 21 typed operations** with each role against readOnly and maxRole=viewer databases. All writes were denied. CLI SET/XADD/JSON.SET/CF.COMPACT, workbench writes, bulk delete, publish, slowlog reset and client kill were also refused under those restrictions. The current suite adds production/non-production destructive-command checks, binary argv and other module commands.
- `CLIENT INFO` verified rc-viewer, rc-operator and rc-admin on ordinary per-tier connections, and rc-operator for an admin capped at operator. Missing tiers do not silently choose a lower role; configured default fallback is intentional. M4 concerns insufficient production acceptance checks for that fallback.
- Remote-6390 viewer/operator/admin app sessions all refused SET, PUBLISH, XADD, JSON.SET and CF.COMPACT. Because its effective role is viewer, denial may be forbidden or command_blocked before readOnly is reached; disposable readOnly tests separately verify the actual readOnly guard.
- Search query, stream group/pending reads and time-series range routes only build fixed read commands. Search has the M2 resource-budget defect; no mutation or role bypass was demonstrated through its query string.

### Command classification, bounded reads and confirmations

- Shared static rules are the source used by server classification. Module metadata alone is no longer sufficient for a read: reviewed static exceptions or readonly plus @read are required; admin/dangerous and unclassified commands fail closed. Internal SEARCH.*, TIMESERIES.*, FT._* (except FT._LIST) and underscore-prefixed families are blocked.
- FT.CURSOR READ/DEL/GC have separate read/write/blocked handling; CF.COMPACT is write-classified. The current policy regression suite passes. No new viewer command that mutates ordinary key data, and no ordinary operator escape into a static admin class, was reproduced.
- Scripting, functions, connection/protocol changes, cross-database COPY DB, MOVE, SELECT and SWAPDB remain blocked. Administrative CONFIG/ACL mutations and KEYS are blocked. Blocking waits and SCAN COUNT are capped; repeated-member sizing, compact scan encodings and workbench limits passed their regressions.
- Live `/commands` correctly reports these current metadata-classified reads as unavailable pending review: **ARCOUNT, ARGET, ARGETRANGE, ARGREP, ARINFO, ARLASTITEMS, ARLEN, ARMGET, ARNEXT, AROP, ARSCAN, DIGEST, SUNIONCARD, TS.NRANGE, TS.NREVRANGE, TS.QUERYLABELS, TS.READ**. Some are intentionally documented fail-closed omissions; it would be incorrect to label every omission a security defect. SUNIONCARD's confirmed safe scalar example is L1. JSON formatting/fan-out and FT option parsing are the confirmed incorrectly permitted forms H1/M1.
- Independent confirmation requests showed an exact key in the preview, body mutation receiving a fresh 428, exact-body execution once, and replay receiving 428. The existing tests cover route/database/session binding, expiry, typed name/reason, pending limits, and capped-command/typed-op/bulk/workbench previews. Bulk matching is explicitly non-snapshot, so the eventual key set can change after preview.

### Functional results and data handling

- Real snapshot GET exactly matched a direct read. The key-browser string preview matched the direct value's prefix and byte length. Real hash HGET/HGETALL and sorted-set ZRANGE succeeded; shaped JSON.GET/XRANGE fixtures and SCAN also succeeded. The existing module tests check parsed search, stream and time-series results. No claim is made that every real cached value was fully compared.
- Confirmed key/value canaries did not appear in server stdout. CLI audit keeps command names, hashed keys and argument lengths, and Redis-error audit text is reduced to error codes. M6 concerns missing audit events rather than leakage in the events that exist.
- Current tests and source enforce credential/URL omission from database summaries, sanitized connection failures, CONFIG GET password redaction, hidden INFO fields, non-admin CLIENT/INFO/topology/slowlog address masking, and blocked ACL credential disclosure. CLIENT LIST is admin-only. SLOWLOG/profiler intentionally expose bounded command arguments to their authorized roles; that is documented product behavior, so this report does not describe all returned Redis values as leaks.
- Redis data-bearing URL parameters are rejected and key/pattern/channel/group inputs use POST bodies or opaque single-use pub/sub tickets. CSRF Origin/token checks run before body parsing. JSON/body limits, poison-key handling, security headers and static external-index-symlink protection passed the existing tests.
- SSE per-user slot reservation, stream lifetimes, event rate/backpressure limits, pub/sub message previews and logout termination passed. Rate-limit buckets use user identity on authenticated actions and IPv6 network prefixes for per-IP guards; their map is bounded. M3 is the demonstrated connection-reset recovery exception.

### Configuration, deployment and dependencies

- Production validation rejects HTTP public URLs, insecure cookies/issuers, insecure extra origins, blanket `trustProxy: true`, and disabled Redis TLS verification. A prod plaintext connection/default-only credential setup needs explicit risk acceptance; M4 identifies the mixed-credential loophole. Hop-count/CIDR proxy trust still needs to match the actual deployment path.
- Docker build from a **tracked-files-only archive** succeeded. Runtime image has uid **1000**, server and built SPA, no npm executable and no web source maps. A temporary container ran with **network disabled**, read-only root, tmpfs data/tmp, synthetic configuration/key and no host port bindings; `/healthz` and `/readyz` both returned **200**. Readiness is deliberately storage-based, not a proof of Redis connectivity. The Docker base uses mutable `node:24-slim`; pin its digest for reproducible release builds, as the Dockerfile itself recommends.
- Compose/k8s examples were inspected for single replica/PVC, non-root execution, read-only root, dropped capabilities, secret references, TLS-facing ingress and SSE behavior. **Unconfirmed:** actual Kubernetes mounting/network-policy/proxy behavior, compose end-to-end startup, and cluster/sentinel/mTLS failover/redirect behavior. The 14 topology tests were skipped because their disposable topology was absent; no new topology was provisioned.
- Scripts were read; the prohibited dev setup and remote snapshot-refresh scripts were **not run**. QA provisioning against the isolated server succeeded and stored secrets in a mode-0600 file. Production configs refer to server-held files/env secrets. Do not treat a repository example as proof of deployed file permissions or network controls.
- Direct external package versions are exact, the package manager is pinned, the lockfile is present, and esbuild is the only allowed dependency build script. Registry audit was clean at review time; this is not a claim that pinned packages can never acquire an advisory.

## Cleanup

Completed: this review server (PID 6094) exited after SIGTERM; port 4600 has no listener. Removed the temporary Docker runtime container and review image tag. Verified zero `rc-review-s1:*` fixture keys remained on 6411 and 6412. `git diff --exit-code` and `git status --short` were clean immediately before removal. The requested `git -C <repo> worktree remove --force ../redis-console-wt/review-s1` succeeded and that checkout is absent. Removed this review's `/tmp/rc-review-s1` SQLite/session directory; scratch tests/results and the tracked-only Docker source archive remain in `/tmp/rc-review-s1-tests`. The pre-existing process on port 4500 was left running; port 4000 and the owner's data directory were untouched.
