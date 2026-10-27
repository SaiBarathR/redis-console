# Review log

Findings from the v0.2 review rounds (see `docs/V0.2-PLAN.md`, "Review loop"). Each finding was reproduced against
the current code first (a failing test or a request against a live instance), then fixed with the smallest
correct change and a regression test that failed before the fix, or skipped with a reason.

> Commit hashes in this record refer to the private development history; the public history starts at v0.3. Names of
> the private development dataset and machine were redacted before publication ([GENERALIZATION-NOTES.md](GENERALIZATION-NOTES.md#publication)).

## Round 1 – server (GPT reviewer)

Report: `docs/research/07-v02-server-review.md` (snapshot `release/v0.2` @ `8a11704`). Fixer branch:
`feat/v02-server`. Test files: `apps/server/test/…`; `review-v02` is `test/integration/review-v02.test.ts`.

| ID | Verdict | Reason | Commit | Regression tests |
|---|---|---|---|---|
| H1 | fixed | Reproduced: `JSON.GET k INDENT <140,000 spaces> $` on a 200-byte document returned 200, and `JSON.TYPE k $[*]` on a 100,001-element array returned 100,001 elements (JSON.TYPE/STRLEN/ARRLEN/OBJLEN/ARRINDEX/DEBUG were on the unconditional bounded list). JSON reads are now planned from their paths: legacy and definite JSONPaths return one value (non-root definite paths sized with `JSON.DEBUG MEMORY`), wildcards/filters/slices at most the document (each value takes ≥ 1 byte of it), unions multiply, one `..` allows nested matches (×128, the nesting limit), two are refused; per-match commands count matches against the 100k-element cap; `FORMAT EXPAND`, `JSON.RESP`, `JSON.OBJKEYS` count elements; `INDENT`/`NEWLINE`/`SPACE` over 8 bytes are refused, shorter ones budgeted per value and nesting level. Everyday reads (`JSON.GET k`, `$`, `$.a`, `$..id`, slices, several paths, short pretty-printing, `JSON.TYPE k $.*`) still run on real-shaped documents. | `a0fb40c` | `unit/replyGuard` › "RedisJSON reads are sized by what they return, not only by the stored document (review v0.2 H1, L1)"; `review-v02` › "review v0.2 H1 / L1: …" (INDENT, fan-out tests) |
| M1 | fixed | Reproduced (unit + live index): query or `PARAMS` value `NOCONTENT` lifted the 1000-row content cap (200 for `LIMIT 0 1001`); query or `PARAMS` value `LIMIT` refused valid searches (413). Options are now walked after the query with the RediSearch 8 grammar (COMMAND DOCS), skipping counted blocks (`PARAMS`, `RETURN`, `INKEYS`, `INFIELDS`, `FIELDS`, `LOAD`, `GROUPBY`, `SORTBY`, `REDUCE fn nargs`) and fixed-arity arguments; unknown options fail closed (413 + hint); every real `LIMIT` still counts. `FT.PROFILE` finds `QUERY` at its fixed position. `FT.HYBRID` keeps the conservative scan (sub-query grammar); `FT.PROFILE … HYBRID`, which was not sized at all, now uses it too. | `8c0d7ba` | `unit/replyGuard` › "search options are read with the command grammar, not by matching data tokens (review v0.2 M1)"; `review-v02` › "review v0.2 M1: search options are parsed with the grammar" |
| M2 | fixed | Reproduced: 20 documents × 20 fields × 4 KiB gave a 1,645,531-byte response against `maxReplyBytes` 1 MiB. The page is now sized before it is read (ids with `NOCONTENT`, then `MEMORY USAGE` per document); only the leading documents within 16 × `maxReplyBytes` are read with content (`INKEYS`, so nothing else can be returned), the rest are listed by id; the response shares `maxReplyBytes` across all field names and values. Additive contract field `SearchResult.docs[].truncated` (logged in `CONTRACT-CHANGES.md`); paging by offset is unchanged. | `969e20c` | `review-v02` › "review v0.2 M2: the search endpoint keeps the reply budgets" |
| M3 | fixed | Reproduced with the reviewer's scenario (app + fake RESP server): user B's in-flight command got 500 `internal` (node-redis `DisconnectsClientError` was unmapped) and B's metrics stream kept the destroyed Conn. Standalone: the pooled client whose command is stuck stays out of the pool until its socket is destroyed and reopened (same HELLO/AUTH, verified as the same ACL user on real Redis); only if reopening fails is the tier reset. Cluster/sentinel: the smallest feasible scope is the tier (one pipelined socket per node shared by all its commands; node-redis has no per-socket replacement), now documented and tested; other tiers are untouched. Collateral failures map to 503; metrics streams look the tier connection up every tick. The self-review test that expected a new Conn after a timeout was updated to the narrower scope. | `d22af58` | `unit/hard-timeout` › "a hard timeout replaces only the stuck connection (review v0.2 M3)"; `review-v02` › "review v0.2 M3: a stuck command replaces only its own socket (real Redis)"; `integration/topology` › "a command that outlives its timeout resets this tier only; requests and metrics streams recover (review v0.2 M3)" (cluster and sentinel) |
| M4 | fixed | Reproduced: `{viewer, default}` with `maxRole: admin` on a prod database passed `resolveConfig` in production. Now every tier reachable under `maxRole` needs its own ACL user unless `"default-credentials"` is accepted; two reachable tiers sharing a username are refused the same way. Tiers with neither own credentials nor `default` still fail closed at runtime (503), so they need no exception. Live: the real entrypoint exits 78 with the mixed config and starts with per-tier users. `deploy/` examples comply. | `8dfb6c3` | `unit/config` › "prod databases need their own ACL user for every tier reachable under maxRole (review v0.2 M4)" |
| M5 | fixed | Reproduced (deterministic gate on the argon2 hash): an admin disabled while the hash was pending still created an admin (201); a password reset by a disabled admin was applied; a reset overwrote another admin's concurrent reset. Create and update now hash first and then, synchronously before writing, re-check the actor (`sessionStillValid`; 401, audited as denied) and, for PATCH, the target's auth generation (400 if another admin changed it); all PATCH checks and writes run after the hash on one state. Live: create racing a disable of its admin → 401, no account. | `b6839f9` | `unit/admin-races` › "admin changes racing a revocation (review v0.2 M5)" |
| M6 | fixed | Reproduced: `POST /key/read` (and `keys/scan`, `streams/groups`, `streams/pending`, `timeseries/range`) wrote no audit event. A central helper (`policy/enforce.ts` `auditedRead`) records exactly one event per read request: allowed with counts only, or denied/error with the failure code; keys as key tags, patterns/group names as byte counts, never values or query text. New actions `key.read`, `key.scan`, `stream.groups`, `stream.pending`, `timeseries.range`; `search.query` now also records failures. The keys test that asserted "no audit entry" for reads was updated. Not added: overview, slowlog, clients, search index list, command docs and pub/sub channel listing (server metadata the UI polls, not key reads). | `eded2bd` | `review-v02` › "review v0.2 M6: key-browser and feature reads are audited (one event per request, no data)"; `integration/keys` › "reads are side-effect free POSTs: no confirmation on prod, one audit entry each (review v0.2 M6)" |
| L1 | partially fixed | Reproduced all three. `SUNIONCARD` (one integer) added to the reviewed bounded reads. `JSON.GET k $.id` on an 18 MB document: fixed by H1 (definite paths are sized by the selected value). **Skipped: `HKEYS` on a hash with a huge value.** No O(1) Redis command sizes field names alone, and sampling them (`HRANDFIELD`, `HSCAN … NOVALUES`) is itself an unbounded read when names are large, so the size check would get a hole to save a rare false refusal. The key browser still lists such a hash (it always reads at least one entry, with a 64 KiB preview). | `d38e816`, `a0fb40c` | `unit/replyGuard` › "a definite path is sized by the selected value (L1: …)" and "reads that are neither sized nor reviewed as bounded fail closed"; `review-v02` › "L1: a definite path into a document larger than the budget …", "L1: SUNIONCARD (a scalar cardinality read) runs" |

### Validation

- Each regression test above failed on the code before its fix and passes after it.
- `pnpm -r typecheck` passes. `pnpm --filter @rconsole/server test`: 594 passed, 16 skipped without the topology;
  **610 passed** (43 files) with the cluster/sentinel/TLS topology up (`apps/server/scripts/topology.sh`).
  E2E `--project=setup --project=api`: **320 passed**.
- Live instance on :4600 (`config/rconsole.dev.json`, QA accounts): 58 checks as qa-viewer, qa-operator and
  qa-admin/qa-admin2. On `snapshot` (6412): real `GET`, `HGET`, `HGETALL` (including a large
  hash), `ZRANGE 0 19 WITHSCORES` and `ZRANGE 0 -1`; on JSON documents, a stream and a search index derived from
  private cache data (`rcfix:live:*`, removed afterwards): `JSON.GET` (whole, `$`, `$.field`, `.payload`, `$..id`,
  two paths, `INDENT`/`NEWLINE`/`SPACE`, `FORMAT EXPAND`), `JSON.TYPE/OBJKEYS/OBJLEN/MGET/STRLEN`, `FT.SEARCH`
  (`*`, tag query + `RETURN`, `SORTBY`, `NOCONTENT`), `FT.AGGREGATE … GROUPBY … REDUCE COUNT`, `FT.PROFILE`, the
  search page route, `XRANGE` (with and without `COUNT`), `XREVRANGE`, `XINFO STREAM`; every one returned 200 with
  the same data as a direct read. Each finding's reproduction now gives the fixed result; `remote-6390` was only
  read through the app.

## Round 1b – server, found during the UI live tour (Claude UI agent)

| ID | Finding | Verdict | Fix / test |
|---|---|---|---|
| UI-S1 | `POST /keys/scan` kept only the first 1,000 keys of a page while the SCAN cursor had already moved past the rest, so keys were silently skipped (reproduced: 1,783 of 2,600 keys returned). | fixed | `scanPage` asks each SCAN call for at most the room left in the page and the route no longer truncates. Test: `keys.test.ts` › "never drops keys when a page overshoots its size". |

## Round 2 – server (GPT reviewer)

Report: `docs/research/08-v02-server-review-r2.md` (snapshot `d445747`). Fixer branch: `feat/v02-server2`
(from `release/v0.2` @ `1984f93`). Test files: `apps/server/test/…`; `review-v02-r2` is
`test/integration/review-v02-r2.test.ts`. Read sizing, the area that kept coming back, now follows one rule: size the
reply as it is returned, from measurements Redis makes before anything large is read. node-redis 5 has no hook to
cap a reply while it is decoded, so the server measures in advance: `JSON.DEBUG MEMORY` per selected path, `MEMORY
USAGE` per document, and for searches one `FT.AGGREGATE` gate that returns only the longest key/field values among
the matches. JSON text is bounded at 6 × stored bytes, the measured worst case of escaping.

| ID | Verdict | Reason | Commit | Regression tests |
|---|---|---|---|---|
| R2-H1 | fixed | Reproduced (live and test): `JSON.GET` of a 3 MiB control-character document (MEMORY USAGE 3.1 MB) passed the 16 MiB check and returned 18.9 MB of JSON text. Measured on Redis 8.10: escaping makes JSON text up to 5.99 × the stored size (strings and object keys; MEMORY USAGE counts interned keys at every occurrence), doubles 1.85 ×, plain text ≤ 1 ×. JSON text replies (`JSON.GET`, `JSON.MGET`, `FT.GET`/`FT.MGET` of JSON documents, and the key browser's JSON read, which read up to 8 × 512 KiB of memory) are bounded at 6 × the selected bytes. To keep small projections usable, `JSON.MGET` now sizes definite paths per document like `JSON.GET`, and multi-match paths are measured with `JSON.DEBUG MEMORY` (one size per match, nested matches and union repeats included) whenever the match list is bounded, instead of assuming 128 nesting levels. So `$..id` on a real development document runs (it was refused on documents above about 128 KB of memory before, and would have been above 21 KB with the factor alone). | `39ceea6` | `review-v02-r2` › "R2-H1: …" (3 MiB document, `$.id`, escaped object names, `JSON.MGET`, key browser "load full value", everyday reads equal to direct reads); `unit/replyGuard` › "JSON text is budgeted with its escaping …", "values selected several times over …" (measured `..`) |
| R2-M1 | fixed | Reproduced: a viewer's `FT.SEARCH idx oversize LIMIT 0 1` read an 18 MiB document (row count only); `FT.AGGREGATE … LOAD 1 @payload`, `FT.PROFILE … SEARCH` and the workbench took the same path. New `policy/searchGuard.ts`. Ids: rows × the longest key among the matches, measured by the gate. `RETURN`/`WITHSORTKEYS` values are measured by the gate too, so small projections of big documents run. Whole documents are listed by id (same query and options, `NOCONTENT`) and sized with `MEMORY USAGE`, × 6 for JSON; HIGHLIGHT/SUMMARIZE markup is ≤ 8 bytes per insertion. `FT.AGGREGATE` rows are bounded by every loaded or referenced field (measured, implicit sortable fields included), reducer results (`TOLIST` holds one value per match in total) and APPLY values built only from fields, literals, numeric functions, `substr`/`format`/`case`/`timefmt`. Forms that cannot be sized are refused: `LOAD *`, string-growing APPLY functions, unknown reducers, `EXPLAINSCORE`, `FORMAT EXPAND`, `WITHCURSOR`, `FT.PROFILE HYBRID` (413), and `FT.CURSOR READ`, `FT.HYBRID` (403, no longer sized reads). A gate that times out refuses (RediSearch returns partial results then). A gate Redis error is the command's reply and the command is not run. | `dcb8892` | `review-v02-r2` › "R2-M1 / R2-L1: …" (wide hash and escaped JSON document via FT.SEARCH, FT.PROFILE, FT.AGGREGATE LOAD and TOLIST; refused forms; everyday searches/aggregations); `unit/searchGuard` (gate protocol, fail-closed replies, ids, documents, RETURN, aggregate model) |
| R2-M2 | fixed | Reproduced: the search page listed ids with `NOCONTENT` before any check, and an 18 MiB key name gave an 18.9 MB response. The page now runs the gate first and is refused (413, about 250 bytes) when its ids alone could exceed 16 × `maxReplyBytes`. JSON documents count × 6 in the read budget. The response budget is measured as JSON text (also fixing the reviewer's 6.3 MB page of control characters under a 1 MiB budget) and covers ids first. An id that does not fit is withheld (`id: ''`, new optional `idBytes`, `truncated`), never shortened. | `dcb8892` | `review-v02-r2` › "R2-M2: …" (300 KB key refused before any id is read; 20 KB key withheld under a 16 KiB budget; escaped values within the budget) |
| R2-M3 | already fixed | `1984f93` (UI live tour, round 1b): `scanPage` asks each SCAN call for at most the room left in the page and the route no longer truncates. Verified live with the reviewer's scenario: 12,000 stable `rcfix2:scan:*` keys, viewer pages of `count: 1000` with that MATCH: 12,000 of 12,000 keys in 12 pages. The filtered multi-page regression test the reviewer asked for exists. | `1984f93` | `integration/keys` › "never drops keys when a page overshoots its size" (2,600 keys, filtered, `count: 1000`, every key once) |
| R2-M4 | fixed | Reproduced: viewer `GET /slowlog?count=5` returned other clients' argv with no audit event, while the same viewer's `SLOWLOG GET 5` was audited. Now one `slowlog.read` event per request with counts only. Audit-spec decision for the other excluded endpoints: `POST /pubsub/channels` returns channel names, data like the key names `key.scan` already audits, so it now records `pubsub.channels` (the pattern only as a byte count). Overview (INFO counters), clients (connection metadata, addresses hidden from non-admins), the search index list (schema) and command docs remain unaudited server metadata. | `1e25d10` | `review-v02-r2` › "R2-M4: …" (one event each; no slow log argument or channel pattern in the audit) |
| R2-M5 | fixed | Reproduced: a malformed search query's canary reached stdout through the `request failed` log line (`msg: err.message`). 5xx lines now log the audit-style failure detail (`redis_error: SEARCH_SYNTAX`). An unconverted Redis error reaching the fallback handler is logged by code only. The user still gets the message. | `4945487` | `review-v02-r2` › "R2-M5: …" (two canary queries; captured pino stdout and audit lines contain no canary) |
| R2-L1 | fixed | Reproduced: `FT.SEARCH idx hello FORMAT STRING` → 413 (unknown option). `FORMAT` (one argument) is in the `FT.SEARCH`/`FT.AGGREGATE` grammar. `STRING` is the default representation and is sized as such. `EXPAND` (one reply element per JSON value) is refused until it is budgeted. | `dcb8892` | `review-v02-r2` › "R2-L1: FORMAT STRING …"; `unit/replyGuard` › "search: rows are limited …" (FORMAT cases) |

### Validation

- Each regression test above failed on the code before its fix and passes after it. Before the source changes: 11 of
  the 14 first round-2 integration tests failed. The 3 that passed check that everyday reads keep working. The key
  browser JSON test failed on the previous `keys.ts`.
- `pnpm -r typecheck` passes. `pnpm --filter @rconsole/server test`: **620 passed, 16 skipped** without the topology;
  **636 passed** (45 files) with the cluster/sentinel/TLS topology up (`apps/server/scripts/topology.sh`).
  E2E `--project=setup --project=api`: **320 passed**.
- Live instance on :4600 (`config/rconsole.dev.json`, QA accounts), **130 checks, all passed**:
  - Every finding's reproduction as qa-viewer on `sandbox-e2e`, with the reviewer's sizes (3 MiB control-character
    JSON document, 18 MiB search document, 18 MiB indexed key name, 12,000 scan keys), plus the workbench variant of
    R2-M1 and the slow log audit event read back as qa-admin.
  - On `snapshot` (6412), as qa-viewer, qa-operator and qa-admin: real `GET` (typical, and the largest value,
    equal to direct reads), `HGETALL` (including a large hash), `ZRANGE … WITHSCORES` and `SLOWLOG GET`.
    On JSON documents, a stream and two search indexes (JSON and hash) derived from private cache data
    (`rcfix2:live:*`, removed afterwards): `JSON.GET` (whole, `$`, `$.payload.title`, `$..id`/`$..name` on a large
    document, `INDENT`/`NEWLINE`), `JSON.MGET`, `FT.SEARCH` (`*`, `FORMAT STRING`, text query + `RETURN` + `SORTBY`,
    `NOCONTENT LIMIT 0 100`, `HIGHLIGHT`/`SUMMARIZE`, whole hash documents), `FT.AGGREGATE` (`GROUPBY … REDUCE COUNT`,
    `LOAD` + `APPLY`), `FT.PROFILE` (the search page's profile button), `XRANGE` (with and without `COUNT`), the search
    page, the slow log page and the key browser. All returned 200 with the same data as direct reads where compared.
  - `remote-6390` was read through the app only: PING, SCAN, TYPE, `FT._LIST`, the slow log page and a key scan as
    all three roles, with `SET` refused (403) before Redis.
  - Fixtures on 6411/6412 were removed and verified absent.

## Round 1 – web (GPT reviewer)

Report: `docs/research/09-v02-web-review.md` (screenshots `<research-dir>/review-w1/`), snapshot
`release/v0.2` @ `1984f93`; `release/v0.2` @ `65c7568` (console work) was merged in during the round. Fixer branch:
`feat/v02-webfix`. No `apps/server` or `packages/shared` change (nothing added to `CONTRACT-CHANGES.md`).
Unit tests: `apps/web/src/…`; E2E: `tests/e2e/specs/ui/review-w1.spec.ts` (`w1`). Each finding was reproduced live on
an isolated instance (:4800, `/tmp/rc-v02-webfix`, QA accounts) in Chromium before the fix, and each unit regression
failed on the code before its fix.

| ID | Verdict | Reason | Commit | Regression tests |
|---|---|---|---|---|
| H1 | fixed | Reproduced as operator on sandbox-e2e: after warming page 2, the list editor opened on index 0 stayed open on the cached page 2, labelled "index 100" with draft `item-0`; Save set index 100 to `item-0`. Row panels were keyed by row position. Panels are now bound to the element (hash field, list index, zset member; the editor is keyed by it) and `KeyContent` remounts per page (`cursor`/`offset`/`full`), so a page change closes the editor. | `8b8b3da` | `components/review-w1.test.tsx` › "H1: a cached page change does not move an open list editor…", "H1: a hash editor follows its field…"; `w1` › "H1: a cached page change closes the list editor and writes nothing" |
| H2 | fixed | Reproduced for every non-string type: Create replaced a JSON document (`JSON.SET` without NX) and a hash field, and added to an existing list/set/zset/stream. The server has `nx` only on `string.set`, so, without a contract change: JSON is created with `JSON.SET k $ v NX` (atomic, through `/cli`); every other type checks `EXISTS` first and refuses ("This key already exists…"); hash and zset are then written with `HSETNX` / `ZADD NX`, so even a key created between the check and the write keeps its fields and members. List/set/stream/module writes after the check can only add (residual race documented in `KeyOperations.tsx`). These creates are audited as `cli.exec` instead of `hash.set`/`json.set`. Tested as operator and admin on sandbox-e2e and snapshot. | `8e8a808` | `review-w1.test.tsx` › "Create key never changes an existing key (H2)" (8 cases, including the HSETNX/JSON.SET NX race replies); `w1` › "H2: Create key never changes an existing key, field or document" (all 7 types, contents compared) |
| M1 | fixed | Reproduced: Tree rows were `position:absolute` with the same top (8 rows, 2 distinct tops); a 4 KiB Search field covered the tool list and a normal click on Run search was intercepted. Cause: `keys.css` `.tree-row` (the key list's virtual row) matched the shared `JsonTree` rows. The key-list rules are now scoped with `:where(.key-list) .tree-row` (same specificity, so `.key-row`/`.key-folder` still win), `JsonTree` rows have their own `.json-row`, and the console's `.result-json .tree-row` override is gone. Checked in the inspector, Search and console JSON results, both themes. | `d000d39`, `582a385` | `review-w1.test.tsx` › "JSON tree rows do not reuse the key list's…"; `w1` › "M1: JSON Tree rows flow in the inspector", and the Search test clicks Run search normally over a 5,000-character field |
| M2 | fixed | Reproduced: after Inflate, change to `NEW-CONTENT` and Refresh key, the pane and Copy value still gave `OLD-INFLATED-CONTENT`. The inflated result (and its error) is now tied to the bytes it was made from; other bytes drop it and a late result for superseded bytes is never shown. | `b83417a` | `review-w1.test.tsx` › "a refreshed value replaces the inflated view of the old bytes"; `w1` › "M2: …" |
| M3 | fixed | Reproduced: under `…guided*`, Add key `…outside-filter` was listed and counted as a match; the key count stayed 264 while a rescan said 265. The browser does not match globs itself, so a created key is inserted only into an unfiltered list of a matching type; otherwise it opens in the inspector and the list shows `key-scan-changed` ("Rescan to update the list and counts"). Rename under a pattern removes the old row and asks for a rescan. Own creates/deletes adjust the key count (delete uses the server's count). Select all now covers only listed matches. | `6d96c9a` | `lib/keyscan.test.tsx` (count deltas, `markChanged`); `w1` › "M3: a key added outside the filter is not listed…" |
| M4 | fixed | Reproduced: complete scan → Guided SET of a matching key → back to Keys: no new row, no signal. A per-tab write counter (`writeCount`, a number, no data) is bumped for every successful write; the scan records the count it reflects and, while the key browser is open, absorbs its own writes. Writes from other pages leave it behind, which shows `key-scan-changed` with a Rescan button; a later key-browser write does not hide an older outside write. No automatic replay of pages. | `6d96c9a` | `lib/keyscan.test.tsx` › "writes made while the key browser is closed mark the scan as outdated…"; `w1` › "M4: a write made in Guided mode marks the scan as changed" |
| M5 | fixed | Reproduced: a document with `truncated: true` (5,000-character field) showed no hint. Truncated documents now get `search-doc-truncated` ("Preview cut…", or "Fields not returned…" when `fields` is `{}` because of the reply budget) and Open in key browser (key handed over in session memory, not the URL). | `78849c8` | `pages/search.test.tsx` › "M5: cut and budget-exhausted documents are marked…"; `w1` › "M5/M6/M1: …" |
| M6 | fixed | Reproduced: typing `@n:[1 1]` without running and pressing Next 20 sent that query with offset 20. Paging now uses the descriptor of the last run (named in the results header), is disabled while a page loads, and a new run starts at 0. | `78849c8` | `search.test.tsx` › "M6: paging uses the last executed query…"; `w1` › "M5/M6/M1: …" |
| M7 | already fixed (console merge) | Palette focus was fixed by the console owner in `e2fedee` (focus the input after `showModal()`), merged with `65c7568`. Verified live from Overview, Keys and Console: Cmd/Ctrl+K → focus in "Search commands" → typing `diagn` + Enter opens Diagnostics. Added the reviewer's keyboard-only regression from Overview (the existing one starts in the console editor). | — (test `ce53a08`) | `w1` › "M7: the palette shortcut focuses its search; typing and Enter navigate"; `console-keyboard.spec.ts` (palette from the editor) |
| QA spec | fixed | `apps/web/qa/contract.browser.spec.ts` (strict-CSP + Trusted Types harness with a nonce, fixture API) failed 2 of 6: the fixture's databases lacked the required `features` field, so Diagnostics threw on `features.profiler` (stale fixture, not an app bug: the server always sends it), and it looked for v0.1 wording ("Understand this key", the "All diagnostics" menu). Kept (it is the only nonce/Trusted-Types check of the built SPA) and updated; 6/6 pass (`cd apps/web && npx playwright test -c qa/playwright.config.ts`). Its fixture server moved from 4300 (the console agent's dev port, which collided) to `QA_CSP_PORT` (default 4810). | `25ec573`, see validation | the spec itself |
| Flake | fixed | `confirmation.test.tsx` › "names the database, environment and effective role" failed once in 7 runs: the target shows the bare id until the database list loads. The test now waits for the name. | `e985ae1` | — |

UX improvements (ranked by the reviewer):

| # | Verdict | Reason | Commit |
|---|---|---|---|
| 1 Audit outcome at 1024 | done | Columns are Time, User, Outcome, Action, Database, Command, Reason; the command column is 260 px below 1280 px and Reason keeps 180 px, so it scrolls instead of collapsing. Live as admin at 1024, both themes: Outcome in view, no page overflow. `w1` › "UX: Outcome stays visible…". | `87b34bf` |
| 2 Full-width inspector | done | `inspector-wide` toggle in the inspector title (keyboard accessible, `aria-pressed`) hides the list and split handle while a key is open; session memory only; a fallback "Show the key list" button if the read fails while maximized. At 1024 the inspector goes from 525 to 972 px. `w1` › "UX: maximize the inspector…". | `15d5900` |
| 3 Guided Find → Keys | done | `guided-continue-keys` scans the pattern that ran (not the edited field) in the key browser; handed over in session memory. `w1` › "UX: Guided Find continues…". | `8f8328a` |
| 4 Type glyph / TTL legend | skipped | Lower ranked and a design addition (legend placement, copy) rather than a cheap fix; glyphs already carry `title`s and the TTL label carries the meaning. |  |
| 5 Platform shortcut labels | already done | The console merge's keyboard registry (`lib/keyboard/registry.ts` `hint`/`shortcutLabel`) renders Ctrl vs ⌘ per platform for the palette cue and rail. |  |
| 6 Metric time windows | skipped | Lower ranked; needs a decision on which window each Overview readout should state (INFO totals vs 2 s samples). Left for the Overview owner. |  |

Coverage notes from the report: the 1024 layout with populated inspector/results and control hit testing is now covered for the cases above (`w1`); a general per-page "ready state" assertion in `pages.spec.ts` and focus/announcement checks after scan completion, errors and dialog cancellation were not added in this round (skipped: broader test work, no defect found). The obsolete 400-key scan rationale is updated in `docs/DESIGN.md`, `docs/qa/v02-ui-live.md` and `keyscan.ts` (`e3c1972`).

### Validation

- `pnpm -r typecheck` passes. `pnpm --filter @rconsole/web test`: **192 passed** (18 files); `build` passes.
  `apps/web/qa/contract.browser.spec.ts`: 6/6.
- Full `pnpm test:e2e` (under `/tmp/rconsole-e2e.lock`): **472 passed**, 0 failed (13.8 min), including the 11 `w1`
  tests and the final leak/audit/read-only-proxy checks.
- Live, isolated instance :4800 (`config/rconsole.dev.json`, QA accounts): every fixed finding was reproduced on the
  old build and rechecked on the fix in Chromium, light and dark, on sandbox-e2e and snapshot: H1 (operator),
  H2 (operator, admin), M1–M4 (operator), M5/M6 (viewer, operator, admin), M7 (viewer, from Overview, Keys and
  Console), UX 1 (admin at 1024), UX 2 (operator at 1024), UX 3 (viewer). `remote-6390` was only read, as viewer,
  behind a browser guard that aborts any non-read request: Keys, inspector, maximize toggle; only `keys/scan` and
  `key/read` were sent. No connection to 6380; port 4000 and the owner's data and `admin` account were not used.
  All `rcfix-w1:*` scratch keys and indexes were removed (0 left on 6410/6411/6412).

## Contract follow-up – search ids withheld (from server round 2)

| ID | Item | Verdict | Fix / test |
|---|---|---|---|
| R2-M2-web | The server can withhold an oversized search document id (`id: ''`, `idBytes`), which the UI rendered as an empty key name. | fixed | Diagnostics › Search labels it "ID withheld (N bytes, too large to list)" and offers no key-browser action. Test: `search.test.tsx` › "withheld document ids…". |

## Round 3 – server (Claude reviewer)

Report: `docs/research/11-v02-server-review-r3.md`, cut off inside H2; scripts in `r3-evidence/`.
Baseline `b9ea7e2`; fixer `feat/v02-replycap`. The lost finding text/IDs are not invented: script names identify
recovered findings where no reviewer ID survives. This round replaces size prediction with measured RESP reads;
it supersedes the prediction-based bounds described in earlier server rounds. Full reproduction, latency/RSS
measurements, script coverage and version limits: [qualification report](qa/v02-replycap.md).

| Finding / evidence | Verdict | Reason | Commit | Test |
|---|---|---|---|---|
| H1 — APPLY alias expansion (`apply-blowup`, `apply-live`) | fixed | The alias/term planner is deleted. Baseline 20 steps reproduced disproportionate heap/time; fixed viewer 30 steps returns Redis's index error in 21 ms without RSS growth. Covers FT.PROFILE AGGREGATE too. | `ace4bc4` | `integration/replycap` H1; live scripts |
| H2 — unbounded bytes (`h2-unsized`, `h2b-range`, `h3-keynames`, `h1-sampling`, `kb-stream`) | fixed | Exclusive sockets count bytes before decoding. Oversize strings/stream fields/list elements/key names and typed reads get 413; only that socket is dropped. The 120 MiB LRANGE and 20 MiB key-name cases no longer bypass a prediction. A compressed DUMP under the cap succeeds. | `ace4bc4` | `unit/resp`, `unit/capped`; `integration/replycap` H2/typed reads; prior review regressions; live RSS |
| Scan fairness (`fairness`) — recovered Medium | fixed | Reproduced other viewer's PING at 823–1546 ms during the original flood. Two concurrent scans per user and eight metadata workers bound amplification; live PING now 1–3 ms with eighteen of twenty flood requests rejected. Four other typed reads may run concurrently, preserving ordinary stream refreshes. | `ace4bc4`, `7851bfa` | Live fairness; `integration/replycap` concurrent stream refresh; E2E stream workflow |
| Sequential sizing probes (`mget-probes`, `mget-latency`) — recovered Medium | fixed | Preflight is removed. Baseline 9,999-key MGET 696.84 ms (inject); fixed live 18 ms, zero STRLEN probes. Remote-6390 read-only MGET forms succeed through the app. | `ace4bc4` | `integration/replycap` MGET; live scripts |
| Audit argument echo (`audit-echo`) — recovered Medium | fixed | Baseline FORMAT canary reached the 413 audit detail. There is no planner error text now; Redis errors are recorded by code. | `ace4bc4` | `integration/replycap` audit; captured baseline/live audits |
| JSON false refusals (`json-false`, `everyday`) — recovered Low | fixed | On a 153,024-byte document, TYPE/OBJLEN/STRLEN/ARRLEN wildcards were 413; all six scripted reads now succeed. Bounds depend on returned bytes/elements, not document-memory guesses. | `ace4bc4` | `integration/replycap` JSON; review-v02 / review-v02-r2; fixed-command latency set |
| L3 — denied MEMORY probe disables byte check (`small-confirms`) | fixed, same root as H2 | Reproduced with the original fake probe: MEMORY denied allowed HGETALL while a 900 MiB measurement refused it. Data reads no longer depend on MEMORY permission for safety. | `ace4bc4` | `integration/replycap` routing; raw socket overflow tests |
| L5 — catch-all proxy CIDRs (`small-confirms`) | fixed | Production now rejects every `/0` CIDR form as well as trustProxy=true. Explicit hop counts remain deployment settings. | `ace4bc4` | `unit/config` expanded IPv6/nonzero IPv4 /0 cases |
| ACL-denial key echo (`noperm`) | not reproduced on Redis 8.10.2; hardened | Real error is generic, without a key. Future ACL error text is audited only as a code (`forbidden: NOPERM`), with a synthetic key-canary regression. | `ace4bc4` | `integration/replycap` audit |
| Dictionary (`dictdump`) | viewer denied by ACL; admin covered by H2 | Viewer gets NOPERM. Admin's ~33 MiB, 300k-term reply gets 413; dictionary empty after cleanup. | `ace4bc4` | Live viewer/admin; aggregate element-cap tests |
| Sampling/version (`h1-sampling2`, `redis7`) | no separate current defect established | Current Redis 8.10.2 observes the large stored members; averaging still fails for ranges (H2). The Redis 7 script was adapted to permitted 6411, so historical Redis 7 sampling remains unqualified; the transport is independent of estimates. | `ace4bc4` | Live sampling comparisons; RESP2/3 parser tests |
| Access control / smoke (`matrix`, `matrix2`, `tiers`, `acl`, `smoke`, `ver`, `dbg`, `leftovers`) | no new defect | 126 restricted-route requests, nine workbench checks, twelve effective-ACL identity checks and prod SET → 428 typed/reason. Permitted fixture writes removed; remote reads through app only. | `62e3829`, `ace4bc4` | Existing policy-matrix/auth tests and live scripts |

`release/v0.2` `7a47aa0` is merged by `5181a8e`. The cancel route, disconnect checks, uncertain in-flight line
and merged web summary (N finished / line X may have run / M not run) remain compatible with socket cancellation.

Additional transport qualification: `0b4b6a5` proves one MOVED/ASK retry, no replay on network failure/timeouts,
recovery after overflow/malformed replies, cumulative typed budgets, oversized SSE pushes and exclusion of failed
AUTH/HELLO/SELECT sockets from the pool. Binary keys survive maps for every measured command. Cancellation from
consolefix `15f4a2b` is incorporated by `62e3829` and extended to destroy in-flight command sockets.

Validation and exact counts are recorded in [the qualification report](qa/v02-replycap.md). All recovered scripts,
including scenarios without a confirmed defect, have an adaptation/coverage note there. The first full E2E run
found a two-read guard rejecting an ordinary stream refresh; `7851bfa` fixes it, with a four-read concurrency
regression and a passing focused E2E workflow. Final merged validation: **675 server tests passed** with all 16
topology/mTLS tests included, **202 web unit tests passed**, workspace typechecks passed, and full locked E2E
**479 passed, zero failed** (13.2 min), including both merged cancellation-summary cases and final leak/proxy checks.

## Round 1 – console (GPT reviewer)

Report: `docs/research/10-v02-console-review.md` (snapshot `release/v0.2` @ `65c7568`; evidence in
`review-c1/`). Fixer branch: `feat/v02-consolefix`. `wb` is `apps/server/test/integration/workbench.test.ts`;
`e2e` cases are in `tests/e2e/specs/ui/console-keyboard.spec.ts` › "console review round 1"; `language` is
`apps/web/src/lib/console/language.test.ts`, `console` is `apps/web/src/components/console.test.tsx`. The server and
unit tests failed on the code before the fix. The first five e2e cases (H1, M2, M3, M4, L2) were run live against
the 65c7568 build before the fix and all failed (the M2 case at its new first assertion, focus on arrival; M2 itself
fails in `language`); the two added later (H1 fallback, UX 3) exercise the same old behaviour.

| ID | Verdict | Reason | Commit | Regression tests |
|---|---|---|---|---|
| H1 | fixed | Reproduced: a real HTTP request aborted while `BLPOP … 1` blocked still ran both later `SET`s on the server (`wb`: 2 keys written after the abort); live, the old UI marked every line cancelled. **Server**: the workbench loop checks an AbortSignal before every line. It fires when the client goes away before the response is sent, or on the new `POST …/workbench/cancel` (the caller's own session's script on that database), which answers at once with the finished lines plus `cancelled.inFlight` when a line was still running. That line is audited when Redis answers and keeps the one-script slot until then. Bulk delete also stops between batches when its client goes away (audit detail `stopped: client disconnected`). Contract change logged. **UI**: Ctrl+C / Cancel calls the cancel route and shows what happened: finished lines with their results, the line in flight as a cancelled block "Redis may have run it" and a `?` gutter marker (`may have run`), later lines `not run`; run header `cancelled · 1 finished · line 2 may have run · 2 not run`, announced the same way. If the server cannot be told (or does not answer within 2 s) the page closes the request, the server stops on the disconnect, and the run says which lines ran is unknown (`?` markers `unknown`). Declining the confirmation now says nothing ran instead of "Redis may still complete…". | `15f4a2b`, `67a8892` | `wb` › "workbench cancellation (console review round 1, H1)": "a client that aborts the request stops the script before its next line", "cancel answers at once …", "a cancel between lines …", "cancel only reaches the caller's own running script …", "a bulk delete stops between batches when its client goes away"; `e2e` › "Workbench Ctrl+C stops the script before its next line and says which lines ran (H1)" (the reviewer's BLPOP + SET repro: the key stays absent), "if the server cannot be told, Workbench cancel closes the request … (H1)"; `console` › "says which lines of a cancelled Workbench run …" |
| M2 | fixed | Reproduced with the real Redis 8 key specs: complete specs describe only words that exist, so at an empty key position the walker returned before recording the next argument (`GET `, `TYPE `, `MEMORY USAGE ` had no active argument; `MSET k v ` pointed at the whole block). The key is now the next argument (a repeated untokened block continues with its first argument), existing words keep their key-spec roles. Ctrl+Space at an empty key lists keys already seen in SCANs and the key browser (no new Redis request); typing the space alone opens nothing. | `3698805` | `language` › "an empty key argument with real key specs (console review round 1, M2)" (GET, TYPE, MEMORY USAGE, DEL and MSET repeats); `e2e` › "empty key argument: signature, Ctrl+Space keys and options; …" |
| M3 | fixed | Reproduced live: Esc on Collapse (also Copy, Re-run, key links) left focus there. The transcript's Esc handler now looks for the enclosing result (`closest('[data-testid="console-result"]')`) and keeps the `defaultPrevented` guard. | `67a8892` | `e2e` › "Esc from a result's actions returns to the editor, in the Console and the Workbench (M3)" (Collapse, Copy result, Re-run, a key link; Workbench Collapse) |
| M4 | fixed | Reproduced live: no per-line policy or status in the accessibility tree (the CodeMirror gutter is `aria-hidden`). The gutter stays as it is (no duplicate line numbers); the cursor line's policy and status are now part of the editor's accessible description, and a visually hidden list "Script lines and their status" gives every command line, including lines not run after an error. Same text as the gutter's tooltip (`lineMarkerLabel`). | `67a8892` | `e2e` › "Workbench line policy and status are in the accessibility tree (M4)" (`getByRole` list items and `toHaveAccessibleDescription`, before and after a run with an error) |
| L1 | fixed | Reproduced: `EXPIRE k 1.5` looked valid, `ZADD k +inf m` was underlined. Validation now follows the argument type: integers and unix times are an optional minus and digits (Redis `string2ll`); doubles accept decimals, exponents and ±inf/infinity, and score ranges (`min`/`max`) accept the exclusive `(` prefix. Still advisory. | `3698805` | `language` › "numeric cues follow the argument's Redis type (console review round 1, L1)"; `e2e` M2 case (EXPIRE 1.5 underlined, ZADD +inf not) |
| L2 (41/42) | fixed: test race and a product flash | Not the theme button. On a cold load the database view's lazy chunk suspended the app's only Suspense boundary, so the whole shell (rail, top bar, theme toggle) was replaced by "Opening workspace…" until the chunk arrived. `gotoView` can return in the short window before that, and the visual case then pressed Tab a fixed 120 times (about 0.4 s) while the toggle was hidden; on a loaded machine the chunk took longer (the reviewer's failure snapshot is exactly that state). Reproduced deterministically by holding the Console chunk. **Product**: a boundary around the routed view keeps the shell usable and shows "Opening view…" in the view only. **Test**: `tabToLocator` waits for its target to be visible and names the focused element when it gives up; the visual case waits for the editor before toggling the theme. Still keyboard-only (no `.focus()` or click). | `a7ec568`, `129be96` | `e2e` › "the shell stays usable while a view's code loads (L2)"; the visual case passed in every live run since |

Ranked UX improvements:

| # | Verdict | Reason | Commit |
|---|---|---|---|
| 1 Caret in the editor on arrival | done (when nothing holds focus) | Arriving by Option+2 from another view, from the palette or by loading the page leaves focus on `body`; the Console and Workbench now focus their editor then. A rail link activated by keyboard keeps its focus on purpose: global shortcuts never fire inside the editor (Option+digit types characters on macOS), so moving focus there would make Option+1/2 stop working from the rail. Test: `e2e` M2 and M3 cases (`toBeFocused` on arrival). | `67a8892` |
| 2 Completion at the first empty argument | done | M2, plus Ctrl+Space at a non-key argument lists the command's option tokens not used yet (SET: NX, XX, GET, EX, …, KEEPTTL), and a key typed with an opening quote still completes. Keys come from memory only; no network discovery. Not done: completing key names that contain spaces (the word at the cursor is split on whitespace; needs quote-aware tokenizing). | `3698805` |
| 3 Transcript Tab cost | done | M3 (Esc from any action), and a SCAN reply's keys are one Tab stop (roving tabindex; ↑/↓, Home, End inside the list; listed in the `?` overlay). Not done: JSON tree keyboard navigation (the shared JsonTree belongs to the UI branch). Test: `e2e` › "a SCAN reply's keys are one Tab stop with arrow-key movement (UX 3)". | `2b67646` |
| 4 Exact commands run on Enter | done | Enter runs when accepting the highlighted completion would not change the command (case-insensitive for commands and options, exact for keys), and accepts it otherwise; Tab and → still accept. With M2, typing a space no longer opens a key list by itself. Test: `e2e` M2 case (PING typed character by character runs on the first Enter). | `3698805` |
| 5 Explain empty results | done | A quiet note under the raw reply: `(nil)` from GET-like reads ("The key does not exist."), HGET, pops, blocking pops ("Timed out with nothing to pop."), ZSCORE/ZRANK; TTL/PTTL/EXPIRETIME -1 / -2; `TYPE` → none; empty `XINFO GROUPS`. Copy still copies the raw reply. Tests: `console` › "explains conventional empty replies …"; `e2e` H1 case. | `67a8892` |
| 6 Narrow-screen labels | done (labels only) | Below 1280 px the toolbar keeps its labels (previous, next, copy last; they fit at 1024) and the dock keeps "search" and "clear line" / "cancel request"; the other dock hints stay key caps with tooltips and accessible names. Not done: a labelled overflow menu for lesser-used actions (a design change, not a cheap fix). Checked in the visual case's 1024 screenshots, both themes. | `2b67646` |

### Validation

- The server and unit regression tests failed when run against the old source, and the first five e2e cases failed
  live against the 65c7568 build (see the note above the table); all pass on the fix.
- `pnpm -r typecheck` passes. `pnpm --filter @rconsole/web test`: **202 passed** (18 files); `build` passes.
  `pnpm --filter @rconsole/server test`: **627 passed**, 16 skipped (topology not running).
- Full `pnpm test:e2e` under `/tmp/rconsole-e2e.lock`: **479 passed**, 0 failed (13.3 min). A first full run had one
  failure in the new H1 case: the preceding Console cancel case leaves its aborted `BLPOP … 5` running on the
  server, which holds the operator's single blocking slot, so the server (correctly) answered 429 to the Workbench
  BLPOP. The two Workbench cancel cases now wait for the slot with a 10 ms BLPOP probe (`3d96727`).
- Live console matrix (`docs/qa/v02-console-live.md`), own instance on :4300 (`config/rconsole.dev.json`, QA accounts
  qa-viewer/qa-operator/qa-admin), under the lock: **49 of 49** (the original 42, including the visual case at
  1024/1280/1440/1920 in both themes, plus 7 new). Writes went only to sandbox-e2e under `webqa:20261023:console:`
  (`EX 60`) and `rcsrv:wbcancel:*` (server tests, removed); snapshot, sandbox-main and remote-6390 were only read
  (remote-6390 behind the matrix's read-only request guard). No connection to 6380; port 4000, the owner's data and
  `admin` account were not used. The :4300 server was stopped by PID afterwards.
- Not covered (as the reviewer noted): non-macOS keyboards were simulated only in unit tests, and no screen reader
  session was run; the accessibility checks use Playwright's accessibility tree.

## Round 2 – web + console (Claude reviewer)

Report: `docs/research/12-v02-web-review-r2.md`, reviewer snapshot `7a47aa0`; fixer starts at
`release/v0.2` `93a5720`, branch `feat/v02-webfix2`. No pushes. Regression tests below first failed against
the corresponding original source; current validation results follow after live qualification.

| ID | Verdict | Reason | Commit | Regression test |
|---|---|---|---|---|
| H1 | fixed | Reproduced rounded numbers in formatter, tree and path picker. Bounded data-only JSON parser retains every number token as text, including big integers, decimal/exponent notation and negative zero. All value-data JSON parsing uses it; trees render token text; path picker serializes losslessly; submitted editor text is sent verbatim. No dependency. | `c87ab1a` | `json.test.ts`, `review-w2.test.tsx` H1; `review-w2.spec.ts` H1 covers clipboard and Redis write/readback |
| H2 | fixed | Reproduced a draft surviving changed bytes at the same index. On a changed list snapshot, close the panel permanently if its indexed value changed or vanished, with a visible reopen notice. Identical-value refreshes retain the draft. This prevents the reported refresh retargeting; a concurrent Redis change after the last read still needs server-side compare-and-set in a future contract. | `c87ab1a` | `review-w2.test.tsx` H2; `review-w2.spec.ts` H2 manual and automatic refresh |
| H3 | fixed | Reproduced shared decoder stripping BOM bytes. `ignoreBOM: true` preserves them; display escapes BOM while key identity uses original bytes. | `c87ab1a` | shared `bin.test.ts` (6); server `binary.test.ts` BOM scan/read/write/delete; web H3 unit and confirmed-delete E2E |
| M1 | fixed | Reproduced ordinary string edits issuing plain SET, removing TTL. Existing strings now default to `SET … KEEPTTL` through the existing policy-gated CLI; an explicit checkbox permits TTL replacement/removal. | `d9b4a97` | `review-w2-medium.test.tsx` M1; E2E M1/M2 checks Redis TTL before/after preservation and explicit removal |
| M2 | fixed | Reproduced textarea CRLF normalization. String and inline editors open values containing CR in Base64; carriage returns are escaped in text display. Imported strings also use byte editing when needed. | `d9b4a97`, `63e2aa5` | medium M2 tests; E2E string/hash readback compares CRLF bytes |
| M3 | fixed | Reproduced timestamp heuristics replacing stored numeric text. Collection cells and scores now show raw text first, with a labelled secondary timestamp hint. | `d9b4a97` | medium M3; E2E M2/M3; viewer read case |
| M4 | fixed | Reproduced authenticated background requests moving last-seen time. Polls and SSE admissions send `X-RC-Background: 1`; server skips only idle touch, keeping all auth/CSRF/policy/expiry checks. Trusted keyboard/pointer activity refreshes session metadata, throttled to one minute. Poll completion no longer causes an unmarked auth refresh. Contract logged. | `d9b4a97`, `cb7de79` | server `web-idle.test.ts` (polling, user activity, expiry); medium M4; E2E idle Overview; live compares SQLite session last-seen before/after polling |
| M5 | fixed | Reproduced wrong initial focus and missing return. Capture the trigger before descendant autofocus; after showModal focus the marked field or first enabled form control; close restores the connected trigger. | `d9b4a97`, `cb7de79` | medium M5; Chromium rename, TTL, Add key, viewer value inspector, admin Create user |
| M6 | fixed | Both navigation tests fail against original Console code. Aborting on navigation now records the same uncertain-outcome transcript in session memory as cancel; response/abort races also retain a record. Redis may already have executed a command; the note asks for a read before rerunning. | `d9b4a97`, `cb7de79` | E2E M6, Console and Workbench; Workbench later INCR verified absent |
| M7 | fixed | Reproduced indistinguishable example placeholders and the misleading blank Find pattern. Placeholder font/style differs; Guided examples say e.g.; the preview explicitly explains that an empty pattern matches every key, and the request matches it. | `d9b4a97` | medium M7; Chromium Guided request/preview equality |

Ranked UX items (same report):

| # | Verdict | Reason / evidence | Commit |
|---|---|---|---|
| 1 Stored bytes first | done | H1/H3/M2/M3: lossless number tokens, raw numeric cells, visible BOM/CR escapes, byte editing for CRLF. No rounded marker needed because JSON views no longer round. | `c87ab1a`, `d9b4a97` |
| 2 Keep TTL | done | M1; KEEPTTL selected by default, expiry removal explicit. | `d9b4a97` |
| 3 Stream inspector → queue operations | deferred | Linking with a prefilled key, pending/lag expansion and checkbox acknowledgement add a new cross-page state/queue interaction; keep this correctness pass small. Existing explicit stream tools remain available. | — |
| 4 Guided teaching | partly done | Clear stale results and success state on input/task changes, suppress late results for changed inputs, and explain every write reply (including EXPIRE 0). TTL already has visible seconds. Key-name completion and a human-duration preview are deferred as new input behavior. | `d9b4a97`, `63e2aa5` |
| 5 Per-tab titles | done | Static view label + configured database name/environment, never Redis data. Chromium asserts title. | `d9b4a97` |
| 6 Dialog focus | done | M5, including focus return. | `d9b4a97` |
| 7 Bulk feedback | done | TTL success gives actual successful count / requested count and seconds; delete gives deleted count; >100/binary TTL limit is visible, and seconds are visible beside the input. E2E UX7 exercises counts and limit. | `d9b4a97` |
| 8 Audit readability | deferred | Burst grouping and responsive column redesign change audit presentation and filtering; need a separate audit-view pass with representative event volumes. | — |
| 9 Overview first paint | done (compact wait) | Waiting charts shrink to 48 px until two samples exist, then return to their normal plotting height. No fabricated samples. Unit UX9. | `d9b4a97` |
| 10 Uniform time formats | deferred | A cross-page convention change is broader than the data-correctness fixes; stored numeric text is now always present where timestamps are inferred. | — |
| 11 Visual polish | deferred | Readout/button restyling is a separate design change with no data-safety benefit in this pass. | — |

Three cheap related Low fixes: examined-key counts are capped at the current database size (medium test L4,
599 examined / 465 total reproduction); read-only databases state the database restriction before a role hint
(`policy.test.ts`, L5); Console drafts have undo history with isolated clear operations (`7963b05`,
`review-w2.spec.ts`, L6). The L4 and L5 tests fail against the original source and pass on the fixes.
The remaining Low findings are deferred to a dedicated console/list/accessibility pass: rerun gutter identity,
request-failure gutter statuses, index-based shift anchors, timezone conventions, policy-label polish,
KEYS pattern byte quoting, history-search keys, confirmation/back lifecycle, scan invalidation, key-write
notifications, sign-in error lookup, chart negative ranges, copy announcements and virtual-tree focus.
The report's list-remove duplicate behavior is already accurately labelled "Remove first matching list value";
changing it to exact-index removal requires an atomic server operation and is deferred with that contract.

Full-suite follow-ups (all reproduced by Chromium or a failing unit test):

- **M4, concurrent expiry:** Overview and its metrics stream can return 401 together. Repeated session-end
  notifications cleared the cache again while the public sign-in-methods request was loading. Session teardown
  is now idempotent until a successful sign-in/refresh; logout also marks teardown complete. New
  `apps/web/src/session-expiry.test.tsx` fails before the guard (three provider reads instead of two) and passes
  after it, with sign-in controls usable. Live M4 additionally expires only its own session in
  `/tmp/rc-v02-webfix2/rconsole.sqlite` and asserts the sign-in notice and fields.
- **M5, palette Enter:** synchronous focus return exposed an unconsumed Enter default action, reopening the
  palette after navigation. The palette now prevents that default before navigating; `pages.spec.ts` explicitly
  requires the palette to close before the theme toggle is used.
- **M6, cancellation wording:** retain the existing "may still complete" wording while also recommending a read
  before rerunning. Existing Ctrl+C cancellation coverage checks the actual aborted request.
- **Test synchronization:** the expiry test previously aged a session before its reloaded SPA was ready and
  skipped its intended click (`nav-overview.isVisible()` was false in the trace). It now waits for the key view
  and requires the click. The cancellation test now waits for BLPOP's initial command metadata/policy (Run
  enabled) before Enter and starts its aborted-request waiter immediately before Ctrl+C. The first cold-start
  failure sent no `/cli` request, as verified in its trace.
- **Guided compatibility:** the old continuation test expected a previous result to remain beside changed inputs.
  It now checks that changing the input hides that result, reruns the original pattern, then verifies the exact
  key-browser handoff. No assertion about the executed pattern or returned keys was removed.

The four affected Chromium cases and setup pass together: **6 passed**. The first full run was **489 passed,
4 failed**. The complete rerun after these changes passed all **493** cases, as recorded below.


### Final validation

- `pnpm -r typecheck`: **passed** (shared, web, server and E2E).
- `pnpm --filter @rconsole/web test`: **242 passed**, 22 files. Web **build passed** under the production CSP.
- `pnpm --filter @rconsole/shared test`: **6 passed** (BOM round trips and key identity).
- `pnpm --filter @rconsole/server test`: **661 passed**, 16 topology-dependent tests skipped because the optional
  cluster/sentinel/TLS topology was not running. 47 files passed, 1 skipped. No server implementation changed
  after this gate; later follow-ups were web/session lifecycle and test synchronization only.
- Full `pnpm test:e2e`, protected by the machine-wide `/tmp/rconsole-e2e.lock`: **493 passed**, **0 failed**,
  **0 skipped**, **0 flaky**, 14.5 minutes. This is a complete fresh setup/API/UI/final run after the follow-up
  fixes, not a filtered rerun. The lock was released normally. Final checks found no secret/session-ID/value
  leaks in server logs or captured responses, and only read commands reached 6390.
- Final live Chromium matrix on **:4800**, dev configuration, data directory **`/tmp/rc-v02-webfix2`**:

  | Role | sandbox-e2e | snapshot |
  |---|---:|---:|
  | qa-operator | 11 passed | 11 passed |
  | qa-admin | 12 passed | 12 passed |
  | qa-viewer | 2 passed | 2 passed |

  **50/50 applicable cases passed**, including each High/Medium finding's relevant role, native clipboard paste,
  exact Redis write/readback, manual/automatic list refresh, dialog focus, navigation during blocking commands,
  Guided inputs/results, bulk feedback, and Console undo. The viewer idle case also compared the server SQLite
  session timestamp before/after 32 seconds without input, then expired that exact isolated session and verified
  usable sign-in controls. The 34 role-filtered declarations are intentionally inapplicable (e.g. editing as a
  viewer), not missing coverage; every declared case runs in the unfiltered full E2E suite.
- Live runner: `tests/e2e/playwright.webfix2-live.config.ts`; role and database selected with `WEBFIX2_ROLE` and
  `WEBFIX2_DB`. Six JSON reports and screenshots are in `apps/web/qa-results/webfix2-*` (gitignored). Screenshots
  of exact JSON tree values and Guided results were inspected. Chromium guards passed with no unexpected
  console/page errors or CSP/Trusted Types violations.
- Live fixture writes used `e2e:scratch:w2:*` only on 6411 and 6412. Cleanup scanned for both ordinary and BOM
  names and verified **0 fixtures remain** on each. The full E2E suite used its own disposable 6431 Redis.
  No connection to 6380, no write to remote-6390, no use of the owner's :4000 instance or main `data/` directory.
- Only the fixer's :4800 processes were stopped, by recorded PID (83509, then 12166 after the refreshed matrix).
  The E2E harness stopped its own server and disposable container during teardown. No push.

Limits: H2 closes drafts on observed list changes; an atomic expected-value list operation remains a future
server contract. Non-macOS keyboards and a real screen reader were not qualified in this Chromium/macOS run.

## Round 4 – server (Claude reviewer)

Report: `docs/research/13-v02-server-review-r4.md` (snapshot `release/v0.2` @ `93a5720`; scripts and notes in
`r4-evidence/`). Fixer branch: `feat/v02-server4`. The reviewer found the RESP reader and socket lifecycle sound; the
findings are about the limits around them. Test files: `r4u` is `apps/server/test/unit/review-r4.test.ts`, `r4` is
`test/integration/review-v02-r4.test.ts`; also `unit/{capped,sse}.test.ts` and `integration/topology.test.ts`. Every
finding was first reproduced live on :4600 against the `93a5720` build (the reviewer's scripts with a session cache;
five extra viewer accounts created through the admin API for H1), then each regression test was run against the
`93a5720` source and failed. The fix commit is `0147084`; tests `0999a6e`, `fdbcbd1`, `68fba4a`.

| ID | Verdict | Reason | Regression tests |
|---|---|---|---|
| H1 | fixed | Reproduced live: six viewer accounts opened 16 idle pub/sub streams (the 17th and 18th got 429 "Too many Redis commands are running"). A seventh user (OIDC admin1) then got 429 for CLI `PING`, `keys/scan`, overview and `DBSIZE` on snapshot, and every database in `GET /databases` showed `error`. Even CLI `GET` was refused (403 "Unknown command"), because the command table could not be loaded. **Fix:** dedicated pub/sub and MONITOR sockets take a separate global stream budget (new `policy.maxStreams`, default 64) and never a command slot. SSE streams also have a server-wide cap per class (live: pub/sub + profiler; metrics) beside the per-user caps. Live after the fix, all 18 streams open and every read on every database returns 200. | `r4u` › "an open stream never takes a command slot…"; `sse` › "streams have a server-wide limit per class…"; `r4` › "H1: idle pub/sub streams never block console commands…" (2 command slots, 3 open streams, a 4th refused by `maxStreams`) |
| M1 | fixed | Reproduced live: with two viewers sending 4 concurrent `GET`s for 10 rounds, 42 got 200 and 38 got 429 "pool is busy". One viewer's scan + 4 `PING`s got 40 × 200 and 10 × 429. **Fix:** a bounded FIFO wait (`security/gate.ts`) before 429, for the pool socket, the global command budget and the database-request slots. A request waits at most min(2 s, its timeout), with at most 4 waiters per slot; abort removes a waiter, and a release hands the slot to the oldest waiter. The command deadline starts after the wait, so blocking commands keep their full block time. Live after the fix: 80/80 and 50/50. | `r4u` › "a command waits for a busy pool socket, and for a busy global budget", "the wait is bounded by time, queue length and abort…"; `capped` › "…refuses global or per-pool work after a short bounded wait"; `r4` › "M1: …" (six operators with `BLPOP … 0.3` on a 4-socket pool; two viewers × 4 `GET`s) |
| M2 | fixed | Reproduced live: with 450,000 keys of 43-byte names on 6411, the operator bulk-delete preview got 413 after 402 ms with "reply exceeded 10637 bytes" (the leftover budget, not the cap). **Fix:** SCAN loops that drop their pages (`countMatches`, `bulkDelete`, `analyze`) now cap each SCAN reply on its own (`scanPage` `pageBytes`). A page ends once its key names reach the cap. Only what these loops keep shares one cap-sized budget: the 20-key preview sample, and the key names and prefixes in the analysis report (more gets 413). Key-browser pages, which are returned whole, keep the cumulative request budget. Every 413 names the configured cap; cumulative overflow says "exceeded its combined N-byte read budget". Live after the fix: the preview returned 428 with impact 450,000 in 272 ms, and the confirmed run deleted 450,000 keys in 639 ms. Analysis of 100,000 keys with 200-byte names (about 20 MB of SCAN replies) returned 200, with 89,592 keys sampled within its 10 s time cap. | `r4u` › "per-reply and cumulative overflows report the cap…"; `r4` › "M2: bulk delete preview, bulk delete and analysis…" (64 KiB cap, 4,000 keys, about 270 KB of SCAN replies) |
| M3 | fixed | Reproduced live with the reviewer's slow fake Redis (measured-socket HELLO delayed 3 s). Three streams abandoned after 300 ms subscribed at the fake and were audited `pubsub.start`; a fresh stream on sandbox-e2e then got 429 "Too many open live streams (max 3)". **Fix:** the request's abort signal reaches `dedicated()` and its handshake. After the handshake, the pub/sub and profiler routes check whether the client has gone, and if so close the socket and release the slot (the profiler records `profiler.start` `error`). `openSse` closes at once when the response is already destroyed, and it now also listens for the response's `close`. Live after the fix: the fresh stream opens, no new `SUBSCRIBE` reaches the fake, and no `pubsub.start` is recorded. | `r4u` › "aborting during HELLO rejects at once…"; `sse` › "a client that left before the stream opened…"; `r4` › "M3: …" (three pub/sub streams and a profiler on an in-process slow fake) |
| M4 | fixed | Reproduced live: after a 70 KiB `SET` from redis-cli, the profiler sent `error` `too_large` "Redis reply header exceeded the structural limit" and then `end`. **Fix:** stream events use a retain mode of the RESP reader. Each string keeps at most 64 KiB, and the rest is counted and skipped. At most 256 KiB is kept per event, and wire bytes are not capped. The profiler shows a cut line's last argument with `…`. Pub/sub delivers any oversized message cut, with `truncated`/`totalBytes`, so publishers can no longer end subscribers' streams. Command replies keep the 64 KiB line ceiling. Live after the fix: the profiler shows `SET rc-r4:mon-big yyyy…` followed by `mon-after`. A 17 MiB `PUBLISH` (the reviewer's case, which used to close the stream) now arrives as a 64 KiB preview with `totalBytes: 17825792`, and the next message follows. | `r4u` › "a MONITOR line over 64 KiB is cut…", "a pub/sub message larger than the data cap…", "event mode keeps the start of long strings…"; `capped` › "closes a dedicated stream when one event would retain more than the event limit"; `r4` › "M4: …" |
| L1 | fixed | Reproduced with the reviewer's fakes (`t6`, `t7`): MOVED and ASK to node B, which was in no topology, were followed (`HELLO INCR`, `HELLO ASKING INCR`). Addresses such as `169.254.169.254:80` were accepted. **Fix:** `CappedPool.send` takes a redirect policy. `ClusterConn` allows only primaries of node-redis's topology. When a MOVED disagrees with the slot map, or an ASK target is unknown, it first refreshes the map through node-redis (`_slots.rediscover`, deduplicated and bounded by the command deadline); a target still unknown after that gets 503. A MOVED/ASK reply leaves the socket clean, so the redirected-from socket returns to the pool. Live on the 6420–6428 topology: after an empty slot moved to another primary, 10 viewer `GET`s opened 9 new connections to the old owner on `93a5720`, and fewer than 5 (the first redirect plus rediscovery) with the fix. | `r4u` › "refused targets are never contacted; allowed ones reuse the redirected-from socket"; `topology` › "cl: after a reshard, a MOVED refreshes the slot map…" |
| L2 | fixed (a, c, d); documented (b) | (a) Server metadata reads used the configurable data cap. With `maxReadReplyBytes` at 1024, `COMMAND DOCS` got 413 on `93a5720`. INFO (database list, overview, metrics) and `COMMAND DOCS` now use a fixed, measured 4 MiB cap outside the request budget; `COMMAND` keeps its 2 MiB cap. (b) Replies node-redis reads itself (handshake, `CLUSTER SLOTS`, sentinel, fixed-size scalars) stay unmeasured: node-redis 5.12 has no reply cap. This is now stated in `docs/ARCHITECTURE.md` and the README, and the `resp.ts` header no longer claims more. (c) Every 429 and 413 names the limit that tripped it. (d) One user holds at most half of the global request slots, and waits beyond that share. This was not reproduced live (it needs a multi-million-key database), so the HTTP test uses two slow requests on a fake: on `93a5720`, another user's `PING` got 429. | `r4` › "L2: server metadata reads (INFO, COMMAND DOCS) keep working with the smallest data cap", "L2: one user cannot hold every server-wide request slot"; `r4u` › "the global budget names its limit" |

Contract: no `packages/shared` change. The server behaviour changes are logged in `CONTRACT-CHANGES.md` (bounded
wait before 429, `maxStreams`, cut stream events, 413 wording, redirect refusal).

### Validation

- Regressions against the `93a5720` source: the 10 finding tests in `r4u` (the new `gate.ts` kept so the file
  loads), 2 of 4 in `unit/sse`, all 7 in `r4` and the topology reshard test failed; all pass on the fix.
- `release/v0.2` @ `137d765` (web round 2, including the `X-RC-Background` idle rule) is merged (`a6d2302`); the
  final runs are on the merged tree. `pnpm -r typecheck` passes. `pnpm --filter @rconsole/server test` with the
  cluster/sentinel/TLS topology up: **698 passed, 0 skipped** (50 files; 695 before the L2 split and the merge).
- Full `pnpm test:e2e` under `/tmp/rconsole-e2e.lock` on the merged tree: **493 passed, 0 failed** (14.2 min),
  including the final leak, audit and read-only-proxy checks. An earlier run on the pre-merge tree was stopped with
  SIGINT (its teardown ran and released the lock) so that the merge could be validated instead.
- Live on :4600 (copy of `config/rconsole.dev.json` plus the reviewer's `slow-fake` database): every reproduction
  above, before (`93a5720`) and after. `snapshot`: the fixed command set from `docs/qa/v02-replycap.md` (11
  commands, 15 warm-ups and 50 measured requests each) returned 200 with the expected reply type in every run. The
  two builds were run alternately on the same port, data and config (A/B, two rounds). Latency is unchanged: the
  machine's p50 is bimodal (about 1.6–2.0 or 2.5–3.5 ms) in both builds, and the mean p50 over all 11 commands was
  2.74 and 2.99 ms on `93a5720` and 2.43 and 3.13 ms on the fix. `everyday.mjs` (45 forms) gave the same outcomes
  as round 3, one Redis call each. `remote-6390` was read through the app only: PING, DBSIZE, SCAN, key scan,
  overview, command docs and 4 concurrent PINGs returned 200, and SET got 403.

| Command (ms) | `93a5720` p50 | `93a5720` p95 | fix p50 | fix p95 |
|---|---:|---:|---:|---:|
| GET | 1.94 / 2.23 | 3.65 / 3.85 | 3.20 / 3.30 | 3.84 / 3.83 |
| HGETALL | 3.16 / 3.19 | 3.79 / 4.01 | 3.08 / 3.50 | 4.14 / 4.43 |
| JSON.GET | 3.00 / 3.11 | 4.38 / 3.74 | 1.93 / 3.41 | 3.55 / 4.70 |
| JSON.GET wildcard | 1.71 / 3.38 | 3.42 / 4.08 | 1.73 / 3.12 | 2.13 / 3.59 |
| FT.SEARCH | 1.86 / 3.22 | 3.35 / 3.98 | 1.88 / 3.45 | 3.61 / 4.80 |
| FT.AGGREGATE | 3.21 / 2.97 | 3.90 / 4.54 | 1.92 / 3.36 | 3.50 / 4.38 |
| ZRANGE | 3.53 / 3.19 | 4.22 / 3.80 | 2.47 / 3.00 | 3.75 / 3.62 |
| XRANGE | 2.77 / 3.23 | 4.04 / 3.84 | 2.05 / 3.21 | 3.65 / 4.26 |
| LRANGE | 2.60 / 2.70 | 3.34 / 3.19 | 2.78 / 2.56 | 3.69 / 3.09 |
| SCAN | 3.11 / 3.04 | 3.95 / 4.91 | 3.02 / 2.48 | 3.72 / 3.71 |
| SLOWLOG | 3.29 / 2.63 | 4.17 / 3.61 | 2.67 / 3.03 | 4.76 / 3.58 |

- Data: the 450,000-key and 100,000-key fixtures on 6411 were removed (`rc-r4:*` = 0), and the benchmark fixtures
  on 6412 were removed with `cleanup.mjs` (4 keys and the index). The 6420–6428 topology was removed afterwards. There
  was no connection to 6380, and port 4000 and the owner's data were not touched. Processes were stopped by PID,
  with one exception: the `pnpm` wrapper of the second baseline server was stopped with a pattern match (`pkill -P 1
  -f … -n`) by mistake. It was checked straight away: the only process that could match was that orphaned wrapper.
  The :4000 server and the web agent's E2E server and its wrapper were still running.


## Round 5 – server (Claude reviewer)

Report: `docs/research/15-v02-server-review-r5.md`, snapshot `release/v0.2` @ `2744f73`.
Fixer: `feat/v02-server5`, isolated worktree `redis-console-wt/v02-server5`. No key-edit or web files changed.

| ID | Verdict | Reproduction and fix | Regression tests |
|---|---|---|---|
| H1 | fixed | On the baseline :4600, 8 stalled bodies each from qa-viewer and qa-operator made qa-admin PING/overview return 429 after 2 s. Eight slow COMMAND DOCS readers made the viewer's PING return 429. Admission now runs after body parsing (`preHandler`); serialized payloads release slots in `onSend`, before network writes. Close remains an idempotent abort fallback. Finite upload and read/write inactivity deadlines bound stalled sockets. | `unit/review-r5`: stalled bodies beyond each user's share, pending large responses with paused readers, paced 12 MiB upload; `integration/review-v02-r5`: real import and Redis byte-length verification |
| M1 | fixed | With baseline slots occupied, PING returned 429 while the same PING with `?x=/stream` returned 200 in 5 ms. Exact route templates now identify only metrics/pubsub/profiler SSE and Workbench cancel as exempt. | `unit/review-r5`: full global slots with `?x=/stream`, `?/workbench/cancel`, encoded query and plain URL; all 429, then 200 after work finishes |
| L1 | fixed | Production accepted split /1 catch-all CIDRs; real Fastify injection with an untrusted remote address selected the forged X-Forwarded-For IP. Production now requires narrow proxy ranges (IPv4 /8+, IPv6 /16+, mapped IPv4 /104+), explicit IPs/private aliases, or numeric hop counts. | `unit/config`: split IPv4/IPv6/both-family catch-alls, overlapping ranges and mapped IPv4; accepted narrow IP/CIDR/alias/hop settings |
| L2 | partially valid; hardened | Stalled anonymous bodies had no receive/idle deadline (fixed with H1). **Skipped as a defect: bare TCP and partial headers living forever.** A reading client with the baseline Fastify options observed both close with HTTP 408 at 60 s: Node already supplied a 60 s header timeout. The review script did not consume that response, hiding closure from its client-side flag. Explicit 15 s headers, 120 s receive, 30 s inactivity and shorter keep-alive limits now apply. | `unit/review-r5`: bare TCP, trickled partial headers, trickled anonymous login body, keep-alive and blocked response writes; `unit/config`: finite defaults and invalid timeout rejection |

### Validation

- Before fixes, seven of the initial 43 focused tests failed on the baseline: H1 upload/read variants, two M1
  bypasses, L1 proxy validation and both L2 timeout cases. The paced upload and normal/encoded-query gate controls
  passed already. The timeout tests use resolved config overrides so they fail on socket behaviour, not unknown
  configuration fields.
- Default timeouts: request receive 120 s, headers 15 s, socket read/write inactivity 30 s, keep-alive 5 s plus
  Node's 1 s buffer. SSE keeps its existing heartbeat, caps and lifetimes. Body limits remain unchanged.
- `pnpm -r typecheck`: passed for shared, server, web and E2E.
- `pnpm --filter @rconsole/server test` with the full cluster/sentinel/mTLS topology: **711 passed, 0 skipped**
  in 52 files (107.3 s). All topology ports 6420–6428 and container names were free before setup; the topology and
  throwaway TLS files were removed after the run.
- Focused regression/compatibility run: **46 passed**. The new compatibility tests keep all three SSE classes
  open past a shortened 6 s idle deadline and verify late messages, plus import a value using a paced request of
  exactly 12 MiB and verify Redis STRLEN and tail bytes.
- Live :4600 with the specified dev config/data directory and fresh QA accounts: PING is 200 with 8 stalled
  bodies per account (viewer and operator), for those users and a third admin. PING is also 200 with 8 paused
  COMMAND DOCS readers. With reading clients, all 10 bare TCP connections, 10 partial headers, 10 authenticated
  stalled bodies, 10 anonymous stalled login bodies and 10 unread responses were observed closed after 33 s.
- Live SSE: metrics, quiet pub/sub and profiler all remained open past 33 s with heartbeats, and each received a
  fresh event afterwards; PING remained 200 with all three open. A paced **12,582,912-byte** ops request stored
  **12,582,794 bytes** on 6411 (STRLEN verified); its fixture was unlinked. Remote-6390 app-only PING was 200.
- A separate 95 s baseline Fastify-options check consumed all server responses: bare TCP and partial headers
  received HTTP 408 at **60,006 ms**; the complete-header/stalled-body connection remained open at 95 s and was
  closed by the probe itself. This qualifies L2 rather than repeating its indefinite-header claim.
- The :4600 baseline/fixed servers were stopped by their own recorded node PIDs (22531 and 37339). No connection
  to 6380, no write to remote-6390, and no use of port 4000 or the main checkout's data directory. Manual fixtures
  used only 6411; topology tests used 6420–6428; full E2E uses its existing isolated 6431 Redis and read-only proxy.
- Full `pnpm test:e2e`, under `/tmp/rconsole-e2e.lock`: **493 passed, 0 failed, 0 skipped** (14.2 min), including
  all setup/API/UI/final projects, response and server-log leak scans, SIEM audit output, and the read-only 6390
  proxy assertion. Exit status 0; lock released normally. The E2E harness removed its Redis container and stopped
  its server/proxy; ports 4400, 4600, 6420–6428 and 6430–6431 are free after cleanup.
- Implementation commit `3f6260d`; initial qualification log `7544b81`; this final log qualifies L2 with the
  reading-client evidence and records the complete E2E run. No push. `.env` remains symlinked; `keys.ts`, web and
  shared-contract files are unchanged.

## Round 3 – web (GPT reviewer)

Report: `docs/research/14-v02-web-review-r3.md` (screenshots `review-w3/`), snapshot `release/v0.2` @
`137d765`; fixer branch `feat/v02-webfix3` from `release/v0.2` @ `2744f73`, with `release/v0.2` @ `7daf0f5`
(server round 5) merged before the final runs (`580fc44`). Unit tests: `apps/web/src/components/review-w3.test.tsx`
(`w3u`); E2E: `tests/e2e/specs/ui/review-w3.spec.ts` (`w3`); server: `apps/server/test/integration/checked-edits.test.ts`
(`cas`) and `integration/topology.test.ts`. Each finding was reproduced twice before its fix: by `w3u` (its first 28 tests were run on `2744f73` and 27
failed; the 28th is the ordinary-MessagePack non-regression check; two more came with follow-up fixes found while
reviewing the change: Reload after the key vanished, `b6445bd`, and no overwrite across types from a row editor,
`05e3269`) and live in Chromium, with `w3`
run against the `2744f73` web build on :4800 (all 8 operator cases failed at the finding's assertion: the hash draft
stayed open under a Base64 caption, no conflict for the type change or the moved JSON item, rounded MsgPack, an
unmarked 100,000-character JSON view, a clean JSON modal for a cut hash value, and an enabled line-break path).

Rounds 1, 2 and now 3 each found an editor that wrote something other than what the user saw, or wrote to another
item after a refresh. Besides the client fixes, edits are now **compare-and-set** on the server, so an editor can no
longer overwrite data it did not read, whether or not the browser noticed the change.

| ID | Verdict | Reason | Commit | Regression tests |
|---|---|---|---|---|
| H1 | fixed | Reproduced: `editableBin(value)` was recomputed from refreshed props while the draft stayed, so `REVG` typed as UTF-8 was saved as Base64 (`DEF`) after the field became binary (also CRLF text, and binary → text). The inline editor now keeps the bytes and encoding it opened for the draft's lifetime, and `KeyContent` binds each edit panel to the bytes it opened: a read that shows other bytes for that hash field, list index or score, or none, closes the draft with a notice (generalising the round-2 list rule). Rows are keyed by element, so a reordered page keeps an open draft. An unseen change (after the last read) gets 409 from the server, shown in the row with Reload / Overwrite anyway. | `47f120a` (`fcef3fe` server) | `w3u` › "H1: …" (binary, CRLF and binary → text transitions close the draft with no write; an identical refresh keeps draft, encoding and expectation); `w3` › "H1: …" (refresh and unobserved change on real Redis, bytes compared with HGET and a Console readback) |
| H2 | fixed | Reproduced both: a string editor whose key became a hash sent `SET … KEEPTTL` under the title "Set a hash field"; a JSON draft for `$["items"][1]` overwrote A after an `ARRINSERT`. `KeyEditor` is bound to an immutable opening snapshot (title, form, operation and path list). It compares that snapshot with each later read: another type, or other bytes of the string or document, disables Save and shows the conflict with the current value (Reload; Overwrite anyway only when the type is unchanged). Every save carries `expect`; the server refuses a type change or other bytes with 409. | `47f120a`, `fcef3fe` | `w3u` › "H2: …" (A and B through the real `KeyInspector` refresh, no `/ops` request; overwrite sends the new expectation; 409 UI with diff; Reload closes the editor when the key is gone; delete carries type + bytes); `cas` › "type change …", "concurrent change …" (JSON retarget, LPUSH displacement); `w3` › "H2 A …", "H2 B …" (observed with auto refresh and unobserved, Redis TYPE/HGET/JSON.GET and Console readbacks) |
| H3 | fixed | Reproduced: `9007199254740993` shown and copied as `…992`; `-0` as `0`, ±Infinity/NaN as `null`, a timestamp as `{}`. MessagePack is now decoded by a small bounded decoder (`lib/msgpack.ts`) that keeps 64-bit integers as exact text, keeps map order, duplicate and non-string keys, and writes non-JSON values with explicit markers (`NaN`, `Infinity`, `-0.0`, `Binary("…")`, `Timestamp("…Z")` to the nanosecond, `Ext(type, "…")`). `@msgpack/msgpack` remains for tests only (now a dev dependency). | `47f120a`, `f575e53` | `w3u` › "H3: …" (15 tests incl. uint64 max, int64 min side, float -0/NaN/±Inf/3.0, 32/96-bit timestamps, binary, ext, map keys, view and clipboard); `w3` › "H3: …" and the viewer group (native paste, raw bytes unchanged) |
| M1 | fixed | Reproduced: JSON copy stopped at 100,000 characters (invalid JSON); Console "Show all" and Copy result stopped at 100,000; Tree strings at 10,000 without a marker. Formatter views now end capped output with "… N more characters/bytes not shown (display capped; Copy value copies all)", and Copy value builds the whole representation on click (labelled **Copy preview** for a server preview or a value over 4 MiB; disabled when the format fails). `cliReply` no longer cuts strings, so Copy result is the whole reply; Show all renders up to 2,000,000 characters and names the rest. Tree strings carry an omission marker. | `47f120a` | `w3u` › "M1: …" (JSON copy parses and equals the 120 KB document; console reply whole; tree marker); `w3` › "M1: …" (native paste lengths for JSON and Copy result) |
| M2 | fixed | Reproduced: a hash value cut by the server opened as clean `{"a":1}` JSON. The value inspector now receives `{value, truncated}` from every cell (hash field and value, list, zset member, stream field and value, and conservatively every set member when `truncatedMembers` is set), shows a "Truncated preview" notice, disables JSON/Tree/MsgPack and offers Copy preview. | `47f120a` | `w3u` › "M2: …"; `w3` › "M2: …" and viewer group |
| L1 | fixed | Reproduced on RedisJSON 8.10: `$["a\nb"]` (JSON escape) is a path syntax error; inside `["…"]` only `\"` and `\\` are escapes and controls are literal (verified for LF, CR, TAB, NUL, ESC, U+2028). Paths are generated with that grammar; names with a CR/LF (which a single-line path field cannot hold) are listed disabled as "not addressable here" with a note pointing to the parent or root document; option labels escape controls. | `47f120a` | `w3u` › "L1: …"; `w3` › "L1: …" (TAB, backslash-n decoy and quote paths each write only their own property in real RedisJSON; the LF target is untouched) |
| CAS | done | Structural guarantee requested with this round: see below and `CONTRACT-CHANGES.md`. Before the change the server's schema stripped an `expect` field silently (checked with the `2744f73` schema), so every `cas`/topology conflict assertion fails there. | `fcef3fe`, `630030e` | `cas` (8): same value for every op, concurrent change → 409 + overwrite, type change → 409 (H2 A, key gone, delete, rename), WATCH race injected before MULTI (retry on equal bytes, 409 on different bytes, at most 3 transactions), large value without an expectation, validation, audit without values, a tier without `+@transaction` fails closed; topology: cluster + sentinel same/changed/type, cluster reshard (MOVED restart) and migration (ASK → 503, nothing written) |

### Compare-and-set design

- **What is compared**: the op's `expect` = the Redis `TYPE` the client read plus the SHA-256 of the exact bytes it
  replaces (string value, hash field value, list element, score text, whole JSON document; `null` = absent; type only
  for renames/deletes of collections). The browser hashes the bytes the editor opened (`sha256Hex`, pure TS, in
  shared); the server hashes what Redis returns with node:crypto.
- **Atomicity**: on one exclusive measured socket of the caller's tier: `WATCH key`, `TYPE`, the element read, compare,
  `MULTI`, the op's usual command, `EXEC`. EXEC nil → read and compare again (at most 3 transactions) → 409. Mismatch →
  **409 `conflict`** with `error.conflict` (current value preview and a fresh `expect`). The socket is always closed
  afterwards. No Lua. Cluster: on the key's primary; a MOVED to `WATCH` restarts once on the new owner (round-4
  redirect policy), ASK → 503. Measured-transport limits and the round-4/5 gates apply unchanged.
- **UI**: "This value changed since you opened it" with the current value, a line diff for short UTF-8 values,
  **Reload** (re-read and reopen on the current value) and **Overwrite anyway** (resend with the conflict's
  expectation, checked again; never offered across types). Observed changes show the same notice before a save is
  attempted. Delete and rename show "This key changed since you read it" with Delete/Rename anyway.
- **What it does not cover**: list elements are identified by index and bytes (an LPUSH+LPOP leaving equal bytes is
  not detected); collection renames/deletes compare the type; element removals (HDEL/LREM/SREM/ZREM/XDEL), TTL,
  bulk delete and Guided/console commands carry no expectation. Documented in `SECURITY.md` and the contract log.
- **Deployment**: the operator ACL user needs `+@transaction` (template, topology script, `OPERATIONS.md`). Without it
  checked ops fail closed with 403 + hint. For the live checks the shared sandboxes 6411 and 6412 got
  `ACL SETUSER rc-operator +@transaction` in memory (a container restart reverts it until `dev-setup.sh` renders the
  updated template); 6410 was not changed, so key-inspector edits as operator on sandbox-main fail closed until then.

Behaviour changes worth knowing: string edits with "Keep current expiry" use the typed `string.set` with `keepTtl`
(audited `string.set`, not `cli.exec`); score edits use `zset.add` with an expectation instead of the CLI `ZADD … XX`;
a hash/sorted-set member written from the main editor that is not on the loaded page is expected absent, so an
unseen existing value produces a conflict instead of being replaced. Two older unit tests were updated to the stricter
contract: `review-w1` H1 (a hash draft whose field disappears from a read now closes for good) and `review-w2-medium`
M1 (KEEPTTL through the typed op).

Ranked UX items: 1 (visible editor binding) and 2 (name what Copy copies) are covered above. 3 (Tree scalar type
cues) deferred: a display change for every JSON tree, separate from data correctness. 4 (labels at 1024 px) and 5
(TimeSeries constant-series scale) remain deferred as before.

### Validation

- `pnpm -r typecheck`: passed (shared, web, server, E2E) on the merged tree.
- `pnpm --filter @rconsole/web test`: **272 passed** (23 files); `build` passed. `pnpm --filter @rconsole/shared
  test`: **8 passed** (SHA-256 vectors and WebCrypto cross-check).
- `pnpm --filter @rconsole/server test` with the cluster/sentinel/mTLS topology (ports 6420–6428 checked free first;
  removed afterwards): **722 passed, 0 skipped** (53 files).
- Live, isolated :4800 (`config/rconsole.dev.json`, `/tmp/rc-v02-webfix3`, QA accounts), Chromium via
  `tests/e2e/playwright.webfix3-live.config.ts`: `w3` with qa-operator and qa-admin on sandbox-e2e and snapshot,
  **8 of 8 each**; qa-viewer **1 of 1** on each (read-only group). Every case opens an editor, changes the key from a
  second connection, saves, checks the conflict UI and compares Redis bytes directly and through the Console.
- Full `pnpm test:e2e` under `/tmp/rconsole-e2e.lock` on the merged tree: **502 passed, 0 failed, 0 skipped** (14.8
  min; 493 before plus the 9 `w3` cases), and again on the final tree after the follow-up commits: **502 passed,
  0 failed** (14.7 min), including the final leak, audit and read-only-proxy checks. The lock was released normally.
- Live fixtures used only `e2e:scratch:w3:*` on 6411 and 6412 (0 left, ordinary and BOM-prefixed names checked);
  server tests used their own `rcsrv:*` prefixes and the 6420–6428 topology (removed). `remote-6390` was only read
  through the app (viewer status and a 10-key scan page). No connection to 6380; port 4000 and the main checkout's
  data were not used. The :4800 servers were stopped by their recorded PIDs. No push.

## Final review – web (Claude reviewer)

Report: `<research-dir>/17-v02-web-review-final.md`, reviewed and fixed from
`release/v0.2` `b379a6b` in `feat/v02-webfix4`. All four findings remain valid; none skipped.
Regression files: `apps/web/src/components/review-w4.test.tsx` (`w4u`) and
`tests/e2e/specs/ui/review-w4.spec.ts` (`w4`). Before fixes, the corrected initial 63-case unit spec had
31 failures and 32 passes; M1 (invisible Unicode), M2, L1 and both L2 paths failed as reported.

| ID | Verdict | Reproduction and minimal fix | Regression coverage |
|---|---|---|---|
| M1 | fixed | `cliReply` turned BOM into `\ufeff`, which the shared tokenizer read as `ufeff`. `cliQuote` now encodes every invisible/directional character escaped by `visibleText` as UTF-8 `\xHH` bytes. Rendered command echoes canonicalize valid commands with controls through the byte tokenizer; execution, re-run and history selection keep the original text. | `w4u`: every escaped code point plus literal backslashes/emoji round-trips through `tokenizeCommandLineBytes`; command echo, key display and history selection. `w4`: BOM/ZWSP/CR/NUL/binary keys and values, displayed arguments, native Copy result/paste into Console, SET/re-run and direct Redis byte comparisons. |
| M2 | fixed | Text Copy value returned `formatValue(..., "text")`, so CR/NUL/BOM/bidi/ZWSP became literal display escapes. Complete UTF-8 Text copies now use `displayed.data`; display escaping is unchanged. Binary copies use the existing Base64/hex formats; labelled previews remain bounded. | `w4u`: six exact clipboard cases including CRLF and literal `\u000d`; `w4`: native paste-event clipboard bytes before editor newline normalization, plus binary Base64 decoding. |
| L1 | fixed | JSON detection used `trim()` (discarded BOM), while decoding kept BOM and rejected it. Detection now removes only JSON whitespace, matching the actual parser; BOM-prefixed strings open on Text. Console JSON-tree detection follows the same rule. | `w4u`/`w4`: BOM-prefixed JSON opens on Text with Copy enabled and exact copied bytes. |
| L2 | fixed | A 404 retained React Query's previous value and active mutation controls. The inspector no longer renders its data/action block when missing. `keyOperation` now rejects EXPIRE integer 0 as "This key no longer exists."; PERSIST 0 remains valid. | `w4u`: refresh-to-404 removes stale value/actions; EXPIRE 0 rejects and PERSIST 0 resolves. `w4`: delete during open expiry reports the missing key (HTTP invalidation refetch replaces the form with the missing-key state); a separate manual refresh also hides the stale value and actions. |

Pattern sweep: inspector read/inspect commands, bulk TTL scripts, Guided previews, key completion and
Console follow-up drafts already use `cliBin`/`cliArg`/`cliKey` and inherit the fix. Key anatomy, tree replies,
history search and slowlog command arguments now use parseable quoting where display escaping was ambiguous.
Key-name/selected-key copy paths use original UTF-8 text (binary uses quoted CLI bytes); editors, conflict
paths and request bodies keep the original Bin values. Copy as code tokenizes original byte arguments and
builds language literals; JSON/MessagePack copies use valid JSON escaping. No shared contract or server changes.

Fix commits: `f4c341e` (core fixes and regressions), `2b02273` (binary Text copy and live expiry behavior).

Additional M2 sweep: binary Text also copied bare display escapes under "Copy value". It now displays a
quoted redis-cli argument and offers **Copy as redis-cli**, whose bytes round-trip through the shared
tokenizer; Base64/Hex remain available. Added unit and native clipboard/Console SET coverage. The initial
full-suite run was intentionally stopped during auth setup to include this correction before the final run.

### Validation

- `pnpm -r typecheck`: passed (shared, server, web and E2E).
- `pnpm --filter @rconsole/web test`: **337/337** passed in 24 files; 65 final-review regression cases.
- `pnpm --filter @rconsole/web build`: passed.
- Chromium live `playwright.webfix4-live.config.ts` on **http://localhost:4800**: **7/7** passed with real
  QA-operator login, production CSP, native clipboard writes/paste events, shared tokenizer checks and direct
  Redis byte comparisons. Covered BOM, ZWSP, CRLF, NUL and binary keys/values; result copy, inspector CLI copy,
  binary Text CLI copy, Base64 copy, Console paste/SET/re-run, BOM JSON and both missing-key paths. Reports and
  screenshots: `apps/web/qa-results/webfix4-live.json` and `webfix4-live-artifacts/` (gitignored).
- Live writes used only `sandbox-e2e` (6411); the spec rejects other database POSTs and pins its direct Redis
  port. Exact fixture cleanup checked with `SCAN *e2e:scratch:w4:*`: **0 keys remain**, including leading BOM
  and binary names. Own :4800 server PID **17214** stopped by PID; listener verified gone. No connection to
  6380; port 4000 and `<repo>/data` were untouched.
- First complete locked E2E run: **505 passed, 4 failed**. Three failures were old raw-key selectors (BOM and
  two XSS tests) affected by the intentional redis-cli quoting. Updated selectors; the XSS key-list test now
  also tokenizes the rendered key and compares its bytes to the fixture. The palette test sent Enter before
  observing the filtered option; it now waits for the sole Diagnostics option before Enter. No palette
  product change. All four corrected tests passed **5 consecutive runs each (20/20)** under the lock.
- Fresh complete `pnpm test:e2e`, acquired with the required `/tmp/rconsole-e2e.lock` loop: **509/509 passed**
  (14.9 minutes; zero failed, flaky or skipped). Includes all seven final-review scenarios, corrected older
  selectors, every compare-and-set regression, production-CSP/XSS checks, aggregate secret/audit scans and
  the assertion that **only read commands reached remote-6390**. Standard suite infrastructure used its
  isolated Redis on 6431, read-only proxy on 6430 and server on 4400; normal teardown completed and the lock
  was released. Own server PIDs 13834 (:4400) and 17214 (:4800) verified gone. The server fixer in
  `v02-server6` then acquired the lock and :4400 (PID 47873); that process and lock were left untouched.
  Final repository-wide typecheck passed again.

## Final review – server (GPT reviewer)

Report: `docs/research/16-v02-server-review-final.md`, snapshot `release/v0.2` @ `b379a6b` (scripts and results
in `r6-evidence/`). Fixer: `feat/v02-server6`, worktree `redis-console-wt/v02-server6`. Test files: `r6u` is
`apps/server/test/unit/review-r6.test.ts`, `r6` is `test/integration/review-v02-r6.test.ts` (its constrained-heap child
is `test/integration/upload-memory-worker.ts`). Every finding was first reproduced with the reviewer's scripts, with
their paths pointed at this worktree, on `b379a6b`. No `packages/shared` or web change.

| ID | Verdict | Reproduction and fix | Regression tests |
|---|---|---|---|
| H1 | fixed | `upload-memory.mjs 24` (real `buildApp`, `--max-old-space-size=256`, default limits, one operator, 24 concurrent valid 11 MiB checked `string.set` bodies of 11,534,470 bytes): **SIGABRT** "Reached heap limit", 24 × `ECONNRESET`, sampled RSS 667 MB; control `upload-memory.mjs 1`: 200. **Fix:** a request-body budget (`security/ingress.ts`), reserved in `onRequest` after authentication and before any body byte is read. Every body takes a count, per user and server-wide (new `policy.maxBodiesInFlight`, 256; a user an eighth). A body over 64 KiB also reserves its size, per user and server-wide (new `policy.maxBodyBytesInFlight`, 48 MiB; a user half, at least the 12 MiB body limit). The size is the `Content-Length`, or the route's body limit for a chunked body. A full budget is an immediate 429 naming the limit, and a declared length over the route limit an immediate 413 (with `Connection: close`, as Fastify did). The reservation is held until the response's `close` (success, error, parse failure, receive timeout, disconnect), so buffered, parsed, slot-waiting and running bodies all count. Work slots are unchanged: still taken after parsing, so a stalled upload holds its budget but never a work slot (r5 H1). Small bodies take only a count, so big uploads cannot crowd out ordinary requests. After: 1 × 200, 1 × 409 (same key, `expect: none`), 22 × 429, normal exit, peak heap 66 MB, twice. | `r6` › "H1: concurrent 11 MiB uploads from one and from three operators…" (24 from one operator, then 3 × 8, in a 256 MiB child; no reset, at least one admitted and one refused each time, still serving, exit 0); `r6u` › 6 H1 tests: a user's byte share, the server-wide byte budget with small requests unaffected, chunked bodies at the route limit, per-user and server-wide counts, release on success / parse failure / receive timeout / disconnect and 413 at once, a parsed body waiting for a slot keeps its reservation while a stalled one takes no slot |
| H2 | fixed | `probes.mjs`: an operator's checked edit, paused before its last byte, finished after an admin disabled the account: **200**, Redis `written-after-revocation`; after a demotion to viewer: the same. A disabled admin's paused PATCH `{"role":"admin"}` finished: **200**, the target was admin. **Fix:** the request gate re-runs its session checks (session alive, account enabled with the same role and generation, no new restriction, the route's role) after the body was received (`preValidation`, every request that may carry a body) and after a request-slot wait (`preHandler`). Failure is 401, audited as `auth.revoked` (`denied`, method and route pattern, database id). Typed ops check again right before they run, and a checked edit right before `MULTI`, after its reads. Admin PATCH re-checks the acting admin for every change, not only after a password hash. After: all three get 401, Redis keeps `opened`, the target stays viewer. | `r6` › "H2: a checked edit whose body completes after {disabled} / {role: viewer}…", "H2: a disabled admin cannot finish a paused PATCH…", "H2: an account disabled while its checked edit reads is refused before MULTI…"; `r6u` › the same on a test route plus the admin PATCH, and "an account disabled while its request waits for a work slot gets 401…" |
| M1 | fixed | `probes.mjs`: on the real WATCH socket, another connection replaced the string with a hash right before `STRLEN`, or right before `GET`: **502** `redis_error` WRONGTYPE, also over HTTP; right before `MULTI`: 409. **Fix:** a `WRONGTYPE` (or RedisJSON's "Existing key has wrong Redis type") from the element read after `TYPE` means a concurrent type change. The server sends `UNWATCH` (which clears the touched flag) and reads again under a new `WATCH`, within the existing 3 attempts. Then it answers the normal 409 `conflict`; when the type is still changing, the 409 has no `current.expect`. Every other Redis error stays what it was. After: 409 `reason: 'type'`, `current: {type: 'hash'}` in all three cases and over HTTP, audited as a denied conflict; the other writer's hash survives. | `r6` › "M1: … 409 type conflict over HTTP…", and for every element read (string `STRLEN`/`GET`, hash `HGET`, list `LINDEX`, zset `ZSCORE`, JSON `JSON.GET`, rename `GET`); "a key whose type keeps changing…" (4 `TYPE`s, no `MULTI`), "after a change and a change back…" (one `EXEC`), "other Redis errors in the read phase stay errors" (control, 502) |
| L1 | fixed | `probes.mjs`: `key.expire` with a stale `expect`: **200**, TTL 120. **Fix:** the ops route checks the raw body: `expect` on an op outside the eight compare-and-set ops is 400 (`expect: not supported for <op> (only … can carry it)`); requests without it are unchanged. The check is on the server, so a future op without compare-and-set refuses it too; no shared schema change. After: 400, TTL -1. | `r6` › "L1: …" (`key.expire`, `key.persist`, `hash.delete`, `set.add`, `list.push`, each with a stale and a `null` expectation; nothing changes; the op without `expect` works) |

### Validation

- **Before the fixes:** with `apps/server/src` restored from `b379a6b` in this worktree, 26 of the 27 new tests failed
  on their assertions: 24 × `ECONNRESET` from the OOM-killed 256 MiB child; 200 instead of 401 (paused body,
  paused admin PATCH, revocation during the reads, slot wait); 502 instead of 409; 200 instead of 400; no early 429.
  Three `r6u` tests that check the budget's accounting and release fail there because the budget does not exist.
  The 27th is the control that other Redis errors stay 502, and it passes on both. A later guard test (a body
  finished and abandoned at once) passes on both: it covers a hardening change. The post-body check runs for every
  request that may carry a body, not only while its reservation is held; Fastify runs `preValidation` before the
  `close` event in practice.
- **Changed test:** `integration/workbench` › "a bulk delete stops between batches…" mocks `sessions.alive` to fail
  after N calls. The request gate now makes two checks before the handler, so N went from 1 to 3; the test still stops
  the delete between batches.
- `pnpm -r typecheck`: passed (shared, server, web, E2E). `pnpm --filter @rconsole/server test` with the
  cluster/Sentinel/mTLS topology: **751 passed, 0 skipped, 0 failed** (55 files; the reviewer's baseline was 702
  passed + 20 skipped). Without the topology: 731 passed, 20 skipped. `pnpm --filter @rconsole/shared test`: 8 passed.
  Repeated runs of `r5`/`r6u` (5×) and `r6` (4×) were stable.
- Full `pnpm test:e2e` under `/tmp/rconsole-e2e.lock` (queued behind another session's run): **502 passed, 0 failed**
  (14.9 min), including the final leak, audit and read-only-proxy checks. Exit 0; the lock was released normally.
- **Live on :4600** (`config/rconsole.dev.json`, `/tmp/rc-v02-server6`, fresh QA accounts; sign-ins cached because
  provisioning used up the 10/min sign-in limit): the reviewer's `revocation.mjs` returned 401 for the delayed
  checked edit, and Redis kept `before`. `admin-revocation.mjs` returned 401, and the target stayed operator. Both
  denials appear in the audit log as `auth.revoked`. A burst of 24 concurrent 11 MiB checked uploads from qa-operator
  gave 1 × 200, 1 × 409 and 22 × 429, each refused in about 100 ms. 12 uploads each from qa-operator and qa-admin gave
  4 × 409 and 20 × 429. A paced upload of exactly **12,582,912 wire bytes** took 19.1 s and returned 200; 12,582,788
  bytes were stored. Metrics, quiet pub/sub and profiler SSE streams all returned 200 and were still open after 36 s
  with 7 heartbeats each; a later publish was received and the profiler stayed alive. `remote-6390` was read through
  the app as qa-viewer only: PING, DBSIZE, a 10-key scan and the overview all returned 200.
- **Latency:** the `b379a6b` build and the fix were run alternately on the same port, data and config. Over the same
  7 requests (CLI PING/GET, key read, key scan, plain and checked `string.set`, overview), the mean p50 was 3.88 and
  5.15 ms for `b379a6b` and 4.64, 5.43 and 4.64 ms for the fix. That is the machine's bimodal noise (another session's
  E2E was running). In-process A/B (`app.inject`, 1,500 requests each, three interleaved rounds): CLI PING p50 was
  0.154–0.168 ms before and 0.164–0.189 ms after. A body-carrying request costs about 0.02 ms more: one
  session re-check takes 11 µs, and a reservation 0.08 µs. Key read and overview showed no difference.
- **Topology:** at first, ports 6420–6428 were held by `rcsrv-*` containers this session had not started, and
  `RC_TOPO_PASSWORD` was not in its environment, so they were left alone. After every other session had finished, the
  coordinator confirmed they were orphaned. No local client was connected to them, so `topology.sh down` removed them.
  A fresh topology with this session's own password then ran the full suite (751 passed, 20 of them topology tests).
  A temporary, uncommitted check also ran the M1 retry path on the cluster and Sentinel connections: a type change
  before `STRLEN` gave 409, and a change and change back gave one `EXEC`. The topology and its TLS files were then
  removed (`topology.sh down`); ports 6420–6429 are free.
- **Not changed (observation):** the reviewer's `audit-type-canary` probe shows that a key-level conflict echoes the
  client's own `expect.type` (at most 64 characters) in the 409 message, and from there in the audit detail. This is
  the same on `b379a6b` and was not raised as a finding. It is client-supplied text, not Redis data, and is JSON-escaped.
- Data: the fixtures used only `rcsrv:s6*`/`rcsrv:r6*`/`rc-v02-server6:*` on 6411; 6411 and 6412 were scanned
  afterwards and none were left. Nothing was written to 6412. There was no connection to 6380, `remote-6390` was read
  through the app only, and port 4000 and the main checkout's data were not used. The :4600 servers (fix: node PIDs
  1222 and 16789; baseline A/B: 11786) were stopped by PID. The empty temporary data directories of the reproduction
  scripts and the A/B benchmark were removed with `rmdir`. Evidence and adapted scripts are in
  `/tmp/rc-v02-server6-evidence/`. No push.

## Fix verification – server (GPT reviewer)

Report: `docs/research/18-v02-server-verify.md`, verifying the final server review's fixes at `release/v0.2` @ `62a5c04`
(scripts and results in `verify-evidence/`). It confirmed H1, M1, L1 and the original H2 cases fixed and raised one new
High, N1. Fixer: `feat/v02-server7`, worktree `redis-console-wt/v02-server7`. Test files: `n1` is
`apps/server/test/integration/review-v02-n1.test.ts`, `n1u` is `test/unit/review-n1.test.ts`, `topo` is
`test/integration/topology.test.ts`. N1 was first reproduced on `62a5c04` with the reviewer's `pool-revocation.mjs` and
`late-revocation.mjs`, with their paths pointed at this worktree. No `packages/shared` or web change.

| ID | Verdict | Reproduction and fix | Regression tests |
|---|---|---|---|
| N1 | fixed | `pool-revocation.mjs` (real HTTP and Redis, default pool of four): four operators' `BLPOP`s filled the operator pool; a CLI `SET` from the first operator was still pending after 100 ms; the admin's PATCH `{disabled:true}` returned 200, and the operator's `/auth/me` returned 401. Once the BLPOPs were released, the queued SET returned **200** and Redis held `after-disabled`. A one-line workbench script gave the same (200, successful line). The checked `string.set` control returned 401. `late-revocation.mjs` (a barrier on the return of a real `ctx.redis.conn`): CLI and workbench returned **200** with `after-disabled` stored, and publish returned **200** `receivers: 1`, the subscriber getting `after-disabled`. **Fix:** a database request's `dbScope` builds one synchronous actor check (`actorCheck`, `context.ts`). It requires the session to be alive and a local account to be enabled with the same role and auth generation. That role is the one the command was authorized with, so it is still sufficient for the command's class. The check is passed as `SendOpts.stillAllowed` with every command the request sends, with its exclusive exchanges and with its stream sockets. The transport evaluates it immediately before the command's bytes are written. In the measured transport the check sits in `CommandSocket.send`, beside the abort, deadline and budget checks, in the same synchronous step as the write. It therefore runs after the pool, command-budget and connection waits, on every MOVED/ASK attempt, and for every command of an exclusive (checked-edit) exchange. Stream sockets check before SUBSCRIBE/PSUBSCRIBE/MONITOR. On node-redis paths (fixed-size replies such as DEL, EXPIRE and HSET of typed ops), the check runs on the acquired, ready client right before the command is queued. Cluster and sentinel go through node-redis's `_execute`, which runs that callback again on each redirect or master rediscovery. Reads marked read-only skip the check: CLI read-class commands, key lists, key reads, memory analysis, and stream and time-series reads, which read the metadata of up to thousands of keys. A refusal sends nothing and drops the socket. It releases the pool and command slots and returns 401 `unauthenticated` ("…; the command was not sent."). It is audited once per request as `auth.revoked` (denied, method, route pattern, database), next to the route's own denied event. A refused workbench line becomes an `unauthenticated` result (audited as denied), and later lines are not run. Bulk delete stops and reports what it had deleted. The request gate's re-checks, the ops pre-check and the checked edit's pre-MULTI check are unchanged. After: `pool-revocation.mjs` gives CLI 401, a workbench `unauthenticated` line and checked op 401; Redis keeps `opened` in all three. `late-revocation.mjs` gives CLI 401, a workbench `unauthenticated` line and publish 401 with no message delivered. Ops, bulk delete and admin creation stay 401. | `n1` › "cli: a write queued behind four BLPOPs in the full pool…" and "workbench: …" (a two-line script whose second line is not run; the pool then serves the other operators); "publish: a message whose connection handshake is held… (first connection)" and "(socket connection)": a TCP relay in front of 6411 holds the handshake of the tier's first node-redis connection, or of a new command socket of a connected tier; "fixed-size typed writes on the node-redis pool…"; `n1u` › 5 tests: after a full-pool wait (slots released, the next command works), during the HELLO handshake, a MOVED and an ASK re-dispatch, each command of an exclusive exchange, stream sockets before SUBSCRIBE/MONITOR; `topo` › "node-redis and measured writes check the actor…" for `cl` and `sn`, and "cl: a MOVED re-dispatch checks the actor again on both paths" (stale slot map: node-redis's own redirect, then the measured one) |

### Validation

- **Before the fix** (`apps/server/src` restored from `62a5c04` with `git stash`): all 13 new tests failed on their
  assertions: 200 instead of 401, a successful workbench line, a command sent instead of refused, a delivered message.
  In a first run, two of them failed only because of state left by the test before them. Both were made independent:
  blocked BLPOPs are now detected by the `b` client flag, and the second publish case uses the admin tier. Each then
  failed on its own, also when run alone.
- **Changed test:** `integration/workbench` › "a bulk delete stops between batches…" counts `sessions.alive` calls.
  The fourth call is now the actor check of the first batch's SCAN rather than the next between-batch check, so the
  delete stops one step earlier. The test passes unchanged; only its comment was corrected.
- `pnpm -r typecheck`: passed (shared, server, web, E2E). `pnpm --filter @rconsole/server test` with the
  cluster/Sentinel/mTLS topology: **766 passed, 0 skipped, 0 failed** (58 files), on the tree of the fix commit (only
  documentation changed after that run). Without the topology: 743 passed, 23 skipped. `pnpm --filter @rconsole/shared test`: 8 passed.
- Full `pnpm test:e2e` under `/tmp/rconsole-e2e.lock`, on the fix commit: **509 passed, 0 failed, 0 flaky** (15.1 min),
  including the final leak, audit and read-only-proxy checks (only read commands reached 6390). Exit 0; the lock was
  released normally, and :4400 is free.
- **Live on :4600** (`config/rconsole.dev.json`, `/tmp/rc-v02-server7`, fresh QA accounts; script
  `live-check.mjs`): all 22 checks passed. The operator's CLI PING, SET and GET, a checked `string.set`
  (WATCH/MULTI/EXEC), `key.expire` (node-redis), a key read and a key scan worked. A four-line workbench script and a
  publish (received by a subscriber) worked. The admin read the client list and reset the slow log of `sandbox-e2e`
  (428, then 200 with confirmation). Metrics, quiet pub/sub and profiler SSE streams returned 200 and were still open
  after 12 s with 2 heartbeats each. A later publish reached the pub/sub stream, and the profiler sent `ready`.
  `remote-6390` was read through the app as qa-viewer: PING, DBSIZE, a 10-key scan and the overview all returned 200.
  **Live N1**: five temporary operators were created through the admin API. Four BLPOPs were seen blocked in CLIENT
  LIST; the queued CLI SET was pending; the revoke returned 200 and the actor's fresh request 401. The SET was then
  refused with **401**, the workbench line was refused as `unauthenticated`, and Redis kept `opened` both times. Each
  refusal appears once as `auth.revoked` in the admin audit view. The temporary operators were disabled afterwards
  (there is no delete route).
- **Latency:** on :4600, the p50s over 60 sequential requests each were 3.2 to 4.6 ms (CLI PING/GET/SET, ops
  `string.set`/`key.expire`, a one-line workbench, publish, key read, overview). Another session's E2E was running at
  the same time. In-process A/B (`ab-latency.mjs`): the `62a5c04` source and the fix were loaded in one process with
  `app.inject`, rate limits off, 6 alternating blocks of 300 requests per type. Median p50, before → after: writes
  CLI SET 0.165 → 0.176 ms, ops `string.set` 0.176 → 0.186, `key.expire` 0.189 → 0.203, publish 0.159 → 0.173. These
  are one check of about 10–15 µs (a session and an account lookup). CLI GET 0.169 → 0.165 and PING 0.197 → 0.183
  were unchanged; key read 0.522 → 0.543 is within its block spread (0.44 to 0.57).
- **Reviewer scripts after the fix:** results are above. `pool-revocation.mjs` and `late-revocation.mjs` exited 0;
  their fixtures were removed by the scripts.
- **Topology:** ports 6420–6428 were free and no `rcsrv-*` container existed. The topology was brought up with this
  session's own password and removed with `topology.sh down` afterwards; ports 6420–6429 are free.
- **Not changed (limits):** node-redis writes a queued command on the next turn of the event loop. It waits for
  nothing in between, but the check precedes it by that turn. On node-redis's own cluster ASK path, node-redis queues
  `ASKING` before the callback runs, so a refused ASK re-dispatch can leave one `ASKING` on that node's shared
  connection. That connection uses the same tier user, and Redis applies the flag to its next command only. Pub/sub
  and profiler streams have already answered 200 when SUBSCRIBE/MONITOR is refused, so they get an SSE `error` event
  and close (audited) instead of a 401. A command that was already sent is not undone.
- Data: the fixtures used only `rcsrv:s6:*` (the reviewer's scripts), `rcsrv:n1:*` (tests) and `rc-v02-server7:*`
  (live and A/B) on 6411. A final scan found none left. Nothing was written to 6412. There was no connection to 6380,
  `remote-6390` was read through the app only, and port 4000 and the main checkout's data were not used. The :4600
  server (node PID 91504, pnpm parent 91483) was stopped by PID. The A/B baseline source copy and the empty temporary
  data directories were removed. Evidence and adapted scripts are in `/tmp/rc-v02-server7-evidence/`. No push.

## N1 follow-up – server (GPT reviewer)

Report: `docs/research/19-v02-n1-verify.md` §2, a focused verification of N1 at `release/v0.2` @ `fe01d0f`
(scripts and results in `n1b-evidence/`). It confirmed the original CLI, workbench and publish reproductions fixed and
raised one Medium residual, N1b. Fixer: `feat/v02-server8`, worktree `redis-console-wt/v02-server8`. Test files as in
the previous section: `n1`, `n1u`, `topo`. N1b was first reproduced on `fe01d0f` with the reviewer's `enqueue-race.mjs`,
its paths pointed at this worktree. No `packages/shared` or web change.

| ID | Verdict | Reproduction and fix | Regression tests |
|---|---|---|---|
| N1b | fixed | `enqueue-race.mjs` (real HTTP and Redis). A test-only `preHandler` barrier holds an admin PATCH `{disabled:true}`. The operator's real actor check is wrapped only to record its result and to release the barrier in a microtask. For `key.expire` and an unchecked `hash.set`, the check returned true and the admin's response finished with 200. Only then did the EXPIRE/HSET bytes reach 6411, with the account already disabled. The typed request returned **200**; Redis had TTL 100 and stored `after-disabled`. The CLI HSET control wrote while the account was still enabled. **Cause:** `guarded` (`manager.ts`) checked when node-redis queued the command, and node-redis 5.12.1 writes on a later turn of the event loop (`#scheduleWrite`, `setImmediate`). **Fix:** `measured(args, o)` (`manager.ts`) sends every command that carries `stillAllowed` through `CappedPool.send`, as it already did for console commands and data-dependent replies. This covers standalone `send`, cluster `send` and per-primary targets, and sentinel `send`. There, `CommandSocket.send` checks and writes in one synchronous step. node-redis keeps only fixed-size commands without an actor check: read-only key-list, analysis and diagnostics metadata, and the server's own probes. `guarded` is removed, and those node-redis calls are plain `sendCommand` again. Replies decode as before: the measured reader applies the same type mappings (simple strings, integers, nulls, error replies). **Consequence handled:** cluster per-key deletes (a `key.delete` split by slot, up to 1,000 keys; a bulk-delete page, up to 5,000) fired every command at once on node-redis's pipeline. The measured pool admits `poolSize` commands plus 4 × `poolSize` waiters, so they now run on four workers in slot order (`inSlotOrder`, `keys.ts`), which also keeps each worker on one primary's socket. A refused actor now stops a cluster bulk delete with 401 instead of counting as an undeleted key. **After:** the reviewer's script records the bytes written while the account is still enabled, then the revocation, like its CLI control. | `n1` › 6 tests "key.expire / hash.set / bulk-delete: an account disabled right after the command was handed to its connection (at once / in a microtask) is refused; nothing changes". The reviewer's admin barrier is a callback-form `preHandler`, so a `{disabled:true}` PATCH completes synchronously inside `release()`. It is released right after the command is handed to the operator Conn (`send` returned), at once or in a microtask. Each test requires 401 `unauthenticated`, the data unchanged (TTL -1, field `opened`, all 3 keys), one `auth.revoked`, and a fresh `/auth/me` 401. It also asserts that the account was disabled when the barrier returned. "fixed-size replies decode the same on the measured transport as on node-redis…" covers 36 fixed-size commands under `TM_REPLY`, `TM_BIN` and `TM_STR`: raw values, `Reply` trees and errors are equal, and each measured command was checked once. `n1u` › "every command with an actor check goes through the measured transport…". `topo` (cl and sn) › "the check and the write are one synchronous step" uses the reviewer's trigger at Conn level: a revocation queued in a microtask from inside a passing check must come after the command's bytes, observed on the socket. Cases: EXPIRE, HSET, DBSIZE on a per-primary target, UNLINK. "a revocation right after they were handed over refuses them; nothing is written" (EXPIRE, HSET, UNLINK, DEL). "per-key deletes run on the measured sockets in bounded batches: a 200-key typed delete and a 600-key bulk delete remove every key". |

**Why the refusal tests trigger at the hand-off, not inside the check.** With the fix, the check runs in the same
synchronous step as the write. A release scheduled from inside the check therefore always lands after the bytes, and
the 200 is then legitimate, as in the reviewer's CLI control. The last moment before the write that exists both before
and after the fix is the hand-off to the connection. Before the fix, the check had already passed there and the bytes
were still queued; now the check has not run yet. The `topo` "one synchronous step" test keeps the reviewer's exact
trigger and asserts the order of events instead. The reviewer's "another check right before `sendCommand`" would
still fail both kinds of test.

### Validation

- **Before the fix** (`apps/server/src` restored from `fe01d0f` with `git stash`): the six `n1` hand-off tests failed
  on their assertions with 200 instead of 401. `key.expire` returned 1 with the TTL set, `hash.set` returned 0 with the
  field overwritten, and bulk delete returned `{deleted: 3}`. In `topo`, "one synchronous step" failed on cl and sn
  (`['revoked', 'write after revocation']`). The hand-off refusal failed on sn (the EXPIRE resolved 1) and passed on cl:
  node-redis's cluster client awaits its slot lookup before it runs the callback, so the old check already saw the
  revocation there. The parity, routing and fan-out tests pass on both trees, because on `fe01d0f` every fixed-size
  command still used node-redis. With the fix but an unbounded fan-out (`CLUSTER_KEY_WORKERS` set to 1,000,000), the
  cluster 200-key typed delete got 429 "All 4 Redis connections of this database's operator pool are busy".
- **Caught during the fix:** the first version of the cluster bulk delete added counts with `deleted += await …` from
  concurrent workers. The new topology test reported 150 of 600 (lost updates; every key was deleted). The count is now
  added after the await. This never reached a commit.
- **Changed tests (titles and comments only, bodies unchanged):** `n1` › "fixed-size typed writes on the node-redis
  pool are checked right before they are queued, too" became "…are checked right before they are sent, too". In `topo`,
  "node-redis and measured writes check the actor…" became "fixed-size and console writes check the actor…", and "cl: a
  MOVED re-dispatch checks the actor again on both paths" became "…for fixed-size and console writes". Its fixed-size
  DEL now follows the measured redirect policy; it still makes 2 checks and writes nothing.
- `pnpm -r typecheck`: passed (shared, server, web, E2E). `pnpm --filter @rconsole/server test` with the
  cluster/Sentinel/mTLS topology: **780 passed, 0 skipped, 0 failed** (58 files; 766 before plus 14 new). Without the
  topology, on the fix commit: 751 passed, 29 skipped. `pnpm --filter @rconsole/shared test`: 8 passed.
- Full `pnpm test:e2e` under `/tmp/rconsole-e2e.lock`, on the fix commit: **509 passed, 0 failed, 0 flaky** (15.0 min),
  including the final leak, audit and read-only-proxy checks (only read commands reached 6390). Exit 0; the lock was
  released normally, and :4400 is free.
- **Reviewer script after the fix:** in `enqueue-race.mjs`, expire, hash-set and the CLI control all record
  `actor-check: true`, then `socket-write` with the account still enabled, then the revocation. Each returns 200, which
  is now legitimate: the bytes left before the account changed.
- **Live on :4600** (`config/rconsole.dev.json`, `/tmp/rc-v02-server8`, fresh QA accounts; script `live-check.mjs`):
  all 25 checks passed. qa-operator: CLI PING, SET and GET. Typed `key.expire`, `key.persist`, `hash.set`, `set.add`,
  `list.push`, `list.set` (`{t:'str', v:'OK'}`), `zset.add` and `stream.add` (`1-1`). An out-of-range `list.set` gave
  502 `redis_error`. `hash.delete` and a 2-key `key.delete` gave 428, then 200. A checked `string.set` gave 200 and a
  stale one 409; a checked `hash.set` gave 200. A key scan (with `dbSize`) and a key read worked. A bulk delete of 1,200
  keys gave 428, then 200 `{deleted: 1200}` in 7.6 ms, with none left. `remote-6390` was read through the app as
  qa-viewer: PING, DBSIZE, a 10-key scan and the overview all returned 200. The server logs show only expected
  configuration warnings and the deliberate out-of-range `list.set`.
- **Latency:** in-process A/B (`ab-latency.mjs`): the `fe01d0f` source and the fix in one process, `app.inject`, rate
  limits off, 6 alternating blocks of 300 requests per type. Median p50, before → after: `key.expire` 0.203 → 0.185 ms,
  `key.persist` 0.198 → 0.180, `hash.set` 0.203 → 0.187, `set.add` 0.208 → 0.192, `list.set` 0.188 → 0.182. The
  measured socket writes at once instead of on the next turn of the event loop. Paths without a change: CLI PING
  0.179 → 0.169, `string.set` 0.198 → 0.194, key read 0.528 → 0.493, key scan 0.937 → 0.937 (its DBSIZE is now
  measured too). Live on :4600 (same data directory; fix, `fe01d0f` and fix again; 60 paced requests each), the p50s
  overlapped: `key.expire` 4.94 / 4.69 / 3.78 ms, `hash.set` 4.83 / 4.06 / 3.51, unchanged CLI PING 4.23 / 3.69 / 4.42.
  Cluster (`cluster-fanout.mjs`, 3 alternating rounds on the topology): a 1,000-key typed delete went from 16–45 to
  38–52 ms, and a 5,000-key bulk-delete page from 68–85 to 167–172 ms. Every key was deleted, with exact counts. At that
  rate the bulk delete's 60 s budget covers about 1.7 M keys, above its 1 M key ceiling.
- **Behaviour changes**, all from moving actor-checked fixed-size commands to the measured sockets:
  1. They share the tier's measured pool and the global `maxInflightCommands` budget with console commands. Under
     saturation they wait at most 2 s and then get 429, instead of node-redis's 5 s acquire wait and a timeout.
  2. Without an explicit timeout the measured default is 5 s, not the 15 s ceiling (cluster per-key UNLINK).
  3. A typed write whose client has gone away (`req.redisSignal`) is cancelled, like a console command.
  4. On Sentinel, node-redis no longer re-runs a typed write on a rediscovered master after a failover; the write fails
     (503) and is never replayed. In cluster mode, MOVED/ASK follow the measured redirect policy (known primaries only,
     one retry).
  5. Cluster per-key deletes run four at a time in slot order (slower, see above). A revoked actor stops a cluster bulk
     delete with 401. Before, its refusals counted as undeleted keys, and a one-page delete returned 200 with
     `deleted: 0`.
  6. The previous round's ASKING limit no longer applies to actor-checked commands: they never use node-redis's ASK
     path, and a refused measured ASK attempt drops its socket.

  Read-only metadata reads (the key list's TYPE/TTL/MEMORY USAGE, analysis, diagnostics) and the server's own probes
  stay on node-redis, unchanged.
- **Not changed (limits):** a command that was already sent is not undone. Pub/sub and profiler streams behave as in
  the previous round.
- **Topology:** ports 6420–6429 were free and no `rcsrv-*` container existed. The topology was brought up with this
  session's own password for the targeted runs and the cluster benchmark. The full server suite ran on it while this
  session held `/tmp/rconsole-e2e.lock`, so another job could not start its own topology during that run. The topology
  was removed with `topology.sh down` before E2E; ports 6420–6429 are free.
- Data: the fixtures used only `rcsrv:s6:*` (the reviewer's script), `rcsrv:n1:*` (tests) and `rc-v02-server8:*`
  (live check and A/B) on 6411. The cluster benchmark wrote `rc-v02-server8:fan:*` on the disposable topology only. A
  final scan of 6411 found none left. Nothing was written to 6412. There was no connection to 6380, `remote-6390` was
  read through the app only, and port 4000 and the main checkout's data were not used. The :4600 servers were stopped by
  PID: the fix (node PID 98991 with pnpm parent 98968, later 4435 with 4411) and the `fe01d0f` baseline (node 2942). The
  A/B baseline source copy (`apps/server/.n1b-base`) and the benchmarks' empty temporary data directories were removed.
  Evidence and adapted scripts are in `/tmp/rc-v02-server8-evidence/`; the topology password and the cached QA session
  cookies were deleted from it. No push.

## Final web verification (Claude reviewer)

Report: `docs/research/21-v02-web-verify.md`. M1, M2, L1 and L2 from the final web review are confirmed fixed by byte comparison in Chromium; checked edits (20/20), keyboard-only Console/Workbench and both themes show no regressions.

| ID | Finding | Verdict | Fix / test |
|---|---|---|---|
| N1 (Medium, pre-existing) | The shared tokenizer split on JavaScript `\s`, which includes BOM, NBSP and other Unicode spaces, so pasting a BOM-prefixed key unquoted after `DEL` deleted the look-alike key without the BOM. | fixed | New `isRedisSpace` (C `isspace`: space, `\t`, `\n`, `\v`, `\f`, `\r`) used by `tokenizeCommandLine`, `tokenizeCommandLineBytes` (server execution) and the console highlighter. Tests: `packages/shared/src/commands.test.ts` (3 of 4 fail without the fix). |
| N2 (Low) | The KEYS→SCAN suggestion re-encoded `\xHH` bytes as Latin-1 text, so the suggested SCAN matched nothing. | fixed | `keysToScan` reuses the typed pattern verbatim. Test: `console.test.tsx` › "turns KEYS into a bounded SCAN that keeps the pattern" (fails without the fix). |
| UX note | Copy names joins raw names with `\n`; a name containing CR/LF is ambiguous in the copy. | skipped | Cosmetic; key operations use exact bytes. Left for a later polish pass. |

## Release qualification notes

- **Topology flake, observed once.** `topology.test.ts` › "cl: a MOVED re-dispatch checks the actor again …" failed once in a full server run on `881c181` while other agents were running test servers on this machine at the same time. It was not reproduced in 10 later runs on `e21975d`: 5 runs of the test alone, 3 runs of the whole topology file and 2 runs of the full server suite with the topology up (780/780 each). The test assumes the client's cluster slot map is still stale when it sends; a background map refresh would make the first dispatch go straight to the new owner. This is a test-timing assumption, not a product defect: the product path refused every revoked dispatch in every run. If it recurs, make the test force a stale map explicitly.

## v0.2.1 review – server (Claude reviewer)

Report: `docs/research/23-v021-server-review.md` (snapshot `release/v0.2.1` @ `1188224`). Fixer branch:
`feat/v021-sfix`, worktree `redis-console-wt/v021-sfix`. Test files: `review-v021` is
`apps/server/test/integration/review-v021-server.test.ts`; `bulk-job` is `apps/server/test/unit/bulk-job.test.ts`.
Every finding was first reproduced on `1188224`, live on :4600 and with its regression test. Contract change: list
element references carry `identity` (`docs/CONTRACT-CHANGES.md`).

| ID | Verdict | Reproduction and fix | Regression tests |
|---|---|---|---|
| F1 (Medium) | fixed | **Live:** a qa-viewer plan of 10,000 × `HSET rcsfix:x a … a` (190 tokens, 3.9 MB) returned 200 with all 10,000 lines refused after 845 ms. `/healthz` waited up to 684 ms during the plan, and RSS was 373 MB after it. Six viewer sessions × three databases then held all 16 plan slots, and qa-operator got 429. In process, three operator plans of the same file held about 862 MiB of heap: every line's argv buffers, redacted audit argv and preview. **Fix** (`import.ts`): all four import routes need the operator role. An account holds at most two planned or running imports, and a new plan replaces its oldest unstarted one. One file per account is checked at a time, two server-wide. Planning yields every 200 lines and keeps only each line's text and verdict. The run tokenizes and checks each line again with the plan's command table, so it reaches the same verdict and writes the same audit events. Admission is checked again after the planning awaits. **Web:** the Import tab and its palette entry are hidden for a viewer. Not done: the reviewer's "refuse a plan with no runnable lines" and a byte budget for held plans. With the role gate, the per-account cap and plans that hold only their text (16 × ≤ 4 Mi characters), neither is needed. | `review-v021` › F1 (4 tests: viewer 403 on all four routes; one account with 16 sessions holds two plans and another operator can still plan; worst event-loop gap while planning < 250 ms; three held plans < 40 MiB of heap). `insight` › "refused lines block the start unless skipped; a viewer cannot import". Web `insight.test.tsx` › "is hidden for a viewer…", "shows the Import tab to an operator…", palette entries. |
| F2 (Low–Medium) | fixed | **Live:** 13 qa-viewer sessions started 64 trivial jobs in 528 ms; qa-operator then got `429 Too many analysis jobs are held` (and so would everyone for 10 minutes). Retention was per session and a full table refused even when every entry was finished. **Fix** (`analysis.ts`): each account keeps at most five jobs across its sessions (its oldest finished one is dropped); a full table (64) drops the oldest finished report of anyone instead of refusing; starting is rate limited per account (1/s, burst 3). The slots are taken before anything is dropped. | `review-v021` › F2 "jobs are kept per account (five), and a full table drops finished reports instead of refusing new jobs" (one account, three sessions, six jobs: the first is 404; then 13 accounts × 5 jobs and a late operator all get 200). |
| F3 (Low) | fixed | **Live:** `rcsfix:list = [70,000 × X, secret-B]`; the viewer's page ref for row 0 was `{kind:'list',index:0}`; after an `LPUSH` the full read returned **200 `INSERTED-OTHER`**. **Fix** (`api.ts`, `keys.ts`, `keyDetail.ts`): list references carry `identity`, the SHA-256 of the whole element the page read (LRANGE reads it whole; only the display is cut); the full read compares it after `LINDEX` and answers 409 `conflict`. `identity` is required, so an index-only reference is 400. | `review-v021` › F3 (full read 200 before the push, 409 after it, 400 without identity). `detail` › "F9 retrieves a full list element…" now sends the identity. E2E role matrix `keyElement` row sends it. |
| F4 (Low) | fixed | **Live:** a qa-viewer import of 200 × `XREAD BLOCK 0 STREAMS rcsfix:nostream $` planned with confirmation `none`; after 11 s only 2 lines had been processed (about 1,000 s in total, inside the 15-minute import budget); cancel worked. **Fix** (`import.ts`): blocking lines share `policy.workbenchBudgetMs` (30 s) of total wait, as a workbench script does; once it is used, later blocking lines are not sent (failure code `timeout`, audited `denied`). With F1, viewers cannot import at all. | `review-v021` › F4 (`workbenchBudgetMs` 1000: 8 × `BLPOP … 0.4`; at most 3 run, the rest fail with `timeout` without being sent, and the import ends in < 2.5 s). |
| F5 (Low) | fixed | **Live on the topology cluster** (temporary script, not committed: 50,000 `rcsfix:{bdN}:*` keys, a delete job, logout after 1.5 s), with `inSlotOrder` from `1188224`: in the two rounds that the logout stopped, the audit said `keyCount 45540` and `46080`, but 45,543 and 46,083 keys were gone. **Fix** (`bulkDelete.ts`): workers record the first failure and stop taking work; `inSlotOrder` waits for every worker to settle the command it already sent, and only then rethrows. The job audit, the synchronous bulk delete and the cluster typed multi-key delete now count those commands. | `bulk-job` › "inSlotOrder rethrows the first failure only after the commands already sent have settled", "a job stopped by a revocation reports, and audits, every UNLINK that completed". |

Not in scope (the report's info notes, not findings): shutdown audit gaps for imports and analysis jobs, the typed
index name for prod index drops, the `keyMetaMemorySamples` comment drift, and the sweep of finished delete jobs.

### Validation

- **Before the fixes** (`1188224` source with the new tests): all 7 `review-v021` tests and both new `bulk-job`
  tests failed on their assertions. F1 viewer got 200, not 403. The table filled, so a later plan got 429. The
  worst event-loop gap was 837 ms (limit 250). Three plans held 862 MiB (limit 40). F2's first job was still 200,
  not 404. F3's list ref had no identity. F4 ran all 8 blocking lines (limit 3). F5 had 0 settled commands, not 3.
  The two new web tests failed without the web change. After the fixes: worst gap 27 ms, 18.6 MiB held.
- **Caught while writing the tests:** an interval timer missed the last gap if the response resolved before the
  timer's next callback, so the stall went unseen. The test now waits 20 ms after the response. `userSession`
  with one name in `Promise.all` raced on the users table, so those sessions are created one at a time.
- **Changed tests:** `insight` › "refused lines block the start unless skipped; a viewer can run reads only" now
  checks the viewer's 403 and runs the refused-lines flow as an operator (`KEYS`, `CONFIG SET`, `FLUSHALL` and an
  unbalanced line; 3 denied audits). `detail` › list element read sends the identity. E2E: the role matrix expects
  403 for viewers on the four import routes and sends the list identity. `api/insight` › remote-6390 (viewer cap)
  expects 403 for the import plan. "another session cannot read, start or cancel a job" expects 403 for the
  viewer and 404 for the admin. `ui/insight` › the viewer test now checks that the Import tab is hidden.
- `pnpm -r typecheck`: passed (shared, server, web, E2E).
- `pnpm --filter @rconsole/server test` with the cluster/Sentinel/mTLS topology up: **914 passed, 0 skipped**
  (65 files; `topology.test.ts` 36/36). Without the topology: 878 passed, 36 skipped. Web: **432 passed** (30 files).
  Shared: **20 passed**.
- Full `pnpm test:e2e` under `/tmp/rconsole-e2e.lock`: **633 passed, 0 failed, 0 flaky** (16.1 min, on `0624441`), including the setup, API, UI and final projects (response and server-log leak scans, SIEM audit lines, only read commands reached 6390). Exit 0; the lock was released normally, and ports 4400 and 6430–6431 are free.
- **Live :4600 after the fixes** (`config/rconsole.dev.json`, `/tmp/rc-v021-sfix`, fresh QA accounts). F1: the
  qa-viewer plan got 403. Two qa-operator plans of the 3.9 MB file took 748 ms and 689 ms, with `/healthz` at most
  26 ms and 9 ms. qa-operator then planned on two more databases (200; its oldest plans were replaced), and
  qa-admin2 still got 200. F2: 13 qa-viewer sessions started 65 jobs in 63 s, paced by the start rate limit. The
  account held 5 of them, and qa-operator got 200. F3: the full read returned 200 (70,000 bytes) before the
  `LPUSH` and 409 `conflict` after it. F4: qa-viewer got 403. For qa-operator, the 200 × `XREAD BLOCK 0` import
  finished within 36 s: 6 lines ran for the 30 s budget, and 194 failed with `timeout` without being sent. The
  server log had no errors and no `rcsfix` key names.
- **Topology, F5 with the fix:** 5 of 5 rounds were stopped by a logout after 0.8 s. Each audited `keyCount`
  equalled the keys really gone: 26,088, 26,739, 23,286, 23,541 and 24,469.
- **Behaviour changes:** (1) imports need the operator role on all four routes. A `maxRole: viewer` database,
  such as remote-6390, refuses them for everyone. (2) Two planned or running imports per account; a newer plan
  replaces the oldest unstarted one, whose id then answers 404. One file per account is checked at a time, two
  server-wide (429). (3) In an import, blocking commands share 30 s of total wait, then fail with `timeout`.
  (4) Analysis job starts are limited to 1/s (burst 3) per account. An account keeps five jobs, and its sixth
  drops its oldest finished one; a full table drops the oldest finished report instead of answering 429.
  (5) A list element read needs the reference's `identity`: 409 when the element at the index changed, 400
  without it. (6) After a refused command, cluster per-key deletes wait for the commands already sent (at most
  three, each within its command timeout) before they stop.
- **Data and processes:** live fixtures used only `rcsfix:*` on 6411. Tests used `rcsrv:v021s:*` on 6411, and the
  F5 check used `rcsfix:{bdN}:*` on the disposable cluster. A final scan of 6411 found neither prefix. Nothing was
  written to 6412: plans on snapshot never started. There was no connection to 6380, and port 4000 and the
  main checkout's data were not used. Ports 6420–6428 were free and no `rcsrv-*` container existed before
  `topology.sh up`. The topology ran under `/tmp/rconsole-e2e.lock` with this session's random password and was
  removed with `topology.sh down`; the lock was released before E2E took it again. The :4600 servers were stopped
  by PID: baseline node 52341 (pnpm 52320), then 59300 (pnpm 59278), and the fixed server node 1290 (pnpm 1269).
  Evidence scripts are in `/tmp/rc-v021-sfix-ev/`. No push.
- Commits: `3653257` (F5), `8efccb3` (F3), `2a33bef` (F2), `5294bbc` (F1, F4 server), `0624441` (F1 web), and
  this log.

## v0.2.1 review – web (GPT reviewer)

Report: `docs/research/24-v021-web-review.md` (sections 1, 3, 6; snapshot `release/v0.2.1` @ `3fa23d1`). Fixer
branch: `feat/v021-wfix`, worktree `redis-console-wt/v021-wfix`. Test files: `insight` is
`apps/web/src/pages/insight.test.tsx`, `shell` is `apps/web/src/shell-v021.test.tsx`, `detail` is
`apps/web/src/components/detail.test.tsx`, `serialized` is `apps/web/src/lib/serialized.test.tsx`, server `detail` is
`apps/server/test/integration/detail.test.ts`. Each finding was checked against `3fa23d1` first; every new web
regression test below was run against the `3fa23d1` source of the files it covers and failed there (L2's viewer test
and the bounds of the pure parsers excepted: they check an absence or new modules). Contract change: the typed op
`stream.consumer.delete` (`docs/CONTRACT-CHANGES.md`).

| ID | Verdict | Reproduction and fix | Regression tests |
|---|---|---|---|
| M1 (Medium) | fixed | **Valid.** `IndexWizard.tsx` left the key type, prefix, folder and "Forget the key" controls enabled while sampling, and a sample response was applied whatever the source had become; `spec` used the current prefix. With the old source a held `/search/sample` for `a:` followed by a change to `b:` produced `FT.CREATE … PREFIX 1 b: SCHEMA name TEXT` (a:'s schema). **Fix:** the source controls are disabled while sampling; every source change takes a new generation and clears the sample, its source and the schema rows; a sample request keeps its generation and source, and a late answer for an older generation is dropped (no schema, no error, no step change); the review step lists a problem, which disables Create, when the schema was not sampled from the current type and prefix. | `insight` › "wizard: the schema belongs to the source…": "locks the source controls while sampling", "drops a late response after a prefix change", "drops a late response after a key type change, and going back to change the source clears the schema" (3 tests; on `3fa23d1`: controls enabled, and both late responses were applied). |
| M2 (Medium) | fixed | **Valid.** `multiSeriesOf` sliced at 12 series, `table()` at 1,000 rows and 40 columns, and `iteratorNode` stopped at depth 40, all silently. **Fix:** bounds unchanged. `multiSeriesOf` returns `{series, total}`; tables return `omittedRows` / `omittedColumns`; a too-deep profile iterator becomes a "deeper iterators not shown" node. `RichReply` shows a persistent warning notice ("Showing 12 of 13 series. 1 not drawn. Narrow the FILTER to chart them.", likewise "1,000 of N rows", "40 of N columns") with **Show the raw reply** (the console/workbench switches that result to its Reply/Tree view, which is complete). The Search tool's tables show the notice without the button (it has no raw view; its text says how to narrow the query). | `insight` › "rich view bounds are disclosed" (13-series TS.MRANGE: 12 sections, the notice, the 13th only in the raw view; 12 series: no notice; 45 columns: "40 of 45 columns") and `richReply.test.ts` › "bounded readings count the series, rows and columns they leave out" (13 series, 45 columns, 1,200 rows). On `3fa23d1`: no notice. |
| L1 (Low) | fixed | **Valid.** `current = all.find(selected) ?? shown[0]`: a selection hidden by the search still drove the detail and Insert. **Fix:** the detail is the selected command only while it is listed, otherwise the first listed result (groups in name order); a hidden selection is forgotten, so clearing the search does not bring it back. | `shell` › "command helper selection follows the filters" (search HSET → select → search GET: HGET, the first listed, is selected, shown and inserted; clearing keeps HGET; a group filter that hides GETEX resets to HGET). Both failed on `3fa23d1`. |
| L2 (Low) | fixed | **Valid.** The inspector had pending/claim/ACK only; consumer delete existed nowhere, and group create/destroy only on Diagnostics › Streams. `commands.ts` already classified `XGROUP|DESTROY` and `XGROUP|DELCONSUMER` as write + confirm, and `stream.group.create` / `stream.group.destroy` existed. **Fix:** new typed op `stream.consumer.delete` → `XGROUP DELCONSUMER` (write, confirm, group and consumer by bytes, audit redacts them). Inspector, writers only: per consumer **Delete… (N pending)**, whose server confirmation carries a note with the pending count of the last refresh, and whose outcome reports Redis's own count ("Redis dropped 2 pending entries"); **Destroy group … (N pending)** for the selected group (confirmed, note with consumers and pending); **Create a consumer group** at `$`, `0` or a validated entry ID with optional MKSTREAM, showing the exact `XGROUP CREATE` before it runs. Group create keeps the existing policy (no confirmation outside prod). | Server `detail` › "L2 consumer delete is confirmed, operator-only, binary-exact and reports the dropped pending count" (viewer 403; 428 then 200 `{t:'int', v:'2'}`; binary group and consumer; then create at `1-0`, create with MKSTREAM on a new key, destroy confirmed). `preview.test.ts` › XGROUP DELCONSUMER preview and bytes. Web `detail` › "L2 inspector consumer delete and group lifecycle" (3 tests: bytes and note; destroy + create with ID and MKSTREAM; viewer sees no controls). |
| L3 (Low) | fixed (PHP, MsgPack ext, Java structure) | **Valid.** PHP and Java were detected only; MessagePack extensions were shown as `Ext(type, "base64")` with no summary. **Fix:** `lib/phpser.ts` parses `serialize()` output (N, b, i, d, s, a, O, C, E, r, R) into plain records and prints it `var_dump` style: exact integers, the float token as written, protected/private property names, references as "copy of / reference to value #n" (never followed), `C:` payloads as bytes, enums as `Class::Case`. `lib/javaser.ts` reads the Java serialization grammar (class descriptors with name, serialVersionUID, flags and fields; proxies; all primitives; strings including long strings in modified UTF-8; arrays; enums; classes; block data; resets; handle references) and prints the object graph with `#n` handles; `writeObject` / block-mode `Externalizable` data is shown as its block bytes and values; protocol-1 Externalizable data and serialized exceptions are refused with a message. Neither loads a class or runs anything. Bounds: depth 128 (PHP) / 64 (Java), 100,000 values, every length and count checked against the remaining bytes before it is read, the formatter's 4 MiB cap, and trailing bytes refused. The **PHP** / **Java** tabs appear only for values detected as such, are structured (off for truncated previews) and carry a note saying nothing is deserialized. MessagePack extensions print as `Ext(5, 1 byte, 0x2a)`, and the viewer lists uninterpreted extension types (the timestamp type is read). Java was not deferred: the fixtures cover every primitive type, shared and self references, enums, arrays, collections with `writeObject` data, boxed numbers and dates. | `serialized` (12 tests) against real payloads made with PHP 8.3 (`php:8.3-cli-alpine`) and Temurin 21 `ObjectOutputStream` (described in the file header): exact var_dump output for scalars, an associative array with 9007199254740993, an object with three visibilities, `r:`, enum, `C:` and binary strings; the Java object graph line by line, a NUL string, HashMap/Integer, Long, Date, String[]; bounds (lying lengths, truncation at every 37th byte, unknown handles, 2^63 string lengths, 2^31 arrays, exceptions, nesting, element count); MsgPack ext text and types; tabs only for detected values, inert rendering, disabled on truncated previews. `review-w3.test.tsx` MsgPack extension expectation updated to the new text. |
| L4 (Low) | fixed | **Valid.** The profiler had Copy only. **Fix:** **Download shown commands** saves exactly the Copy text (the shown lines of the already bounded buffer) as a Blob with the static name `redis-profiler.log`; the object URL is revoked after a second. No new capture, permission or server call. | `shell` › "profiler log download" (static name, opaque blob URL, exact text, anchor removed, URL revoked). Failed on `3fa23d1`. |
| L5 (Low) | fixed | **Valid.** The drawer showed one tool at a time. **Fix:** optional **Side by side** (drawer bar toggle and a Preferences choice, validated presentation preference `drawerSplit`, off by default): the Console on the left and the Command helper or Profiler on the right (the helper when the Console tab is chosen); on the Console page only the second tool. Each pane is a `tabpanel` labelled by its tab, the DOM and focus order is Console then the second tool, the keyboard resize is unchanged, and inserting from the helper fills the visible Console and focuses it without closing the helper. In a half-width pane the helper stacks its list over its detail. | `shell` › "lays out one tool by default, or the Console beside the helper or profiler", "side by side shows the Console and the helper together, in focus order, and insertion keeps both" (insert fills the Console editor; profiler replaces the helper; ArrowUp resize; back to tabs). Failed on `3fa23d1`. |
| Copy | fixed | **Valid.** Preferences said "Scan sizes … are deployment policy", but the threshold is the user's **Keys to scan**. Now: "The server sets the most keys one key-browser scan may cover … How many keys a scan covers, up to that limit, is your choice: **Keys to scan** at the bottom of the key list." | `shell` › "preferences page copy". Failed on `3fa23d1`. |

Not changed: the report's other partial items (F23/F24 deferred by agreement, geo/graph renderers, codecs beyond the
three above).

### Validation

- `pnpm -r typecheck`: passed (shared, server, web, E2E).
- Web: **459 passed** (31 files; 432 before). Shared: **20 passed**. Server: **879 passed, 36 skipped** (65 files;
  the 36 are `topology.test.ts`, whose cluster/Sentinel/mTLS topology was not started for this web-side change), with
  the new `detail` › L2 test and the DELCONSUMER preview assertion.
- Full `pnpm test:e2e` under `/tmp/rconsole-e2e.lock`: **633 passed, 0 failed, 0 flaky** (16.1 min, on `0451534`;
  the later `89706e1` only changes the side-by-side Console tab's title). Exit 0; the lock was released.
- **Live :4800** (`config/rconsole.dev.json`, `/tmp/rc-v021-wfix`, production build, accounts from
  `scripts/qa-accounts.mjs`), Chromium at 1440×900 through a Playwright harness (`/tmp/rc-v021-wfix-scripts/live.mjs`),
  on **sandbox-e2e and snapshot, light and dark**: 45 checks per combination, **180/180 passed** on the final build
  (and 176/176 on the build before the last two commits). Per fix and role: M1 (qa-operator) held the real
  `/search/sample` response: the prefix and type controls were disabled; a forced change event (re-enabling the input
  from the page) still dropped the late answer for `wfix:src-a:` and `wfix:jsrc:` (HASH → JSON); resampling gave
  `… PREFIX 1 wfix:src-b: SCHEMA … username …` without src-a's fields, and the index was created through the
  confirmation. M2 (qa-viewer) workbench `TS.MRANGE - + FILTER wfix=1` over 13 series: 12 charts, the "Showing 12 of
  13 series. 1 not drawn." notice, and **Show the raw reply** opened the Reply view containing `wfix:ts:12`. L1
  (qa-viewer) HSET → GET: the selected, shown and inserted command was the first listed one. L2: qa-viewer had no
  lifecycle controls; qa-operator deleted `c1` (confirmation note "had 2 pending entries at the last refresh",
  outcome "Redis dropped 2 pending entries"), created `g2` at `1-0` (shown command `XGROUP CREATE wfix:stream g2 1-0`)
  and destroyed it through the confirmation. L3 (qa-viewer) PHP, Java and MsgPack views of the real fixtures, only
  the matching tab offered. L4 (qa-admin / qa-admin2) a 5 s profiler session downloaded `redis-profiler.log` from a
  `blob:` URL with exactly the shown lines. L5 (qa-operator) tabs by default; side by side put the Console left of the
  helper, inserting HGETALL filled and focused the Console with the helper still open, ArrowUp resized by 24 px, and
  the toggle went back to tabs. Preferences showed the new scan-limit copy. No page errors and no
  `securitypolicyviolation` events. Screenshots of each view and theme are in `/tmp/rc-v021-wfix-ev/` (not committed).
- **Server log** of :4800: no errors and no `wfix` key names. 101 warnings were `unavailable` (reads cancelled when the
  harness closed a browser context mid-poll). 2 were `redis_error: NOGROUP`: in 2 of 9 L2 runs, a pending-list refetch
  for `g2` raced its destroy, before the inspector moved to the remaining group. This is benign (the next render uses
  the new group's query), so it is noted, not changed.
- **Data and processes:** live fixtures were `wfix:*` (and the index `idx:wfix:prov`) on 6411 and 6412 only, reseeded
  between runs. A final scan found no `wfix:*` key and no `wfix` index on either. Unit and integration tests used
  their usual prefixes on 6411. Real payload fixtures were made with `php:8.3-cli-alpine` (pulled for this) and the
  local Temurin 21. There was no connection to 6380, and port 4000 and the main checkout's data were not used. The
  :4800 server (node 13511, pnpm 13491) was stopped by PID, and port 4800 is free. No push.

## v0.2.1 fix verification – web (GPT reviewer)

Report: `docs/research/25-v021-web-verify.md`. M1, M2, L1, L2, L4, L5 and the Preferences copy fix verified fixed (L2 including binary group/consumer names, viewer/read-only refusal with zero Redis calls, and unchanged shared command policy).

| ID | Finding | Verdict | Fix / test |
|---|---|---|---|
| M3 (Medium) | The Java structure view built its whole text before the display cap: a class name of up to 64 KB repeated by thousands of `TC_REFERENCE` records turned an 85 KB value into ~682 MiB of process memory; null/reference records also bypassed the 100,000-value budget. | fixed | `javaText` stops at an output budget (the formatter passes its display limit), reference descriptions shorten class names to 120 characters, and null/reference records count against the value budget. Tests: `serialized.test.tsx` › "Java view resource bounds" (2 of 3 fail without the fix; the third checks the capped formatter output). |

## v0.3 follow-ups – server, web, ops (Claude)

Scope: the owner's v0.3 follow-up list (several items found while writing and verifying the install docs). Base
`release/v0.3` @ `0f0e571`; branch `feat/v03-follow`. Industry-standard choices as requested.

| Item | Verdict | Reproduction and change | Commit | Regression tests |
|---|---|---|---|---|
| 1 `trustProxy` hop count | fixed | **Reproduced** with real HTTP reverse proxies (Node proxies that append `X-Forwarded-For` like nginx's `$proxy_add_x_forwarded_for`): with `trustProxy: 1` the audit `ip` of a failed sign-in was the proxy (`::1`), because Fastify 5.12.7 maps a number to "trust nothing". **Fix:** `app.ts` `trustProxyOption` gives Fastify the Express/proxy-addr trust function `(addr, hop) => hop < N`: the client is the Nth entry from the right. `true` stays refused in production, CIDR/alias validation is unchanged, and production now also refuses hop counts above 5 (beyond the chain a count trusts entries the client wrote, like `true`). Docs present both options (hop count when only the proxy reaches the port; the proxy's address otherwise); deploy examples keep `1` with the reason; DECISIONS D18. | `b48d04c` | `integration/trust-proxy.test.ts` (one and two proxies, forged entries through the proxy ignored; count too short/too long; a forged header sent directly: ignored with the address form, believed with a hop count, which is why the port must be reachable only through the proxy; `false`). 4 of 5 failed before. `unit/config` › "refuses hop counts longer than any real proxy chain in production". |
| 2 Third-party notices | fixed | **Valid:** the SPA and the image redistributed MIT/ISC/BSD/Apache code and the fonts without notices. **Fix:** `scripts/third-party-notices.ts` generates `THIRD-PARTY-NOTICES` from the installed production dependencies of the server and the web app (85 packages, transitive) with the licence files each ships, plus both fonts' OFL texts; it fails on a licence outside an allowlist or a package without licence text (node-redis, qrcode-generator and abstract-logging ship none: their upstream texts are in `scripts/third-party-licenses`). Cross-checked against Vite's `build.license` report: all 22 bundled packages are listed. A Vite plugin emits it as `/THIRD-PARTY-NOTICES.txt` (build fails without it); Account → About links it; the image has `/app/LICENSE`, `/app/NOTICE`, `/app/THIRD-PARTY-NOTICES`. CI runs `--check`; the image smoke compares the served and the image copy. | `941d9df` | `unit/third-party-notices.test.ts` (file current; coverage); web `recovery-codes.test.tsx` › About link; e2e `api/headers.spec.ts` › third-party notices, `ui/pages.spec.ts` (link for every role). |
| 3 Audit retention | done | `audit.retentionDays` (default 365, 30–36500, `0` forever). `store/auditRetention.ts` prunes at startup and daily, oldest first, 5,000 rows per transaction, yielding between batches, and audits `system.audit.prune` (deleted, batches, cutoff, days; failures as `error`). Migration 4 narrows the delete trigger instead of disabling it: a DELETE passes only for a row older than the cutoff of an `audit_prune_grant` row that the job inserts and removes inside its own transaction, never for a row younger than 30 days; UPDATE stays refused. Stdout is untouched. Docs: OPERATIONS (`audit`, backups, SIEM), ARCHITECTURE, DECISIONS D08/D19, SECURITY T10. | `090d2ff` | `unit/audit-retention.test.ts` (7 tests: config bounds; UPDATE/DELETE refused; a grant never reaches rows < 30 days or newer than its cutoff; batched prune audited once, no grant left, stdout gets only the prune event; `0`; a second connection never sees a grant; a failed batch rolls back and is audited). |
| 4 `SESSION_SECRET` | done | Never read by the server. Removed from `scripts/dev-setup.sh`, the CI sandbox's mask list (with `set -u` a missing variable would abort), the leak scanner's fixed list (every `.env` value is still scanned) and INSTALL.md. E2E-FINDINGS F-05 is a historical record and keeps its wording. | `d7fdc88` | — |
| 5 Dev ports | fixed | **Reproduced:** root `pnpm dev` started the server on 4000 while Vite proxied to 4300. **Fix:** `scripts/dev-ports.ts` decides both (server: `RCONSOLE_PORT`, else the dev config's `server.port`, else 4000; Vite: `RCONSOLE_WEB_PORT`, else 5173); Vite proxies to it; the server launcher's local publicUrl follows `RCONSOLE_PORT`; root `pnpm dev` (`scripts/dev-loop.ts`) runs both with the public URL defaulting to the Vite origin (OIDC callback through Vite; the sandbox realm accepts 5173–5176, which the dev config now allows as origins). Documented as the one-command loop (AGENTS, README, CONTRIBUTING). The image build stage copies `scripts/dev-ports.ts` (in `941d9df`, caught by a local `docker build`). | `b9b80b2` | `unit/dev-ports.test.ts` |
| 6 Stream acknowledge refresh (429) | fixed | **Reproduced** in a component test: after an acknowledge, a 429 on the pending refresh stayed on screen. **Fix:** every 429 now sends `Retry-After` (1 s; sign-in asks for the refill time of one attempt). `lib/api.ts` retries a 429 on reads only (GETs and the read-only POST routes) up to 4 times with exponential backoff and full jitter (250 ms base, 4 s cap) on top of `Retry-After`, never if the server asks for more than 10 s, abortable; writes (ops, cli, workbench, bulk delete, publish, jobs, auth, admin) are never retried. | `bf7db42` | server `integration/retry-after.test.ts` (3; failed before); web `api.test.tsx` › "429 retries for reads only" (6; 5 failed before), `components/stream-refresh.test.tsx` (failed before). |
| 7 Console Enter race | fixed | **Reproduced:** with the catalog not yet loaded, Enter on `SET` said "unavailable for your role or database". **Fix:** `commandPolicy` takes the catalog state; commands without a shared rule are `pending` ("Loading command info…", or "could not be loaded. Press Enter to try again.") instead of refused. Enter/Run holds the command and runs it once the catalog arrives (unless the draft changed; a failed catalog is refetched). Badge, workbench summary, gutter and tutorials show the state. The e2e prod-sim spec no longer waits for the badge (`07d120b`'s workaround reverted). | `e3bee10` | web `pages/console-catalog.test.tsx` (5; all failed before); e2e `ui/confirmation.spec.ts` (Enter right after load). |
| 8 CI trigger | done | `chore/pub-generic` removed from `on.push.branches`; GENERALIZATION-NOTES updated. | `15a2daa` | — |
| 9 Screenshots | done | Regenerated with `RC_SCREENSHOTS=1 pnpm test:e2e` (the full gated run below): sandbox fixtures (`sandbox-e2e`, `e2e-prod-sim`) and e2e accounts only. | `4c3b789` | `screenshots/screenshots.spec.ts` |

### Validation

- Each regression test failed before its change and passes after it (items 1, 6 and 7 and both TOTP fixes were run
  against the pre-fix source; item 3's trigger and job tests are new behaviour).
- `pnpm -r typecheck`: passed (shared, server, web, e2e).
- Unit and integration: shared **24 passed**; web **481 passed** (34 files); server with the cluster, Sentinel and
  mutual-TLS topology up (6420–6428): **987 passed, 8 skipped** (77 files; the skips are the optional read-only remote
  suite), on the final code.
- Full `pnpm test:e2e` under `/tmp/rconsole-e2e.lock`, with `RC_SCREENSHOTS=1`: **646 passed, 0 failed, 0 flaky**
  (17.9 min, disposable fixture upstream; the final spec saw only read commands reach it). A first run was interrupted
  on purpose (to include `2765ee1`) and restarted from scratch; it had no failures when stopped.
- Live on :4600 and with nginx in front of a second instance: [qa/v03-follow-ups.md](qa/v03-follow-ups.md) (every
  item as viewer, operator and admin where it applies, Keycloak `viewer1`/`operator1`/`admin1`/`nogroup1`, 0 CSP or
  Trusted Types violations, 0 page errors).
- Image: local `docker build` and the CI smoke steps by hand (SPA, `/THIRD-PARTY-NOTICES.txt` as `text/plain` with
  `nosniff`, `/app/THIRD-PARTY-NOTICES` identical to the repository, `server.lock` on the read-only root filesystem's
  `/data`).

## v0.3 review – TOTP (GPT reviewer)

Report: `docs/research/26-v03-totp-review.md` (snapshot `release/v0.3` @ `0f0e571`). Fixer branch: `feat/v03-follow`.

| ID | Verdict | Reason | Commit | Regression tests |
|---|---|---|---|---|
| M1 | fixed | **Reproduced:** a duplicate server start on the same data directory overwrote `server.lock`, failed to bind (exit 1) and left a lock naming its dead pid, so `admin rotate-totp-key` re-wrapped seeds under a key the live server lacked (its sign-ins answered 500). **Fix:** `store/lock.ts` takes the lock exclusively (`O_EXCL`, `wx`) before the database is opened (so before schema migrations and the TOTP re-wrap), with pid, host, start time, boot id and a nonce. A live owner is never displaced: a second server exits 75 and leaves the lock untouched. Stale locks are taken over under a separate `O_EXCL` takeover guard and only if unchanged: process gone, host rebooted, the lock names the starting process (a restarted container, pid 1 again), or the lease (refreshed every 15 s) is older than 120 s (another host, or a reused pid; a live pid's lock is watched one refresh period first, so a suspended server keeps it). Only the owner (nonce) removes it, after SQLite is closed, also on `process.exit`. `rotate-totp-key` holds the same lock for its whole run; `--force` only overrides a lock that cannot be checked. | `d9d3edc`, `2765ee1` | `integration/server-lock.test.ts` (two real servers: B exits 75, lock byte-identical, rotation refused, A still answers sign-in 200; after A stops, rotation runs; B exited 1 before the fix); `unit/server-lock.test.ts` (8: exclusive create, owner-only release, live owner refused also with `--force`, dead pid, own pid, reboot, reused pid, suspended owner kept, other host, unreadable). |
| L2 | fixed | **Reproduced:** after a reset, the new authenticator's valid code in the same step was refused. **Fix:** `resetTotp` clears `totp_last_step` in its transaction, and starting an enrollment resets it; replay protection for an unchanged seed is unchanged. | `bfc216b` | `integration/review-v03-totp.test.ts` (fixed clock: admin reset and CLI reset, then a new seed confirmed in the same step, and the replayed code refused at sign-in; an enrollment over a leftover counter). All 3 failed before. |

### Validation

- M1 and L2 regression tests failed on `0f0e571`'s code and pass now (see the table). The suites above include them.
- Live on :4600: a duplicate start exited 75 with the lock byte-identical, `status` named the running server and
  `rotate-totp-key` refused with 75; after a reset a new authenticator's code was accepted in the same step and the
  replayed code refused ([qa/v03-follow-ups.md](qa/v03-follow-ups.md)).
- Re-checking M1 found the suspended-owner window (a live pid with a lease older than 120 s until its next refresh);
  `2765ee1` watches such a lock for one refresh period before taking it over.

## Publication review – content (GPT reviewer)

Pre-publication content review of the single-commit public tree (`release/public` @ `cd14f30`; read-only, offline).
The report is not published because it quotes the passages it flagged. Fixer branch: `chore/public-prep`.

| ID | Verdict | Reason | Commit | Regression tests |
|---|---|---|---|---|
| P2-01 | fixed | Valid: exact key inventories and namespace shares of the private development dataset survived the name redaction. Exact counts and shares removed; totals rounded ("about 7.5k", "about 8k") where a benchmark needs the scale. | this commit | leak scan |
| P2-02 | fixed | Valid: the private cache layout, a partial key hash and value sizes. Replaced with "a large JSON cache value" and a generic folder description. | this commit | leak scan |
| P2-03 | fixed | Valid: the v0.2 plan described the owner's machine, tunnel, account and instance. Replaced with generic rules; machine details live in the gitignored `AGENTS.local.md`. | this commit | |
| P2-04 | fixed | Valid: an observed private address in a QA record. Removed. | this commit | |
| P3-01 | fixed | Valid: report 01 described third-party vulnerabilities that appear unreported. The exploitable ones (F-VA-2, F-VA-4–6, F-P3-1, F-P3-6–9, F-RC-5) keep their id and severity; mechanism and source locations are withheld pending coordinated disclosure. Documented behaviour and defaults stay. | this commit | |

### Validation
- Leak scan of every tracked file: owner names and paths, every segment and hash prefix of the real key names, `.env`
  values and QA credentials: 0 findings (4 false positives: a test asserting no `/Users/` path, Redis Insight source paths).
- The nine remaining screenshots were opened by both reviewers: e2e fixtures only.

### Round 2 – targeted verification (GPT reviewer)

Snapshot `release/public` @ `20a25cf`. P2-04 resolved. P2-01, P2-02, P2-03 and P3-01 partially resolved: the term scan
above cannot catch arithmetic or semantic disclosure, and the reviewer found an inventory still recoverable from a
command count (three metadata reads per key), an exact live result, a type mix, value sizes and folder names, a
sentence restating the upstream's authorization arrangement, and clues to withheld third-party findings outside their
rows (also in `DECISIONS.md`). Those passages were generalized (command totals rounded to about 22.5k, value sizes
and folder names removed, the hardening and verdict text no longer maps withheld IDs to mechanisms).

### Round 3 – targeted verification (GPT reviewer)

Snapshot `release/public` @ `141f478`. Every round-2 passage resolved; P2-04 and P3-01 resolved. The tree-wide sweep
found the same categories elsewhere: the upstream's Redis identity stated in two reports (R3-P2-01), a private
document size and one hash's cardinality in this log (R3-P2-02), an observed versioned cache path in `DESIGN.md`
(R3-P2-03), and the removed figures reused as literals in a code comment and two mocked tests (R3-P3-01). All
generalized; the test literals are unrelated numbers now (`unit/misc.test.ts`, `console.test.tsx`: passed).

### Round 4 – full read (Claude Sonnet 5.5 and Gemini 3.8 Flash reviewers)

Snapshot `release/public` @ `d981a1d`; GPT was at its usage limit, so two other models read every historical record
paragraph by paragraph. Both confirmed the round-3 fixes. Gemini found nothing further. Sonnet found one P2: a web test
fixture reproduced the private dataset's namespace shares and folder names (now a 126 / 24 / 2 fixture with neutral
names, `Keys.test.tsx`: passed). Its P3 items were also fixed: folder-name literals in QA defaults and tests,
the synthetic 100k benchmark's folder names, remarks about the private dataset's composition, screenshot
attachment ids, a remote password variable name, a stale owner-name note, a breadcrumb next to a withheld third-party
finding, two more unreported third-party source observations (now withheld like report 01's), and a time zone.

### Round 5 – targeted verification (Claude Sonnet 5.5 reviewer)

Snapshot `release/public` @ `6c308bb`. Every round-4 item resolved; no P1 or P2. Its three optional wording items (a
sentence fragment in the parity audit, the round-4 summary's wording, "details withheld" for the two third-party
source observations) were applied.

## Code scanning triage – first CodeQL run on the public repository

CodeQL default setup (JavaScript/TypeScript and Actions) raised 30 alerts on `113157c`. Each was checked against the
code. Fixer branch: `fix/admin-user-rate-limit`.

| Alerts | Verdict | Reason | Commit | Regression tests |
|---|---|---|---|---|
| `js/missing-rate-limiting` on `PATCH /admin/users/:id` (and the same gap, not flagged, on `POST /admin/users`) | fixed | Reproduced: 20 concurrent password resets from one admin all ran an argon2id hash (0 refused); only the per-address limit applied. A per-admin `admin-password` bucket (2/s, burst 10) now guards every request that hashes a password; other edits are not limited by it. | `85c3b8d` | `integration/admin.test.ts` › "password hashing is rate limited per admin" (failed before) |
| `js/missing-rate-limiting` on the `onRequest`, `preValidation` and `onClose` hooks | false positive | Hooks, not routes; the `onRequest` hook is the per-address limiter itself. | | |
| `js/missing-rate-limiting` on sign-in, TOTP verify/confirm, password change, recovery codes, `oidc/start`, ops, publish, search index create/drop | false positive | Each has its own limiter (`loginRateLimit`, per-IP OIDC, `rateLimit(ctx, req, …)`) besides the per-address limit; CodeQL only recognises library limiters. | | |
| `js/missing-rate-limiting` on `oidc/callback`, `totp/enroll`, slow log reset, client list and kill | false positive | Cheap or bounded: the callback rejects unknown, foreign or reused state before any network call (flows come only from the rate-limited start); enrollment writes one row; the admin Redis commands run through the per-user in-flight command slots. All are under the per-address limit. | | |
| `js/incomplete-sanitization` in `QueryEditor.tsx` | false positive | Not sanitization: a pipe character marks the cursor in a completion snippet and only the first one is the marker (the OR snippet `"(\| \| )"` keeps its second, literal pipe). | | |
| `js/incomplete-url-substring-sanitization` in `lib/format.ts` | false positive | Not a URL check: a display label for key names that start with `socket.io`. | | |
| `js/insufficient-password-hash` (6), `js/bad-tag-filter`, `js/double-escaping`, `js/incomplete-sanitization`, `js/bad-code-sanitization`, `js/resource-exhaustion` in tests and QA scripts | false positive (tests) | Test and QA code: SHA-256 builds Redis ACL `#<hex>` passwords (the format Redis requires) and derives throwaway test passwords; the others are deliberate test inputs and assertions. | | |

### Validation
- The regression test failed on `113157c` (20 concurrent resets from one admin, 0 refused) and passes with the fix.
- Server suite 952 passed, 44 skipped (topology and remote suites need their services); PR CI green (unit,
  integration with topology, image smoke, e2e 637 passed).
- Independent check of the fix and of every false-positive verdict (Claude Sonnet 5.5): agreed, nothing at Medium or
  above. Its low items: no server-wide cap on admin hashing (kept: few trusted admins, and the libuv pool bounds
  memory); a search field name containing `|` is mangled by completion (text only; follow-up).

## CI flake – multi-entry dialog ignored Close while the key refreshed

Observed once in six CI runs (public repository PR 1, `ui › detail.spec.ts` › "DETAIL admin › F18"): after "2 of 2
commands completed" the test clicked Close, the dialog stayed open and the next step timed out. Cause: `MultiEntryAdd`
kept `busy` set while it awaited the key refresh after the last command, and the modal ignored Close while busy, so a
Close click during the refresh of a large key (1,202 members here) was dropped, for users as well as the test.

| ID | Verdict | Reason | Commit | Regression tests |
|---|---|---|---|---|
| Flake F18 | fixed | Close is now blocked only while commands are being sent; the refresh may finish behind the closed dialog. | `fix/multi-entry-close` | `components/detail.test.tsx` › "closes once every command has run, while the key is still refreshing (CI flake on PR 1)" (failed before) and "keeps the dialog open while a command is still being sent"; e2e F18 now asserts the dialog closes |


## v0.4 Round 1 – arrays, vector sets, geo, search fields (Claude Sonnet 5.5 reviewer)

Report: `docs/research/27-v04-review-r1.md` (snapshot `release/v0.4` @ `89a15cf`). Fixer branch: `fix/v04-review-r1`
(Claude Opus 5.5).

| ID | Verdict | Reason | Commit | Regression tests |
|---|---|---|---|---|
| H1 | fixed | Reproduced: a case-insensitive MATCH costs value bytes × pattern bytes in Redis's main thread, and the per-request bound counted elements only (5,000 × 4 KiB elements: 257-byte NOCASE pattern 2.4 s, no cap on larger arrays). Search values are now at most 1 KiB and a NOCASE MATCH at most 64 bytes (route and console `argumentRule`), and each search request reads at most 64 MiB of element data divided by its weight (NOCASE MATCH: pattern bytes / 4), sized from `MEMORY USAGE … SAMPLES 5` / ARCOUNT; `next` continues it. The review suggested 32 bytes for NOCASE; 64 was chosen after measuring, since the weighted budget already bounds the request. | `ff0a2e0`, `ec26e1f` | shared `array.test.ts` › "bounds ARGREP search values: at most 1 KiB, and a NOCASE MATCH at most 64 bytes"; server `unit/array.test.ts` › "array search work bound (review v0.4 r1 H1)" (both tests) |
| M1 | fixed | Reproduced: an invalid index or base64 value threw synchronously inside the search form's `onSubmit`, skipping `ActionForm`'s `finally` (button stuck on "Working…", uncaught page error). `ActionForm` now turns a synchronous throw into a rejection, so this and any other form shows the message and re-enables; `inputBin` names the bad base64 value. | `1d09913` | web `array.test.tsx` › "an invalid index or base64 value is reported and the search can be corrected and run" |
| M2 | fixed | Reproduced: `VSIM … COUNT 2 TRUTH NOTHREAD` ran for a viewer (200). `argumentRule` now reads VSIM the way the module parses it and refuses TRUTH, NOTHREAD, COUNT or EF above 1,000, FILTER-EF 0 or above 100,000, a FILTER over 1 KiB and an argv Redis would not parse, with a hint to the inspector. | `eaf3890` | shared `vectorset.test.ts` › "the console bounds VSIM as the inspector does…"; server `integration/vectorset.test.ts` › "console: VSIM runs within the inspector bounds…" (200 before the fix) |
| L1 | fixed | Reproduced (array of exactly the page size, vector-set prefix of exactly the page size): `next` was set and led to an empty page. Arrays check `AROP … USED` after a full page (no extra value read); vector sets ask VRANGE for one more member and cut it. | `8335753` | server `integration/array.test.ts` › "array/range: next starts after the last index…" and `integration/vectorset.test.ts` › "members: exclusive paging…" (exact-full cases); `unit/vectorset.test.ts` › "pageOf names the next start only when VRANGE returned more than a page…" |
| L2 | fixed | Reproduced in a unit test: a member named `WITHDIST` shifted the columns and the map disappeared. Geo options are now read by position after the positional arguments, with their operands; an unparsable argv has no map. | `5dcc7ba` | web `geo.test.tsx` › "reads flags by position, so keys, members and values named like flags are operands" |
| L3 | fixed | Reproduced: `1e999` coordinates and `after: ""` were 502s; array routes on a string key were 502 WRONGTYPE. Coordinates must be finite doubles (measured: Redis accepts `1e99` and `1e-320`, refuses `1e309` and `1e-999`, so a finite check fits better than the suggested exponent cap), "invalid vector specification" maps to 400, paging after the empty member starts at `[\x00`, and the array routes check TYPE first (missing key 404, other types 400). | `08be4eb` | shared `vectorset.test.ts` › "coordinates are finite decimals"; server `unit/vectorset.test.ts` (vrangeArgs, vsetRequestError), `integration/vectorset.test.ts` › "members: …", `integration/array.test.ts` › "array/range: …" (404/400 cases) |
| L4 | fixed | Confirmed by reading and a unit test: the vector-set reads were not retried on 429, and "Copy CLI"/Explain had no vector-set case. | `acde951` | web `api.test.tsx` › "classifies reads…"; `vectorset.test.tsx` › "copies and explains the reads the inspector makes" |
| Gate | fixed | Found by the fix round's own gate (not in the report): `vectorset/element` labelled VLINKS layers by position as if layer 0 came first, but Redis lists the highest layer first (measured: on a 3,000-member set the last entry holds about 32 links, upper layers at most 16; a member on layer 1 of a 3-member set answers `[[], [n1, n2]]`). Whenever a member sat above layer 0, every layer was mislabelled, and past 32 layers the bound would have dropped layer 0. The S2 integration test failed in about 1 in 6 fixture builds (33 of 200 measured) and had passed the integrated gate by chance. `linksOf` now reverses the reply. | `09560d8` | server `unit/vectorset.test.ts` › "linksOf bounds layers and neighbours per layer and counts the rest"; `integration/vectorset.test.ts` › "element: …" passed 12 runs in a row |
| QA | fixed | Found in this round's live QA (viewer, console): every `VSIM` showed "blocked" and Run stayed disabled, although the server ran valid ones (200). The console's command catalog (`GET …/commands`) classifies bare names, and the M2 rule read a bare `VSIM` as unparsable. The rule now leaves argv below VSIM's arity to Redis (which refuses it before running). After the graph merge the same cause showed for `GRAPH.INFO ObjectPool`, `GRAPH.MEMORY USAGE`, `GRAPH.SLOWLOG` and `GRAPH.CONFIG GET` (FalkorDB publishes docs for 18 GRAPH.* commands; bare `GRAPH.INFO` stays blocked by design), so the browser now takes the verdict from the shared rule matching the typed command, as the server's `authorize` does, and the catalog's only for commands without one. | `3b8a41b`, `dfde937` | web `lib/policy.test.ts` › "a shared rule for the typed command decides, not the catalog's verdict on the bare name" (failed before); server `integration/vectorset.test.ts` › "console: VSIM runs within the inspector bounds…" (catalog check failed before) |
| L5 | fixed (wording) / skipped (budget, `array.set` on a missing key) | Reproduced: "you opened a none", "a array", and a prefix note presenting the set size as the match count. Fixed. The 413 for an array holding one element above the per-reply budget matches every other type (a hash with a 17 MiB field behaves the same), and `array.set` refusing to create a key is the documented contract (create with `array.insert` or the create-key form): both by design. | `e357c96` | server `unit/conflict-message.test.ts` › "reads naturally for a key created meanwhile…"; web `vectorset.test.tsx` › "a type conflict reads naturally…", "with a prefix, the page note does not present the set's size…" |

### Validation
- Each regression test failed before its fix and passes after it (the M2 integration test was run against the
  pre-fix `commands.ts`: 200, then 403).
- H1 measured on the sandbox (Redis 8.10.2), 5,000 elements of 4 KiB `a…` against `a…ab` patterns (the worst case):
  NOCASE 9 / 33 / 64 bytes over all 5,000 took 107 / 314 / 589 ms; one capped request (4,360 / 1,453 / 817 elements)
  76 / 92 / 97 ms; case-sensitive 22–32 ms; the now-refused 257-byte pattern 2,442 ms.
- Full e2e on the fix branch: 694 passed, 1 failed, 2 skipped. The failure was ours: the L3 change made array reads
  of a missing key 404, a breaking change logged in CONTRACT-CHANGES, but `specs/api/array.spec.ts` still expected the
  old empty page. Updated in `c78d49a`, which also seeds a small array in the disposable read-only fixture so the array
  reads stay proven through the read-only proxy.
- Server 1025 passed, 44 skipped (fix branch); 1044 passed, 44 skipped after the graph merge. Live QA as viewer,
  operator and admin: [qa/v04-review-r1-fixes.md](qa/v04-review-r1-fixes.md).

## v0.4 Round 2 – arrays, vector sets, geo, search fields (GPT-6.1 Sol reviewer)

Report: `docs/research/29-v04-review-r2-data.md` (snapshot `release/v0.4` @ `79663bb`). Fixer branch:
`fix/v04-review-r2` (Claude Opus 5.5). The reviewer also verified every round-1 fix: M1, M2, L1–L5, the VLINKS
layer order and the console catalog fixes were confirmed; round-1 H1 was found partial (this round's H1 and H2).

| ID | Verdict | Reason | Commit | Regression tests |
|---|---|---|---|---|
| H2 | fixed | Reproduced by the reviewer live: with 50,000 one-byte values after 5,000 values of 4 KiB, the identical request searched all 5,000 (20 MiB, 4.9 times its weighted budget) in 606 ms, eight predicates 1,102 elements in 1,054 ms, and one 8 MiB value was always admitted; the cap came from the whole array's average element size (MEMORY USAGE / ARCOUNT), and Redis reports no byte size for a range. The search no longer runs ARGREP (D22): it reads ARSCAN batches through the measured transport from one 16 MiB budget, each read at most half, matches on the server with ARGREP's meanings (`glob.ts` ports Redis's `stringmatchlen`), and skips by index a value over half the budget. | `c6afbf9` | server `integration/array.test.ts` › "EXACT, MATCH and GLOB … agree with ARGREP on Redis…" (checked to catch a broken range swap and Latin-1 folding), "clustered large values with many small ones elsewhere…", "an element over half the budget is skipped…"; `unit/array.test.ts` › "array search byte bound (review v0.4 r2 H2)" |
| H1 | fixed | Reproduced by the reviewer: a viewer's console `ARGREP … MATCH <64 bytes> NOCASE LIMIT 1` scanned the whole range (619 ms) where the inspector stopped at its cap; LIMIT does not bound work when nothing matches. No argument check can bound ARGREP (no per-range size in Redis), so it is blocked in the console and the Workbench with a hint to the inspector, and the per-argument ARGREP rules are removed. | `31b2c8e` | shared `array.test.ts` › "blocks ARGREP in every form…"; server `integration/array.test.ts` › "ARGREP is blocked in the console and the Workbench for every role…" (failed before: 200) |
| M1 | fixed | Reproduced: Redis repeats the rest of an unparsable filter ("near: …") and the 400 built from it was stored verbatim in the audit detail (canary found in the JSON line and the audit store). The message now names the character position, computed from that suffix's length; Redis usually repeats the whole filter, so it is often "character 1". | `913e6bf` | server `unit/vectorset.test.ts` › "maps request-shaped Redis errors…"; `integration/vectorset.test.ts` › "search: VSIM by member…" (canary absent from response, audit lines and store) |
| M2 | fixed | Reproduced: a 600,000-character attribute made the member panel 413 ("combined 1104-byte read budget"). The measured transport zeroed the request's whole budget on any reply failure; a reply over its own per-reply cap now keeps the bytes it charged, while a spent budget and every other failure still end the request. | `76e4555` | server `unit/capped.test.ts` › "a reply over its own cap keeps the bytes it read charged…"; `integration/vectorset.test.ts` › "element: attributes over maxValueBytes are flagged and the embedding and neighbours still read" (failed before: 413) |
| L1 | fixed | Reproduced in a component test: Find similar on the empty member name left Search disabled. A chosen member that cannot be typed (binary or empty) stays a fixed selection, shown as "(the empty name)". | `f8ad201` | web `vectorset.test.tsx` › "Find similar works for a member whose name is empty" |
| L2 | fixed | Reproduced: an append at cursor 18446744073709551614 with two values was a 502 `insert index overflow`. The insert probe refuses it with 400 before anything is written; one value still fits. | `12ea2d9` | server `integration/array.test.ts` › "array.insert past the last index is a 400…" (failed before: 502) |
| E2E | fixed | Found by the full e2e on the merged tree (not in the report): with the catalog verdict fix (`dfde937`), a viewer's refused `GRAPH.QUERY` read "unavailable for your role or database" and `ui/graph.spec.ts` failed; the browser now words role and production refusals as the server's `authorize` does. | `111d600` | web `lib/policy.test.ts` › "names the role a command needs and the role you have…" |

### Validation
- Each regression test failed before its fix and passes after it, except H2's integration tests, which assert the new
  byte bound (the old code made no such promise; the reviewer's live reproduction is the evidence against it).
- The reviewer's worst case on the new search (Redis 8.10.2, 5,000 values of 4 KiB `a…`, through the route): a 64-byte
  NOCASE MATCH covered the 20 MiB range in 2 requests, the worst 162 ms; eight such predicates 168 ms; GLOB
  `a*a*a*a*a*a*a*b` 105 ms. Redis only copies bounded batches (ARGREP held its main thread 589–1,054 ms on this range).
