# v0.4 round 3: data fix verification and graph UI review

Reviewer: GPT-6.1 Sol. Date: 2026-10-27.
Snapshot: `release/v0.4 @ 2fdffbe` (`2fdffbef46a42f429d9bbfbbd280b568a8e2adf5`).
Review branch: `review/v04-r3-data`.

**Release recommendation: hold. One High and two Medium findings are reproduced.** Round-2 H2 is partial:
moving matching out of Redis bounds accepted value data, but permits long synchronous glob matching in the HTTP
server and a continuation that never advances at the read-cap boundary. Slow-log argument redaction also fails
when the console display limit cuts an entry. The other round-2 fixes and both graph UI changes passed the scoped
checks below. Only this report is committed; no product code was changed.

## Scope and environment

Read the local machine rules, agent guide (including sections 2, 4, 8 and 9), architecture/security guidance,
round-2 data report, both round-2 verdict tables, contract changes and D22. Inspected the array matcher, batching,
route, shared contract and UI; ARGREP policy; vector error mapping and member panel; measured transport and its
overflow callers; slow-log reply redaction in console/Workbench and Diagnostics; graph key metadata and diagram.

Built the SPA and ran an isolated application instance on port 4500 with disposable state and
`config/rconsole.dev.json`, using server **start**, without a watcher. Node: 24.14.1. Redis: 8.10.2.
Fixtures used only `sandbox-e2e` (6411) and the existing `sandbox-graph` FalkorDB service (6413), with prefix
`rv3d:20261027:`. Keycloak used its existing sandbox issuer (8089). No container was started, restarted or recreated.
The in-process test harness also used configured read-only/prod/max-role aliases of the writable sandbox; it did
not contact an external dataset. No banned Redis endpoint, owner application instance or other checkout was used.

Headless Playwright Chromium completed local viewer, operator and admin sessions and a Keycloak viewer sign-in.
The local admin used TOTP. All four sessions exercised array search and oversized-value continuation, vector empty
member similarity and oversized attributes, invalid filters, console/Workbench ARGREP refusal, graph key details,
and graph keyboard/relationship interaction. Additional viewer/operator/admin sessions checked slow-log UI and API.

The collaborative preview could navigate, but two snapshots returned
`Preview automation snapshot timed out after 15000ms.`; Chromium supplied the browser evidence. The first shell
launch exited before binding the application port; it was replaced by a retained server-start session. One initial
graph browser assertion selected the self-loop instead of the intended LINK relationship; the selector was corrected.
An initial graph test-title filter matched no tests; the corrected filter ran the three intended role cases.
These tooling/setup attempts are excluded from passing coverage.

### Validation

| Check | Result |
|---|---|
| `pnpm --filter @rconsole/web build` | Passed: TypeScript and production SPA build |
| `pnpm --filter @rconsole/server typecheck` | Passed |
| Shared `array.test.ts`, `vectorset.test.ts` | 16 passed |
| Server unit array, vector-set, capped, RESP, key-meta and conflict-message files | 92 passed |
| Server unit redaction and hardening files | 32 passed |
| Web array, vector-set, graph, graphKeys, policy and API files | 89 passed |
| Array/vector integration files, temporary copies with fixture prefixes adapted | 38 passed |
| Graph integration, only “reads verbose” role cases, fixture prefix adapted | 3 passed, 14 unselected |
| Additional controlled between-batch size-change tests | 2 passed, forward and reverse |
| Additional deterministic partial-slow-log regression | 1 failed as expected: M2 |
| Additional live partial-slow-log regression | Viewer reproduced initially; operator reproduced on the expanded run |
| Predicate differential probe against Redis ARGREP | 3,522 comparisons; zero mismatches or Redis errors |
| Live array probes | H1 and M1 reproduced; clustered-range controls covered all 5,000 elements in two requests in each direction |
| Chromium changed flows | Four completed role/sign-in sessions; zero page errors, captured CSP violations, unexpected external origins or fixture-data URLs |
| Chromium slow log | Viewer/operator canaries hidden and admin canaries visible in both Diagnostics and console at the shipped display cap |

The expanded live slow-log test asked for the newest entry on a shared sandbox. One viewer iteration selected a
different entry and therefore did not exercise truncation; it is not evidence against M2. The original viewer
request, the operator request and the deterministic regression all exposed the canary. The deterministic regression
removes this shared-log ordering dependency. Temporary probe/test files were removed after recording their evidence.

Full E2E, topology/failover, container smoke, dependency audit, mobile and an actual screen reader were not run.
Keyboard focus, accessible names/states and the Chromium accessibility snapshot were checked; these do not qualify
screen-reader behavior. This is a targeted review, not a replacement for release gates.

## Findings

IDs in this section belong to **round 3**. The later verdict table uses **round-2** IDs.

### H1. A valid glob search blocks the HTTP server's event loop beyond the Redis timeout

- **Where:** `apps/server/src/redis/glob.ts:28` (retry the suffix at every byte),
  `apps/server/src/redis/array.ts:194`–205 and `:285`–287 (synchronous matching),
  `POST /api/v1/databases/:db/array/search`.
- **Reproduction:** seed `rv3d:20261027:cpu` at array index 0 with 1,000,000 ASCII `a` bytes. Construct a legal
  1,024-byte pattern with `'*' + 'a'.repeat(1022) + 'b'`. As viewer, POST a search with `start:"0"`, `end:"0"`,
  `values:false`, `combine:"or"`, and three identical `glob` predicates containing that pattern. All predicates
  fail, so all three are evaluated. Send an independent `GET /healthz` 100 ms after starting the search.
- **Observed:** search returned **200 after 7,766 ms**, with no matches and one element searched. The health request
  returned **200 after waiting 7,665 ms**. Configured Redis command timeout was 5,000 ms. A separate matcher probe
  took 261 ms for 100,000 bytes and 2,526 ms for 1,000,000 bytes with one such predicate.
- **Expected:** a viewer search has a usable CPU/time bound and allows unrelated HTTP work to proceed. The 16 MiB
  read budget and eight-predicate/1 KiB pattern limits do not provide that property: this example reads only 1 MB,
  uses one star and three of the eight permitted predicates.
- **Impact:** one authenticated viewer can stall authentication, health checks and other users' requests in the same
  Node process. Longer admitted values or more predicates can increase the stall; that scaling is an inference,
  not an additional long-duration outage test. Moving ARGREP work out of Redis relocated this availability issue.
  Redis socket timers and request-disconnect callbacks cannot interrupt the synchronous JavaScript loop.
- **Suggested fix:** share a hard matching-operation/time allowance across every predicate and value, checking it
  inside expensive matcher loops. Yield cooperatively or use isolated workers with enforceable deadlines. Define a
  truthful continuation/skip or refusal for a single value that exceeds the allowance. Test the long literal suffix
  after a star, as well as several short stars, and prove an unrelated request stays responsive. Short-pattern glob
  tests and a byte budget alone miss this case.

### M1. A value just below half the search budget can make Continue repeat forever

- **Where:** `apps/server/src/redis/array.ts:267`–280, especially the `cap < readCap` return at `:276`;
  `apps/server/src/redis/resp.ts:140`–142 (charged bytes include the overflow);
  `apps/web/src/components/ArrayDetail.tsx:404` (Continue follows the returned cursor).
- **Reproduction:** seed `rv3d:20261027:stuck` with index 0 containing `8 * 1024 * 1024 - 1` ASCII `a` bytes
  and index 1 containing `b`. As viewer, POST:

  ```json
  {"key":{"enc":"utf8","data":"rv3d:20261027:stuck"},"start":"0","end":"1","predicates":[{"kind":"match","value":{"enc":"utf8","data":"not found"}}],"values":false}
  ```

  Repeat using the returned `next`, without changing the array.
- **Observed:** three consecutive requests returned **200** with the identical result:

  ```json
  {"items":[],"start":"0","searchedTo":"0","elements":0,"next":"0"}
  ```

  In Chromium, searching for `b` also produced “0 elements searched” and “Continue from index 0”; clicking Continue
  produced the same summary and button. The later matching element cannot be reached.
- **Cause:** the value bytes alone are below the 8 MiB read cap, but its RESP framing takes the first batch over the
  cap. Actual charged bytes leave less than a whole read cap. The subsequent single-element attempt fails and
  returns the unchanged cursor because `cap < readCap`. Every fresh request repeats this sequence. The unit fake
  charges exactly its limit on overflow and misses the real transport's boundary behavior.
- **Impact:** a legal element can make the search permanently stop before it and every later element, contradicting
  D22's progress promise. The response also claims to have reached index 0 despite testing no element there.
- **Suggested fix:** guarantee a first-element decision with a fresh full allowance, for example by beginning with
  one element, or reserving sufficient allowance for that decision including framing/overflow accounting. Handle a
  zero-progress return explicitly; do not require an identical retry to resolve it. Clarify whether the skip limit
  measures value bytes or complete wire replies. Add real RESP tests around `readCap - 1`, `readCap` and framing
  boundaries, in both directions, rather than only a much larger oversized value.

### M2. A partially displayed slow-log entry bypasses argument redaction

- **Where:** `apps/server/src/policy/redactReply.ts:96` (`e.v.length <= 4` early return),
  `apps/server/src/routes/cli.ts:151` (display truncation occurs before redaction). Applies to console and the
  shared Workbench execution path; Diagnostics uses a separate correctly redacted path.
- **Reproduction:** use an in-process application configured with supported `policy.maxReplyBytes:1024` and the
  normal read cap. On the writable sandbox, issue `SADD rv3d:20261027:cut-canary R3_CUT_CANARY ...` with 90,000
  further distinct members, each an index followed by 128 `z` bytes. This creates a slow entry with a short canary
  before long, Redis-truncated arguments. As viewer, request console `SLOWLOG GET 1` when this entry is newest.
  Compare Diagnostics `GET /api/v1/databases/e2e/slowlog?count=1` in the integration harness.
- **Observed:** both routes returned **200**. Diagnostics replaced the canary with `<13 bytes>`. Console returned
  `R3_CUT_CANARY` and prefixes of subsequent member values. Its outer entry had only four retained fields
  (`id`, timestamp, duration, argv), with `more` set; argv itself was also partial. An operator request reproduced
  the same disclosure. At the shipped 1 MiB display cap the completed browser controls redacted this fixture.
- **Deterministic failing regression:** pass one synthetic slow-log entry through
  `toReply(raw, {maxBytes:1024,maxElements:10000})`, where argv contains `SADD`, a sandbox key,
  `R3_CUT_CANARY`, and 28 strings of 128 `z` bytes. Then call
  `redactReply('SLOWLOG','GET',reply,{hideAddresses:true,slowlogArgs:...})` with command index 0 and key index 1.
  `expect(JSON.stringify(shown).includes('R3_CUT_CANARY')).toBe(false)` **fails**. This does not depend on log order.
- **Impact:** a lower display cap, or enough entries to reach a display/element limit, can expose other clients'
  value arguments to viewers/operators. The “other arguments are admin-only” guarantee fails precisely at an output
  boundary. Larger-log deployments reaching the default cap are an implication of the same code path, not a second
  deployment configuration exercised here.
- **Suggested fix:** redact any available argv field independently of whether a client-address field survived.
  Hide the address separately if present, and preserve truncation metadata. Add byte- and element-truncated entries
  to console/Workbench redaction regressions. Do not return a partial entry unchanged merely because its client
  fields are absent.

## Round-2 fix verdicts

| Round-2 ID / change | Verdict | Evidence and remaining limit |
|---|---|---|
| H2, `c6afbf9`: bounded reads and server matcher | **Partial** | No inspector ARGREP dispatch; accepted/matched values use the cumulative byte and element allowances. The original 5,000 × 4 KiB cluster plus 50,000 small values required two requests in both directions. Eight NOCASE MATCH predicates covered 4,076 elements then 924; request times were 23–83 ms. Values above the read cap were skipped, sparse continuations worked, and controlled between-batch growth progressed forward/reverse. **Round-3 H1 and M1 remain.** |
| H1, `31b2c8e`: console/Workbench ARGREP block | **Fixed** | Integration verifies every role, raw/binary forms and Workbench. Shared policy tests pass. All four Chromium sessions disabled execution with the inspector hint. No conditional argument form re-enables ARGREP. |
| M1, `913e6bf`: safe invalid-vector-filter message | **Fixed** | Invalid-filter requests were 400 with the fixed message/optional character position, without the filter canary. Vector integration checks response, emitted audit lines and audit store. Live server log and admin audit response also lacked the browser canary. No filter suffix is interpolated into the validation message. |
| M2, `76e4555`: preserve request budget after per-reply overflow | **Fixed for the reported member-panel failure** | Capped/RESP tests pass: charged bytes stay charged; an actually exhausted budget still stops later reads. The 600,000-character attribute was omitted with `attributesTooLarge`, while the embedding and links remained inspectable in all four browser sessions. The array consumer exposes the separate continuation bug M1 above. |
| L1, `f8ad201`: empty member Find similar | **Fixed** | Empty member selection stays a Bin, shows “(the empty name)”, enables Search and returns similarity results in all four sessions. Component regression passes. |
| L2, `12ea2d9`: final array insert index | **Fixed** | Integration returns 400 for two appended values at the last cursor without changing count/content; one value still succeeds. The check precedes the write. |
| `111d600`: browser role/refusal wording | **Fixed** | Policy unit cases pass, including production restrictions. Live viewer GRAPH.QUERY refusal names the required operator role and current viewer role, and blocks execution before confirmation. |

### H2 matching and resource qualifications

The extra differential probe compared EXACT, MATCH and GLOB with/without NOCASE, including empty patterns/values,
NUL and high bytes, mixed-case and reversed character ranges, escapes, malformed classes and 1,500 deterministically
generated glob patterns. All 3,522 successful Redis comparisons agreed. Existing integration also compares combined
AND/OR predicates. D22's documented platform-specific signed-character range caveat was not observed on this sandbox;
other Redis builds remain unqualified.

The eight-predicate NOCASE control above forces every OR predicate to fail; AND uses the same matcher and short-circuit
combiner, covered by unit/integration tests. Both byte and element limits remain necessary. They are finite input/data
bounds, not an independently enforced matching CPU allowance. The worst admitted predicate is not represented by the
existing short `a*a*a*a*a*a*a*b` glob timing. Exact reads, folding buffers and match-result previews are bounded; H1
does not require an oversized allocation or an oversized Redis reply.

A value growing in a later batch was detected through the measured read and skipped with a monotonic cursor in two
controlled real-Redis tests. Search does not promise a snapshot: changes to already traversed indices can be missed,
and a value can disappear during skip-location bisection. A continuously changing dataset cannot be certified as
ARGREP-equivalent to one instant. No additional race finding is claimed from those source-only possibilities.

The read cap bounds decoding/retention in the application. It does not cancel work already dispatched to Redis or
prove that Redis constructs/copies no more than that many bytes before the socket closes. This review did not qualify
engine-side time/memory for arbitrarily large ARSCAN replies; the D22 “Redis copies at most” claim needs that distinction.

### M2 transport caller audit

Reviewed all source catches of `too_large`. Vector member attribute and link reads are optional and can continue on a
replacement socket while spending the same request budget. Array search intentionally retries a failed batch and is
covered by M1. The vector attribute-grid pipeline still zeroes its budget on batch failure; its bounded individual
fallback deliberately uses separate fixed allowances (at most 100 rows, 64 KiB per row, and three oversized failures).
That fallback predates this transport change and never depended on preserved budget. Checked-write comparisons turn
an oversized value into a conflict/too-large state and cannot continue writing on the destroyed exclusive socket.
Full-element reads end in 413. Metadata pipelines keep their existing terminal-failure behavior.

There is no new unlimited retry loop caused by keeping a per-reply budget. Successful and failed reply bytes remain
charged; the parser may charge the chunk that crosses the ceiling, so the counter can pass the nominal limit before
refusing further reads. This is a bounded transport granularity, not permission to reset or replenish the request.

## Checked and sound: items 2–4, with the finding above

### 2. Slow-log redaction outside the partial-entry failure

Normal complete entries in both APIs and both browser views hide viewer/operator value canaries and expose them to
admins as intended. Actual Redis byte-truncated values became their original byte count (`<515 bytes>` in the live
fixture); `... (89972 more arguments)` remained a structural marker without carrying member content. Synthetic
SET/MSET/HSET, Cypher, search, CLIENT SETNAME, AUTH, EVAL and unknown-command cases hid value/filter/script operands.
Command and recognized subcommand names stay visible. Known static key positions stay visible; unknown/missing
command metadata conservatively hides arguments rather than guessing dynamic key positions. Hash fields and members
are hidden. Client addresses are hidden for non-admins. Command metadata from a database without a module may also
hide that module command's key, which is conservative.

The marker exception accepts only an anchored numeric `... (n more arguments|bytes)` string. A value prefix followed
by a byte-truncation suffix is reduced to a count; the prefix is not kept. No further content leak was reproduced in
those marker/classification cases. **Item 2 is not fully sound because of round-3 M2.**

### 3. Graph keys are “not measured”

The legacy metadata path, pipelined metadata and key/read all omit core `MEMORY USAGE` for `graphdata`. Live role
integration checks both metadata and key/read. Chromium shows the key-list unknown-size marker with a “Not measured”
tooltip and “not measured” in the inspector. The GRAPH.RO_QUERY/Workbench hint appears without the generic unsupported
type sentence. Ordinary types retain their sizes; unit/component controls pass. The separate Analysis biggest-key
ranking was explicitly unchanged in round 2 and is not qualified by this UI fix.

### 4. Graph diagram keyboard, text rendering and caps

Every role could enter the diagram, move with arrows, Home and End, and select with Enter; Space was checked in the
large fixture. Exactly one node had `tabindex=0`. Relationship buttons expose direction and the other endpoint;
self-loops identify “itself”. Selecting LINK displayed its properties, including a literal script-shaped canary, as
text. Node properties containing an image-shaped canary also stayed text; no data-created image/script/link appeared.
Chromium's accessibility snapshot included button names, pressed state, the relationship list and textual details.

Unit checks cover one Tab entering and the next leaving the unselected diagram, empty/scalar results, endpoint
placeholders, resetting relationship selection, and omission counts. The parser caps drawing at 200 nodes/400 edges,
traversal at 10,000 visits/depth 32, and property display at 4,000 characters. The new node relationship list caps at
50 and announces the cut. A live 250-node/498-edge fixture drew 200 nodes and 398 eligible edges, announced 50 omitted
nodes/100 omitted edges, listed 50 hub relationships with “first 50 listed”, and retained one node tab stop. Omitted
relationships remain available through the result table/raw reply subject to server limits. No additional Medium or
Low graph UI issue was reproduced.

## Cleanup and handoff

Deleted every review-created key under `rv3d:20261027:` from both fixture databases and verified none remained.
Closed headless Chromium and the collaborative preview. Stopped only the recorded application server and its pnpm
parent by PID; the temporary application state was removed and port 4500 no longer had a listener. Removed temporary
test/probe files and the review's QA credentials/artifacts. No shared log was reset, shared service/container stopped,
other worktree changed or commit pushed. Synthetic slow-log entries can naturally remain in the shared sandbox log;
their fixture keys are deleted. This report is the sole tracked change.
