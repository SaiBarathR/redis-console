# v0.4 round 2: arrays, vector sets, geo and search completion

Reviewer: GPT-6.1 Sol, independently reviewing the Claude Opus 5.5 implementation and round-1 fixes.
Snapshot: `release/v0.4 @ 79663bb` (`79663bb33950feea3a93fcc18ba4157c51369f19`).
Review branch: `review/v04-r2-data`. Date: 2026-10-27.

**Release recommendation: hold. Two High and two Medium findings remain.** The original pattern-length and VSIM
restrictions work, but the ARGREP work bound is bypassable through the console and through uneven element sizes.
Malformed vector filters also disclose filter values to audit consumers. No product code was changed.

## Scope and environment

Reviewed the array Redis implementation/routes/UI and shared schemas/ARGREP policy; vector-set implementation,
routes/UI, VSIM policy and shipped ACL grants; geo parsing and `GeoMap`; search `QueryEditor`; the array/vector-set
compare-and-set probes, `ActionForm`, and browser console policy. Read the machine rules, agent guide, architecture,
v0.4 plan, round-1 report, and round-1 verdicts before testing.

The built SPA and own server used app port 4500 with disposable application state and
`config/rconsole.dev.json`. Redis fixtures used only `sandbox-e2e` on permitted sandbox port 6411, under
`rv2d:20261027:`. Redis was 8.10.2; Node was 24.14.1. Keycloak was the existing sandbox issuer on port 8089.
Read-only/prod/effective-role API checks used the integration harness's configured aliases of that same sandbox,
with an in-memory application store; no external/read-only dataset was contacted. No container was started.

Headless Playwright Chromium exercised local QA and Keycloak viewer/operator/admin sessions (six sessions).
The collaborative preview opened, but two snapshots returned
`Preview automation snapshot timed out after 15000ms.`; Playwright supplied the browser evidence.
The development watcher restarted during initial test setup, causing connection-refused browser attempts. Its own
watcher PID was suspended while its serving child stayed running; the complete six-session run then passed.
These setup failures are not product findings or browser coverage.

### Validation evidence

| Check | Result |
|---|---|
| `pnpm --filter @rconsole/web build` | Passed, TypeScript and production SPA build |
| `pnpm --filter @rconsole/server typecheck` | Passed |
| Shared `array.test.ts`, `vectorset.test.ts` | 17 passed |
| Server unit array/vector-set/conflict-message/review-n1 | 34 passed |
| Server unit RESP/capped transport | 55 passed |
| Web array/vector-set/geo/policy/API tests | 78 passed |
| Web `pages/insight.test.tsx`, including field escaping/cursor tests | 26 passed |
| Array/vector-set integration files, temporary copies with only fixture prefixes adapted | 33 passed |
| Additional temporary integration probes | 5 passed: exhaustive access matrix; 12 revocation handoffs; completed-read logout behavior; read/search concurrency; real vector-attribute WATCH race |
| Chromium local and Keycloak × viewer/operator/admin | Six completed flows; zero page errors, CSP violations, external asset requests or fixture-data storage hits |

Temporary test/probe files were removed; their concrete requests and results are recorded below. An initially wrong
test filename, a harness argument mistake and an ACL DRYRUN attempt were corrected/excluded from coverage.
The sandbox deliberately denies ACL DRYRUN to its admin tier; actual connection labels, authenticated CLIENT INFO
and successful/denied application operations supplied the ACL evidence instead. Full E2E, topology/failover,
container smoke, dependency audit, mobile and screen-reader qualification were not run in this scoped review.

## Findings

IDs below belong to **round 2**; the final table uses **round-1** IDs.

### H1. Console ARGREP bypasses the inspector's element and weighted byte limits

- **Where:** `packages/shared/src/commands.ts:279` (`argumentRule`, ARGREP branch),
  `apps/server/src/redis/array.ts:224`; `POST /databases/:db/cli` and equivalent Workbench execution.
- **Reproduction:** create `rv2d:20261027:cost` with indices 0–4999, each containing 4096 `a` bytes. Use a
  64-byte pattern, 63 `a` bytes followed by `b`, so no value matches. As viewer, send:

  ```json
  {"key":{"enc":"utf8","data":"rv2d:20261027:cost"},"start":"0","end":"4999","predicates":[{"kind":"match","value":{"enc":"utf8","data":"<63 a bytes>b"}}],"nocase":true,"values":false,"limit":1}
  ```

  The placeholder represents the constructed 64-byte string, not literal angle-bracket text. `/array/search`
  returned 200 with `elements:817`, `searchedTo:"816"`, `next:"817"` in 158 ms. The same viewer sent `/cli`:

  ```text
  ARGREP rv2d:20261027:cost 0 4999 MATCH <63 a bytes>b NOCASE LIMIT 1
  ```

  It returned 200 and an empty reply in 619 ms, scanning the entire range. A LIMIT on matching results does not
  bound work when nothing matches. The shared branch checks RE and pattern sizes, then classifies the original
  command as read; it never invokes `searchElementCap`/`windowEnd`. It also does not share the typed route's
  predicate-count restriction.
- **Expected:** a raw console search must receive an equivalent work bound or be refused with an inspector hint.
- **Impact:** any viewer can evade the round-1 availability fix and make Redis evaluate an arbitrarily larger
  range on its main thread. The reply cap is ineffective for a tiny empty reply, and disconnecting after a command
  timeout does not cancel Redis's work. This review measured the small fixture above; larger blocking times are
  a scaling risk, not a production-scale outage reproduced here.
- **Suggested fix:** refuse console ARGREP shapes that cannot be safely bounded, or plan them through the same
  server-side bounded search executor. Apply the predicate count/byte rules consistently and add a no-match
  console-versus-inspector work regression.

### H2. A whole-array average does not bound the bytes in the selected range

- **Where:** `apps/server/src/redis/array.ts:215`–220 (`searchElementCap`),
  `packages/shared/src/api.ts:365` and `docs/ARCHITECTURE.md` Arrays availability claim.
- **Reproduction:** start with H1's fixture, whose `MEMORY USAGE ... SAMPLES 5` was 25,651,333 bytes and ARCOUNT
  5000. Add 50,000 one-byte `x` elements at indices 5000–54999, outside the requested range. Memory becomes
  26,153,205 bytes and count 55,000. Repeat the **identical** viewer request for indices 0–4999.
  It now returns 200 with `elements:5000`, `searchedTo:"4999"`, no continuation, in 606 ms.
  Reverse range 4999→0 likewise searches all 5000, in 608 ms.
  Eight copies of that predicate with OR return `elements:1102` in 1054 ms.
- **Expected/observed bound:** one 64-byte NOCASE MATCH has weight 16, so the stated 64 MiB weighted budget permits
  4 MiB of actual element bytes. The selected range contains 19.53 MiB; by the fix's own weighting it costs
  **312.5 MiB**, 4.88 times the budget. The eight-predicate request admits **551 MiB** by the same formula.
  The estimate uses approximately 476 bytes per element even though every selected element has 4096 bytes.
  Separately, one 8 MiB value is always admitted by `Math.max(1, ...)`: a no-match 64-byte NOCASE search returned
  200 in 254 ms, representing 128 MiB of weighted data despite the 64 MiB budget.
- **Impact:** even the typed viewer endpoint lacks the promised request work ceiling. Small elements elsewhere,
  or a single sufficiently large element, invalidate it. Concurrent changes between the sizing reads and ARGREP
  can also invalidate an estimate; that race was identified by inspection, not reproduced as an outage.
- **Suggested fix:** use a conservative bound valid for the actual selected values, with a hard per-element
  size/work rule. One option is bounded measured element retrieval and an independently work-limited matcher.
  A statistical/global average alone cannot enforce this security boundary. Refuse/skip an element that cannot
  fit the work allowance rather than always forcing one through. Test clustered large values, reverse ranges,
  eight predicates and an oversized single element.

### M1. Invalid vector filters are persisted verbatim in audit detail

- **Where:** `apps/server/src/redis/vectorset.ts:187` (`vsetRequestError`),
  `apps/server/src/audit.ts:68`–72 (`failureDetail`), `POST /vectorset/search`.
- **Reproduction:** as viewer, search the seeded vector set with `query:{element:{enc:"utf8",data:"m0"}}` and
  `filter: '.x == "R2DATA_FILTER_CANARY" &&&&'`. The API returns 400:

  ```text
  Invalid filter expression: syntax error in FILTER expression near: .x == "R2DATA_FILTER_CANARY" &&&&
  ```

  The JSON audit line has redacted argv (`FILTER`, `<33 bytes>`), but its `detail` contains that entire message
  including `R2DATA_FILTER_CANARY`. An admin's `GET /api/v1/admin/audit?limit=100` also contains the canary,
  confirming persistence rather than only an HTTP echo.
- **Expected:** audit/error logs record the failure category and counts, without filter operands or literals.
- **Impact:** a typo in a filter copies potentially sensitive values into persistent audit storage and its JSON
  log/SIEM stream. The Redis error originally qualified for code-only redaction; converting it to `validation`
  bypasses that redaction. No Redis credentials were disclosed in this reproduction.
- **Suggested fix:** return a fixed safe filter-validation message, or preserve a separate redacted audit error
  category when retaining useful syntax context in the response. Add an invalid-filter canary assertion for both
  audit storage and emitted audit lines.

### M2. Oversized attributes prevent the member panel from returning its bounded embedding

- **Where:** `apps/server/src/routes/vectorset.ts:183`–194 and
  `apps/server/src/redis/capped.ts:121`; `POST /vectorset/element`.
- **Reproduction:** create a two-dimensional member `m` with `SETATTR` JSON containing 600,000 `x` characters.
  As viewer, request its element panel with default options. The response is 413:

  ```text
  The Redis replies of this request exceeded its combined 1104-byte read budget.
  ```

  There is no `attributesTooLarge` response or embedding. A control member with a 100,000-character attribute
  returns 200 and its two embedding values.
- **Cause/expected:** the handler catches the attribute's per-value cap and sets `attributesTooLarge`, but the
  measured transport has set the shared request budget to zero. VEMB then fails before dispatch. The intended
  partial member response cannot be returned even though the embedding is tiny and the 16 MiB request budget
  was not actually consumed.
- **Impact:** members with valid attributes above the panel's 512 KiB value cap cannot be inspected through the
  panel; attributes hide the embedding and neighbours too. This remains safely bounded, but defeats the explicit
  graceful-omission behavior advertised by the response type and UI.
- **Suggested fix:** distinguish a per-reply overflow from exhaustion of the request budget, reserving bounded
  independent allowances for optional attributes, embeddings and links while preserving a total cap. Do not
  reset an actually exhausted budget. Add an oversized-attribute/small-embedding regression expecting 200,
  `attributesTooLarge:true`, and the bounded embedding.

### L1. Find similar cannot search a legal empty member name

- **Where:** `apps/web/src/components/VectorSetDetail.tsx:282`–283, 316 and 346.
- **Reproduction:** create a vector-set member named the empty byte string. In Chromium, open its first member
  row and choose Find similar. The member input is empty and Search stays disabled. This reproduced in all six
  local/Keycloak role sessions. The API request `query:{element:{enc:"utf8",data:""}},count:2` returns 200 and
  two results for the same member.
- **Impact:** empty-member paging is fixed, but the inspector cannot complete that member's similarity workflow.
- **Suggested fix:** preserve an explicitly selected Bin, including empty UTF-8 names, and distinguish an unset
  input from an intentionally empty member. Avoid the truthiness/HTML-required check for a selected member.

### L2. Array insert at the final index reports an upstream failure for an invalid range

- **Where:** `apps/server/src/redis/checked.ts:179`–183 (arrayInsert probe), `POST /ops`, `array.insert`.
- **Reproduction:** create `rv2d:20261027:edge` with index 0 containing `keep`; set its insert cursor to
  `18446744073709551614` using ARSEEK. As operator, submit `array.insert` with two values and
  `expect:{type:"array"}`. It returns **502 redis_error**, `ERR insert index overflow`.
  Redis preserves index 0, leaves the final index absent and keeps the cursor unchanged.
- **Impact:** no overwrite or partial write was observed, but a deterministic input/state boundary is presented
  as a server/upstream failure rather than a usable 400 validation error.
- **Suggested fix:** reject an insert whose cursor plus value count exceeds the index space during the checked
  probe, and map this Redis error defensively. Add the final-index/two-value test. This is an additional edge;
  the specific round-1 missing/wrong-type and vector-number cases are fixed.

## Checked and sound, with qualifications

### 1. Role access, database restrictions, confirmations and ACL tier

The additional live integration matrix exercised every new read route with valid fixture bodies:

| Routes | Anonymous | Viewer | Operator | Admin |
|---|---|---|---|---|
| `array/range`, `array/search`, `array/aggregate` | 401 | 200 | 200 | 200 |
| `vectorset/members`, `vectorset/attributes`, `vectorset/element`, `vectorset/search` | 401 | 200 | 200 | 200 |

All seven typed operations (`array.set`, `array.insert`, `array.delete`, `array.delete-range`, `vset.add`,
`vset.setattr`, `vset.remove`) return 401 for anonymous and 403 for viewer. Integration tests and browser writes
confirmed operator/admin array edits and vector attribute edits. Creation, deletion, append and member-removal
success paths also passed in the adapted integration suites. Every typed write is refused on the read-only
sandbox alias, for viewer/operator/admin, before any confirmation is offered; all seven reads still succeed there.
All seven operations require a typed database name plus a reason on the prod-tagged sandbox alias for both
operator and admin. The suites complete representative prod confirmations and verify the reason in audit.
Array deletes/range deletes and typed `vset.remove` require exact-request server confirmations on test databases.
Console VREM intentionally follows HDEL's existing unconfirmed behavior; typed removal has its own confirmation.

`dbScope` computes the minimum of account role and database `maxRole`; the manager chooses that role's configured
credential. Actual connection labels were `e2e/viewer`, `e2e/operator`, `e2e/admin`; separately authenticated
CLIENT INFO returned `rc-viewer`, `rc-operator`, `rc-admin`. Source inspection ties those credentials to all fixed
reads and typed operations, including exclusive checked edits. Viewer writes were refused at application policy.
The V* read grants match between the ACL template and installation example; only operator/admin receive VADD,
VREM and VSETATTR. Arrays inherit the read/write categories and checked edits use the transaction grant.

ARGREP RE and oversize values/NOCASE MATCH patterns are blocked; operands literally named RE/NOCASE are parsed as
operands. The remaining work-limit holes are H1/H2. VSIM TRUTH, NOTHREAD, COUNT/EF above 1000, FILTER-EF zero or
above 100000 and oversize filters are blocked by the console rule. Valid VSIM is available in the catalog and
browser. Typed similarity search keeps COUNT ≤100 and EF ≤1000 and always supplies positive bounded FILTER-EF
when filtering. The console's documented COUNT limit of 1000 is deliberately broader than the inspector's 100.

### 2. Revocation during admitted or queued requests

Real sandbox commands were held immediately before underlying measured dispatch (and before EXEC for checked
mutations), then the account was logged out, disabled or demoted using the application API. For each event,
ARGREP, VSIM, array.set and vset.setattr returned 401: **12 handoffs**, with array and attribute bytes unchanged.
The scoped actor predicate is attached to reads, pipelines and exclusive exchanges, and checked again after
transport waits and synchronously before writes. Six existing measured-transport N1 unit tests passed, including
pool/handshake waits, exclusive exchanges and simulated redirects.

An ARGREP that had already completed on Redis was paused before its result reached the route; logout then occurred.
The admitted request returned 200 with its result and the next request returned 401. This explicitly qualifies the
guarantee: revocation prevents later dispatch, not delivery of an already dispatched command's result. Redis work
and mutations already sent cannot be canceled/rolled back by closing the socket. Real cluster/Sentinel redirects
and an actual long-running Redis command spanning revocation were not run.

### 3. Resource limits

RESP transport tests passed for wire bytes, 100000 reply elements, nesting depth 32, truncation and socket disposal.
Default measured reply cap is 16 MiB; the dev display budget is 1 MiB and full-value cap 512 KiB. Reads remain
actor-checked and measured. Array pages/search result counts are at most 1000; previews at most 64 KiB each within
the display budget. The adapted integration tests prove full-element 413 and stale-reference refusal. An array
element above the reply cap still makes the page fail, as round-1 L5 deliberately documented.

The request-slot probe held four array searches, then observed 429 on the fifth; held two VSIM searches, then
observed 429 on the third. Another viewer could still read in both cases, and the held calls returned 200 after
release. Code limits attribute batches to two per user, members/element/page routes to their rate buckets, all typed
data reads to four per user, and measured commands to the global budget with a bounded FIFO queue. Attribute-slot
saturation itself was not separately forced.

The array tests cover sparse gaps across the unsigned 64-bit index space, forward/reverse bisection, continuation,
empty/full pages, AND/OR, eight-predicate weighting and the aggregate element ceiling. The actual 65-step sparse
bisection cost is modeled in the unit tests, not measured on a million-element sparse fixture. GLOB near-misses
with eight stars and 16/20/24/28-byte values completed in 2–3 ms in the small live probe. This is not a proof of
all GLOB complexity. H1/H2 invalidate the claimed ARGREP weighted work cap. Each Redis read receives the 5-second
command timeout; the multi-command array preflight does not establish a single cumulative 5-second request
deadline. No slow-network deadline stress test was run.

Vector members are at most 500/page; attribute batches at most 100 names, with bounded row reads and fallback
attempts. Embedding probes returned exactly 4096 shown values for a 4097-dimensional set and
`skipped:true,values:[]` at 16385 dimensions. VEMB is never requested above 16384 by the inspector. VLINKS has a
2 MiB wire cap, at most 32 displayed layers and 64 neighbours/layer; the bound is applied before exposing data,
with transport limits before decoding. On a real two-layer member, API layer 0's 32 neighbours exactly matched the
last raw Redis layer and API layer 1 had four neighbours. Oversize attributes expose M2; a 2 MiB VLINKS overflow
was inspected in source/unit coverage rather than reproduced with huge neighbour names.

### 4. Data leaving the server

Success audit events contain command shapes, key hashes, byte sizes and counts; adapted integration tests assert
that binary member bytes and attribute values do not appear. There is an exception for invalid filters: M1 proves
both audit persistence and JSON log disclosure. Server-provided validation/type-conflict messages use fixed text
except for that filter syntax context; raw Redis failures receive the ordinary error sanitizer/redaction path.

All six browser runs recorded zero page errors and CSP violations. Geo used the bundled outline without external
asset requests; hostile member text rendered inertly. UI requests kept fixture data out of URLs. Local storage
contained only theme and selected-database preferences; session storage was empty and neither contained the fixture
prefix. The raw unescaped prefix was absent from request URLs; API/schema/source inspection additionally checked
POST bodies and in-memory key selection. This was scoped browser inspection, not the full E2E
secret/leak scan; no claim is made about every application response or all persisted preferences.

### 5. Correctness and safe editing

The array suite passed exact indices `9007199254740993` and `18446744073709551614`, exact decimal ARINFO lengths,
binary values, reverse navigation, full-element identity conflicts, absent positions, guarded appends and creation
without overwrite. A real concurrent array change between read and EXEC returned 409; an intervening same-byte
write retried successfully. The extra real vector-attribute WATCH/MULTI race returned 409 and preserved the competing
writer's bytes. The vector suite passed absent-member creation, changed/missing-member attribute CAS, binary names,
exclusive byte-prefix paging and the empty member continuation. L1 remains for that member's browser search;
L2 covers final-index append overflow. No partial mutation was observed there.

Exactly full last pages no longer offer Next: array forward/reverse/end-bounded cases and vector prefix/full-page
cases passed. Geo flags were tested as positional key/member operands, including WITHDIST and STORE, alongside
actual WITHCOORD/WITHHASH options, GEOPOS missing members, keyboard point selection and the inert hostile member.
The parser and geo unit suite cover normal flag ordering and bounds. The shared ActionForm now catches synchronous
validation throws: invalid array indices and malformed base64 showed alerts, re-enabled Search and allowed a
corrected request in all six browser sessions.

Search field completion inserted `@a\|b:` with cursor offset 6 for a real index field named `a|b` in every role;
typing `x` and running the query succeeded. Unit tests additionally cover TAG/NUMERIC cursor positions, escaped
punctuation and preserving a literal OR pipe. Valid VSIM was runnable from the console despite bare-name catalog
classification, while TRUTH/NOTHREAD disabled Run. The shared-rule-versus-catalog regression passed.

### 6. Round-1 fix verification

| Round-1 item | Commit(s) | Round-2 verdict and evidence |
|---|---|---|
| H1: ARGREP work | `ff0a2e0`, `ec26e1f` | **Partial; hold.** 1 KiB values and 64-byte NOCASE MATCH cap work; uniform-array continuation works. R2 H1 bypasses work sizing through console; R2 H2 defeats the range estimate and forced minimum. |
| M1: wedged form | `1d09913` | **Fixed.** Unit regression and all six browser sessions show alerts and re-enabled Search after invalid index/base64, followed by a successful corrected search. |
| M2: console VSIM | `eaf3890` | **Fixed for the reported bounds.** Integration/shared tests and live console reject TRUTH/NOTHREAD and invalid effort/count shapes; valid bounded command executes. R2 M1 is a separate filter-error audit issue. |
| L1: exact-full paging | `8335753` | **Fixed.** Array forward/reverse/exact-end and vector prefix/full-page integration cases pass without empty next pages. |
| L2: geo operand parsing | `5dcc7ba` | **Fixed.** Unit cases plus six browser map flows handle FROMMEMBER WITHDIST and member STORE, without misreading them as flags. |
| L3: numeric/empty-after/type errors | `08be4eb` | **Fixed for the reported cases.** Finite-coordinate/schema and invalid-vector mapping tests pass; empty-name paging proceeds; array missing/wrong-type routes return 404/400. R2 L1 is the remaining empty-name UI path; R2 L2 is an additional array overflow mapping edge. |
| L4: retries and CLI affordances | `acde951` | **Fixed.** API read-retry classification test and vector copy/explain test pass; source includes all four read routes. Browser did not separately force a 429 retry. |
| L5: wording | `e357c96` | **Fixed.** Conflict-message and vector prefix-note regressions pass. Oversize-array reply failure and array.set refusing missing-key creation remain documented design decisions, not reopened findings. |
| VLINKS layer order | `09560d8` | **Fixed.** Reversal/bounds unit test passes; real upper-layer member matched raw final layer to API layer 0, as above. |
| VSIM bare catalog verdict | `3b8a41b` | **Fixed.** Integration catalog result is read/allowed; valid command runs in browser for every role. |
| Typed shared rule over catalog | `dfde937` | **Fixed.** Browser policy unit regression passes and all six live VSIM console runs enable and execute the valid typed command. Graph commands themselves are outside this review's runtime scope. |

## Cleanup and handoff

All review-created keys and the search index under `rv2d:20261027:` were removed. The own application server,
watcher and pnpm parent were stopped by their recorded PIDs; the disposable application data directory was removed.
Headless Chromium sessions were closed, temporary probe/test files and QA account artifacts removed, and the
collaborative preview closed. No shared service/container was stopped, no other checkout was changed, and nothing
was pushed. Only this written report is committed.
