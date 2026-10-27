# v0.4 review, round 1: vector-set inspector (S2), array inspector (S3), Workbench geo map (S4)

Reviewer: Claude Sonnet 5.5 (not the author of any of these streams). Snapshot: `release/v0.4` @ `89a15cf`.
Method: code reading of the scope in the brief, then live use: an own server instance with the built SPA, the QA
accounts (`qa-viewer`, `qa-operator`, `qa-admin`) and Keycloak `viewer1` / `operator1`, driven through the HTTP API and
Playwright Chromium (light and dark), against `sandbox-e2e` under the key prefix `rv1:20261027:`. The generic dev
config was used with two extra database entries that point at the same `sandbox-e2e` Redis, one `readOnly` +
`maxRole: viewer` and one `environment: prod`, so that the read-only and prod rules could be exercised without
touching any other instance. The machine-wide e2e lock was held by someone else, so no e2e spec was run. Unit suites
for the scope pass (shared 39, web array/vector-set/geo 30, server array/vector-set unit 23).

**Result: one High and two Medium findings remain** (H1, M1, M2). Everything else is Low.

---

## Findings

### H1. `ARGREP … MATCH … NOCASE` is O(value bytes × pattern bytes) inside Redis; the 1,000,000-element cap and the 16 KiB predicate cap do not bound its time

- **Where:** `apps/server/src/redis/array.ts` (`searchArray`, `windowEnd`, `predicateBytes`), `packages/shared/src/api.ts`
  (`ARRAY_SCAN_MAX_ELEMENTS`, `ARRAY_PREDICATE_MAX_BYTES`), `docs/ARCHITECTURE.md` §7 (Arrays). Route
  `POST /databases/:db/array/search`, reachable by viewer and up; the same command also passes the console policy
  (only `RE` is blocked by `argumentRule`).
- **Reproduction** (sandbox-e2e; 5,000 and 20,000 elements of 4,096 × `a`, written with `ARMSET`):
  1. As `qa-viewer`: `POST /array/search` `{ key, predicates:[{kind:"match", value:"a"×2000 + "b"}], nocase:true, limit:10 }`
     on the 5,000-element array. The HTTP call returns `504 timeout` after 5.0 s. A `PING` sent straight afterwards
     took 4,674 ms: Redis was still inside the ARGREP for about the same time again (about 9.7 s in total).
  2. The same ARGREP argv on 20,000 elements (the argv the route builds: `ARGREP key 0 100000 MATCH <2001 bytes> NOCASE LIMIT 10`):

     | Predicate | Time |
     |---|---|
     | `EXACT b` | 7 ms |
     | `MATCH b` | 118 ms |
     | `MATCH` 2,000 × `a` + `b` | 851 ms |
     | the same with `NOCASE` | **38,753 ms** |
     | 8 such predicates, `AND` (short-circuits after the first) | 38,900 ms |

     About 1.9 ms per element for a 4 KiB value and a 2 KiB pattern. The cost is value length × pattern length, so a
     16 KiB pattern against 64 KiB values is of the order of 200 ms per element, and the route is allowed to visit
     1,000,000 elements in one request (extrapolated from the measurement above: tens of minutes for 1M elements of 4 KiB).
     `GLOB` was fast in the same test (8 stars: 145 ms; 1,500 × `[a]` : 50 ms), so the `GLOB` cap works.
  The data has to be repetitive near-matches (padded or repeated-character values; random or prose text is not slow),
  but the pattern is entirely the caller's, and anyone with `viewer` can send it. With the route's rate limit (5/s,
  burst 10) and a 5 s command timeout, several of these can be queued back to back, each blocking the Redis main
  thread after the HTTP request has already failed.
- **Impact:** availability of the target Redis (T9). It is the same class as the `RE` case that the code and docs
  block "because Redis evaluates it in its main thread with no time limit"; `MATCH … NOCASE` has the same property
  and is offered in the UI ("Ignore case (NOCASE)"). The architecture text claims the per-request element cap bounds
  a search; it bounds the number of elements, not the work per element.
- **Suggested fix:** treat NOCASE (and any predicate longer than a few hundred bytes) like `RE`: refuse `NOCASE` with
  `MATCH` above a small pattern size (for example 64 bytes) in `zArraySearch` and in `argumentRule` for the console;
  lower `ARRAY_PREDICATE_MAX_BYTES` (a 16 KiB search term is not a real use case); and bound work per request by
  bytes, not only by elements (for example visit windows of 10,000 elements, or a smaller cap when the array's
  `MEMORY USAGE` / count suggests large values), continuing with `next`. Add a regression test with a repetitive
  fixture that asserts the ARGREP finishes within the command timeout.

### M1. The array search form wedges on an invalid index or invalid base64: page error, no message, "Working…" forever

- **Where:** `apps/web/src/components/ArrayDetail.tsx`, `ArraySearch`, the `onSubmit` of the `ActionForm` (about line 168):
  `onSubmit={() => run({ key, start: checkIndex(start, …), end: checkIndex(end, …), predicates: predicates.map(… inputBin(…)) … })}`.
  `checkIndex` and `inputBin` throw while the argument object is built, i.e. synchronously inside `onSubmit`, before
  `run` (the async function) is entered. `ActionForm.submit` (`ui.tsx`, `void onSubmit().then(…).catch(…).finally(…)`)
  has already called `setBusy(true)`, and the synchronous throw skips the `.finally`.
- **Reproduction** (Chromium, as `qa-viewer`, any array): open an array key, expand "Search values (ARGREP)", type a
  value, set "To index" to `abc`, press Search. Observed: the button reads "Working…" and is disabled for good; no
  error text appears (`role=alert` list is empty); the page records `pageerror: To index: enter a whole index from 0
  to 18446744073709551614.`; fixing the index and pressing Search does nothing (the click times out because the button
  stays disabled). Only closing and reopening the key (or reloading) recovers. The same happens for an invalid
  base64 condition value. The aggregate form (`async` handler) and the delete-range form do show the message
  correctly, so this one form is inconsistent.
- **Impact:** a form that cannot be used after a typo, an uncaught page error (every UI e2e fixture fails on page
  errors), and no feedback. Affects every role that can read arrays.
- **Suggested fix:** make the `onSubmit` handler `async` (as the other array forms are) or build the body inside
  `run`. Add a web test that submits the search form with an invalid index and asserts the alert text and that the
  button re-enables.

### M2. The console runs `VSIM … TRUTH NOTHREAD` and unbounded `COUNT` for viewers; the inspector's "never TRUTH or NOTHREAD" rule is not enforced where the policy is

- **Where:** `packages/shared/src/commands.ts` (`VSIM: { class: 'read' }`, no `argumentRule`), contract note in
  `docs/CONTRACT-CHANGES.md` (S2: "never TRUTH or NOTHREAD").
- **Reproduction:** as `qa-viewer` (and operator) `POST /cli {"line":"VSIM <key> ELE m000 COUNT 2 TRUTH NOTHREAD"}`
  returns 200 (executed on the viewer ACL user). `TRUTH` is an exact brute-force scan of every vector, and `NOTHREAD`
  runs it on Redis's main thread. Timing on a 30,000 × 128-dimension set (sandbox, int8): `COUNT 100`: 20 ms;
  `COUNT 30000 TRUTH`: 160 ms; `… TRUTH NOTHREAD`: 130 ms (the cost is proportional to members × dimensions: a million
  768-dimension vectors is in the seconds, blocking, for each call). `FILTER … FILTER-EF 0` is also accepted.
- **Impact:** a viewer can block Redis on a large vector set. The typed route does bound all of this (COUNT ≤ 100,
  EF ≤ 1,000, FILTER-EF always sent, never TRUTH or NOTHREAD; I confirmed those bounds), so the inspector is
  sound; the gap is the console, which is the same inconsistency the array work closed for `ARGREP … RE`. I did not
  measure at production scale (suspicion backed by the measured linear cost, not by a minutes-long run).
- **Suggested fix:** add `VSIM` handling to `argumentRule`: refuse `NOTHREAD` (and `TRUTH` above a small COUNT) and
  `FILTER-EF` of 0 or above `VSET_FILTER_EF_MAX`, with a hint pointing to the inspector.

### L1. A last page that is exactly full offers "Next", which opens an empty page

- **Where:** `readArrayPage` (`array.ts`: `items.length === q.count && last !== end` sets `next`), `pageOf` in
  `vectorset.ts` (`raw.length >= count` sets `next`).
- **Reproduction:** array with exactly 6 elements, `POST /array/range {count: 6}` → `next: "8"`; following request
  returns `items: []`. Vector set of 306 members: `vectorset/members {count: 306}` returns `next`, the following page
  is empty. In the UI, a key whose size is an exact multiple of the page size ends with an enabled Next that opens
  "No elements …" / "No members on this page."
- **Impact:** cosmetic and confusing, never wrong data. **Fix:** read `count + 1` and trim, or accept the empty page
  and disable Next once an empty page has been seen.

### L2. Geo flags are found by scanning every argv token, including keys, members and values

- **Where:** `apps/web/src/lib/richReply.ts`, `word()` / `geoView` (`WITHDIST`, `WITHHASH`, `WITHCOORD`, `STORE`).
- **Reproduction** (viewer, Workbench, key with a member literally named `WITHDIST`):
  `GEOSEARCH k FROMMEMBER WITHDIST BYRADIUS 20000 km WITHCOORD` (no WITHDIST flag). The reply has the usual
  `[member, [lon, lat]]` items; the parser believes WITHDIST was requested, reads the coordinate pair as the
  distance, finds no coordinates and returns no map: the result shows no "Map" tab at all. The same with a member
  named `STORE`, `WITHHASH` or a key named after a flag. The reverse (flag present but also used as a name) can also
  shift the columns. The normal cases are correct (see "found sound").
- **Impact:** a map silently missing for data with unlucky names; no wrong points were drawn in my runs.
  **Fix:** parse the argv the way Redis does (positional key and `FROMMEMBER` operand, then options), or
  validate the shape of each item against the flags before using it.

### L3. `vset.*`/array read errors: some user-request errors come back as 502 `redis_error`

- Vector search with a coordinate such as `1e999` passes the shared regex (`VSET_NUMBER` allows `e` + up to 3 digits)
  and Redis answers `ERR invalid vector specification`: the API returns **502**, not 400 (`vectorset/search`,
  `vset.add` the same). The browser form rejects it client-side (`Number.isFinite`), so only API clients see it.
  `vectorset/members` with `after: ""` returns 502 `ERR invalid start range format` (an empty member name is legal
  in a set: `vset.add` with `member: ""` succeeds, and such a member is shown as an unlabeled row that does open).
  `array/range`, `array/search` and `array/aggregate` on a non-array key answer 502 `WRONGTYPE`, while the vector-set
  routes answer a clear 400 ("This key is not a vector set.") after a TYPE check; a missing key gives an empty page
  rather than 404.
- **Fix:** bound the exponent in `VSET_NUMBER` (for example `\d{1,2}`) or map the Redis error to 400 in
  `vsetRequestError`; reject an empty `after`; use the same TYPE pre-check for arrays.

### L4. Inconsistent retry and CLI affordances for vector sets

- `READ_POSTS` in `apps/web/src/lib/api.ts` lists `array/(range|search|aggregate)` but none of
  `vectorset/(members|attributes|element|search)`, so a 429 on those reads is shown as an error where other
  typed reads are retried (code reading; I did not provoke a 429 from the browser).
- `readCommand` / `inspectCommands` in `KeyInspector.tsx` have no `vectorset` case: "Copy CLI" yields `TYPE <key>` and
  Explain shows "# No supported value reader".
- **Fix:** add the vector-set routes to `READ_POSTS` and `VRANGE … / VINFO / VCARD` to the helpers.

### L5. Wording and small UX points

- Prefix filter note: "Members 1–10 starting with the prefix **of 306**": 306 is the whole set, not the prefix
  match count.
- Conflict messages built from the expected type read "you opened a none" (vector-set add into a key that now exists)
  and "you opened a array" (`checked.ts` `conflictOf`).
- An array that holds one element above the per-reply budget (tested: 17 MiB element, budget 16 MiB) makes `key/read`
  fail with 413 (`The Redis replies of this request exceeded its combined … read budget`), so the array inspector
  never renders and "Jump to index" is unreachable, although `array/range` from another start works. A hash with a
  17 MiB field behaves the same, so this is consistent with the other types; reported for completeness.
- `array.set` on a key that does not exist is a 409 ("This key no longer exists") and `expect: {type:"none"}` is 400;
  only `array.insert` with `{type:"none"}` creates an array. Matches the contract, but the first element can only be
  written through the create-key form or Append.

---

## Reachable by role (checked live)

| Route / op | anonymous | viewer | operator | admin | read-only DB | prod DB |
|---|---|---|---|---|---|---|
| `key/read` (array, vector set), `array/range|search|aggregate`, `vectorset/members|attributes|element|search`, `key/element` (array ref) | 401 | allowed (viewer ACL user) | allowed | allowed | allowed | allowed |
| `array.set|insert|delete|delete-range`, `vset.add|setattr|remove` | 401 | 403 (policy: "requires the operator role") | allowed; deletes/removes ask for the server confirmation | allowed | 403 for operator and admin (effective role viewer), no challenge | challenge is `typed` with a mandatory reason; `array.set` also asks |
| Console `ARGREP … RE` (any case, quoted, `argv`, `argvBin`, after `LIMIT`/`NOCASE`/`AND`) | – | 403 | 403 | 403 | – | – |
| Console `ARSET/ARMSET/ARINSERT/ARSEEK/VADD/VREM/VSETATTR` | – | 403 | 200 | 200 | – | – |
| Console `ARDEL/ARDELRANGE/ARRING` | – | 403 | 428 confirmation | 428 | – | – |

Redis ACL tier (checked with the three ACL users directly on the sandbox): `rc-viewer` runs all `AR*` reads and `V*`
reads and gets `NOPERM` for `ARSET`, `ARINSERT`, `ARDEL`, `ARDELRANGE`, `ARRING`, `ARSEEK`, `ARMSET`, `VADD`, `VREM`,
`VSETATTR`; `rc-operator` runs all of them (the V* writes through the explicit `+vadd +vrem +vsetattr` grants). A
viewer-side `ARGREP … RE` is blocked before it reaches Redis.

**After revocation:** with `qa-operator` signed in, an admin demoted the account: the next array write and read
returned 401 "Not signed in"; after disabling it, `array/range` and `vectorset/search` returned 401. The checked write
path (`checkedWrite`) re-checks `stillAllowed` after the reads and before `MULTI` (existing machinery), and the new
probes (`vattr`, `vmember`, `array`, `arrayInsert`) run inside it. I did not time an in-flight race against a revocation.

## Correctness checks that passed

- **Array indices above 2^53:** elements at 9007199254740993, 9007199254740995, 18446744073709551613 and
  18446744073709551614 kept exact digits in `key/read`, `array/range` (both directions, `next` and the `start` jump),
  `array/search` (`next` after a limit), `array/aggregate`, element references, and `ARSET` through `array.set`.
  Non-canonical indices (`01`, `-1`, `1e3`, ` 1`, `18446744073709551615`) are 400.
- **Sparse paging:** forward and reverse pages, gaps rendered as "⋯ N empty positions: a–b", `Previous` returns exactly,
  `Last (highest first)`, jump to 1,299,990 of a 1.3M-element array, page size 1,000 (1,000 rows rendered), end of
  index space (no `next` after 18446744073709551614).
- **Search and aggregate bounds:** a 1.3M-element array: ARGREP stopped at 1,000,000 elements (`searchedTo`, `next`),
  the bisect continued correctly, forward and reverse; AROP over more than 1,000,000 elements is a 400 naming the count;
  `USED` over everything 10 ms; SUM over 1M elements 31 ms; GLOB is cheap even with 14 stars (Redis's glob matcher
  skips longer matches); sparse ranges are cheap (`AROP`/`ARGREP` over 0…2^64-2 on a 4-element array: 7 ms).
  Aggregate results are exact: SUM of 9007199254740993 + 1 = `9007199254740994`, XOR 9007199254740993 ^ 1 =
  `9007199254740992`, floats as Redis prints them.
- **Compare-and-set, arrays:** `array.set` with the element's SHA-256 wins, a wrong or stale SHA is 409 with the
  current value and an "overwrite anyway" expectation, `null` against a present element is 409, no `sha256` or no
  `expect` is 400, a binary value (`ff fe 00 80 0d 0a`) round-trips with an identical identity hash. `array.insert`:
  `{type:"none"}` creates, a second create is 409 "This key already exists", an occupied cursor (even only the first of
  three positions) is 409 with no overwrite offer and nothing written, an insert at the last index is the Redis error
  (502 `insert index overflow`). Race: 24 concurrent appends gave 15 × 200 and 9 × 409, 16 unique elements, no
  overwrite. Ten concurrent `array.set` with the same expectation: one winner, the rest 409/429.
- **Compare-and-set, vector sets:** `vset.add` of an existing member is 409 and the vector is unchanged
  (`VEMB` after = original); `sha256` must be null; ten concurrent adds of one member: one 200, nine 409.
  `vset.setattr` right SHA wins, wrong SHA 409 with current value, "no attributes" matches the SHA-256 of nothing, a
  vanished member is 409 "no longer exists", empty attributes remove them. Non-JSON attributes are accepted by the API
  (Redis stores them) and refused by the form.
- **Confirmations built from the exact argv:** `array.delete`, `array.delete-range` (reversed range shows "from 5 to
  600" while the argv keeps `600 5`), `vset.remove`. Tampering with indexes or the range after the challenge gets a
  new challenge, a used token is invalid, a 1,000-index delete previews 19 arguments with `moreArgs: 981`. On the prod
  database the challenge is `typed` with a mandatory reason; on the read-only database there is no challenge at all.
- **Vector-set paging with binary names:** 306 members including `ff fe 01`, `ff ff`, `61 ff` and CRLF names paged
  with `after` gave 306 unique members; byte prefixes `ff`, `ff ff`, `a`, `m00`, `<img` returned the right members;
  an `after` before or beyond the prefix behaved; a 0xff-only prefix runs to `+`.
- **Vector-set bounds:** COUNT ≤ 100, EF ≤ 1,000, a FILTER always sent with FILTER-EF (default count × 100, at most
  100,000), `FILTER-EF 100000` on 30,000 members took 30 ms; dimension mismatch, unknown member and bad filter are
  mapped to 404/400 messages. Attribute rows, embeddings, links and search attributes are all measured and capped
  (code review of `routes/vectorset.ts`); a 100-row attribute read pipelines on one socket.
- **Geo:** flag order `WITHCOORD WITHDIST WITHHASH` in any typed order, box and radius (circle drawn, antimeridian
  points fall back to the world frame), `GEORADIUS_RO`, `GEORADIUSBYMEMBER`, `GEOPOS` with a missing member in the
  middle ("Not found: nonexist"), 8 points, RESP3 doubles. Hostile member names (`<img onerror>`) are text in the table,
  the title and the label.

## Rendering, CSP, storage, audit

- Hostile values and names (`<img onerror>`, `<script>`, `<svg onload>`, `javascript:`, bidi override, template
  injection, `@import`, CRLF, invalid UTF-8, 5,000-character line, a 2^53+1 index, JSON attributes with markup) stayed
  text in the array table, the vector-set members table, the element dialog, the neighbours list, search results and
  the geo table. `window.__xss` stayed unset in all runs.
- Zero `securitypolicyviolation` events and zero page errors in every session except the M1 reproduction (the page
  error is M1); the only console errors were the expected signed-out 401, 409 conflict and 428 confirmation responses.
  Zero requests left the console origin (the OIDC redirect to the IdP aside). Light and dark themes were checked by
  screenshot; both were readable.
- Browser storage after browsing both inspectors and typing a search term: `localStorage` holds only
  `rconsole.theme` and `rconsole.database`, `sessionStorage` is empty, no cookie is script-visible, the URL stays
  `/db/<id>/keys`, no request URL carried a key, member or search term.
- Audit and logs: `array.*` and `vset.*` events carry the hashed key (`key#…`), predicate kinds, `<n bytes>` for
  values and indices, and counts only; the canary value and the key names are absent from the audit API and from the
  server log (0 hits).
- Keycloak `viewer1` and `operator1` see the same read-only / write controls as the local viewer and operator.

## What I did not cover

- No e2e run (lock held elsewhere); no topology (cluster/Sentinel) run: the new probes use the same exclusive-socket
  path as the existing checked ops.
- Reply-size bounds were checked with 600 KiB, 2 MiB and 17 MiB array elements and the shared per-reply cap, not with
  a many-gigabyte array.
- The in-flight revocation window of a long `array/search` or `vectorset/search` (only the gate was tested).
- H1 was measured on a 20,000-element array; the 1,000,000-element figure is an extrapolation.

## Conclusion

**Anything at Medium or above remains: yes.** H1 (ARGREP `MATCH … NOCASE` work is unbounded by the element cap),
M1 (array search form wedges on invalid input) and M2 (console `VSIM … TRUTH NOTHREAD`) should be fixed and
verified before 0.4.0. Everything else found is Low. The write paths (compare-and-set, confirmations, role, read-only
and prod rules, revocation), index precision, sparse paging, binary names, geo parsing and the rendering of hostile
data are sound.

## What I started and stopped

Started: one server instance (port 4600, a temporary data directory, a temporary config derived from the dev config),
a build of the SPA, Playwright Chromium sessions, and `redis-cli` / HTTP scripts against `sandbox-e2e` only. Stopped:
the server by PID (the `pnpm` parent and its two node children), all browsers. Removed: every `rv1:20261027:` key
(including two stray keys created by a shell quoting slip of mine and deleted by exact name), the data directory, the
temporary config, `.qa/accounts.json` and my scripts and screenshots. No container was started or stopped.
