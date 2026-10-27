# Redis Console v0.4

New data types from Redis 8 and FalkorDB, each with the same bounds, roles and confirmations as the rest of the
console.

## What's new

**Native arrays (Redis 8.8 and later)**
- An array inspector: the element count, length and insert cursor, then the elements page by page (25 to 1,000), with
  the empty stretches between indices made visible ("⋯ 1,000 empty positions"). Indices go up to
  18446744073709551614 and are kept exact everywhere; jump to any index, or read from the end.
- **Search values:** equals, contains or a glob pattern (as ARGREP means them), several conditions combined by any or
  all, and an ignore-case option. The server reads the range in bounded steps (at most 16 MiB of values or 1,000,000
  elements per request) and matches the values itself, then offers to continue; a value over 8 MiB, or one a pattern
  makes too costly to match within a request, is named rather than searched. Matching yields to other requests, so a
  search never holds the server. ARGREP itself is not run, and it is blocked in the console: Redis would search the whole range in its main
  thread with no time or work limit ([DECISIONS.md D22](DECISIONS.md#d22-array-search-reads-values-in-bounded-batches-and-matches-them-on-the-server-not-with-argrep)).
- **Aggregates (AROP):** sum, minimum, maximum, bitwise AND/OR/XOR, the number of elements, or how many equal a value,
  over ranges of up to 1,000,000 elements, with Redis's exact text.
- Operators set values (checked against what they opened), append at the insert cursor (never over existing
  elements), and delete elements or ranges after a server-built confirmation. **Add key** creates arrays.

**Vector sets (Redis 8)**
- An inspector: size, dimensions and quantisation, the members in byte order with a prefix filter and each row's
  attributes, and a member panel with its attributes, its embedding (up to 4,096 values) and its neighbours per
  graph layer.
- **Similarity search** by member or by a typed vector, with an optional attribute filter, showing the exact `VSIM` it
  runs. Results and effort are bounded (100 results, EF up to 1,000, a filter effort always sent).
- Operators edit attributes with compare-and-set and remove members after confirming. In the console, `VSIM` runs
  within the same bounds; `TRUTH` (a scan of every vector) and `NOTHREAD` are blocked.

**FalkorDB graphs in the Workbench**
- `GRAPH.RO_QUERY`, `GRAPH.QUERY` and `GRAPH.PROFILE` results show as a diagram (up to 200 nodes and 400 edges,
  keyboard-selectable, properties as text), a result table and execution statistics; `GRAPH.EXPLAIN` and `PROFILE`
  plans as a tree. The key browser recognises `graphdata` keys and points to the Workbench.
- Every graph command has an explicit rule: viewers read (RO_QUERY, EXPLAIN, LIST, `INFO ObjectPool`,
  `MEMORY USAGE`); operators run QUERY and PROFILE, which always ask for confirmation because they can change the
  graph, and show the whole Cypher in the confirmation; admins delete graphs with the typed database name and read
  CONFIG GET and SLOWLOG. User-defined functions, bulk loads, restores, CSV loading, unreviewed procedures and
  configuration changes are refused, and every query gets a timeout of at most one second. FalkorDB checks that timeout
  between steps, so the console also holds a graph query's slot until the engine has answered: at most one per user and
  two per database entry run in the engine at a time, through the console, the Workbench and Import ([DECISIONS.md D21](DECISIONS.md#d21-falkordb-queries-are-bounded-and-cannot-run-host-io-or-user-code)).

**Geo results on a map**
- `GEOSEARCH`, `GEORADIUS*` with `WITHCOORD`, and `GEOPOS` results get a **Map** view in the Console and Workbench:
  points over a bundled world outline, the search area drawn, keyboard-selectable markers. It is offline: no tiles,
  no map service, nothing fetched ([DECISIONS.md D20](DECISIONS.md#d20-the-workbench-geo-map-is-offline-a-bundled-outline-no-tiles)).

**Fixes**
- Search query completion no longer garbles a field name containing `|` (it was taken for the cursor marker).
- A form whose input fails validation (an index, base64) shows the message and can be corrected, instead of staying on
  "Working…".
- In the console, commands whose rules depend on their arguments (for example `VSIM`, `GRAPH.INFO ObjectPool`) are
  judged on what you typed, not as blocked because the bare command name is; admin reads such as `CONFIG GET` run on
  read-only databases, as the server allows.
- The slow log shows viewers and operators command names and keys, with other arguments as their size: they are other
  users' values and queries. Admins see them whole.

## Upgrade notes

- **Vector sets need ACL grants.** Their commands have no ACL category, so `+@read`/`+@write` do not include them. Add
  `+vcard +vdim +vemb +vgetattr +vinfo +vismember +vlinks +vrandmember +vrange +vsim` to the viewer and operator users,
  and `+vadd +vrem +vsetattr` to the operator ([INSTALL.md](INSTALL.md), ACL table). Without them the inspector shows
  Redis's `NOPERM`.
- **Arrays need no grant:** the AR* commands are in `@array` plus `@read` or `@write`. To keep a tier away from arrays,
  add `-@array` after its `+` categories.
- **FalkorDB needs explicit grants and engine bounds.** Graph commands have no ACL categories; use the per-tier grants
  in [INSTALL.md](INSTALL.md#optional-falkordb-graph-sandbox-and-acls). Set `TIMEOUT_DEFAULT`/`TIMEOUT_MAX`,
  `RESULTSET_SIZE`, `MAX_QUEUED_QUERIES` and `QUERY_MEM_CAPACITY` on the module, point `IMPORT_FOLDER` at a directory
  that does not exist, give the server a memory limit of its own (one expression's time and some allocations are not
  bounded by the module) and deny it outbound network access. Where viewers should not spend engine time, leave
  `+graph.ro_query` out of the viewer grants or cap the database with `maxRole`.
- **No config change is required** and no new config keys were added. A FalkorDB server is configured like any other
  database entry; give it `poolSize` 3 or more (the console refuses graph queries on a pool of one, since a long query
  keeps its connection until the engine answers).
- **Console rules that are new:** `ARGREP` (use the array inspector's search), `VSIM … TRUTH`/`NOTHREAD` and
  out-of-range `COUNT`/`EF`/`FILTER-EF`, and the refused graph commands are blocked with a hint
  ([USER-GUIDE.md](USER-GUIDE.md#why-was-my-command-blocked)).
- **The slow log is redacted for non-admins** (console `SLOWLOG GET` and Diagnostics), as above.
- **API (additive):** the `array/*` and `vectorset/*` read routes, the `array.*` and `vset.*` typed ops, and the
  `array`/`vectorset` key values. See [CONTRACT-CHANGES.md](CONTRACT-CHANGES.md).

## How it was checked

- **Five review rounds by models other than the author.** Each feature was written by one model and reviewed by
  another, as code and in a browser as viewer, operator and admin (local and Keycloak accounts): arrays, vector sets,
  geo and search completion (written by Claude Opus 5.5) by Claude Sonnet 5.5 and GPT-6.1 Sol; the FalkorDB support
  (written by GPT-6.1 Sol) by Claude Sonnet 5.5. Every finding was reproduced, fixed with a regression test that failed
  before the fix, and recorded in [REVIEW-LOG.md](REVIEW-LOG.md); reports are in `docs/research/27` to `34`. The last
  round found nothing at Medium or above, and a targeted verification of the last fix confirmed it. A few Low
  wording items are deferred to v0.4.x (listed at the end of the review log).
- **What the reviews changed, measured:** the array search no longer runs ARGREP (D22); on 5,000 values of 4 KiB a
  worst-case case-insensitive search takes about 160 ms per request, where ARGREP held Redis's main thread 0.6–1 s, and
  an unrelated request waits at most 18 ms during it. The Cypher guard is checked against FalkorDB itself: an
  integration test plans 1,452 tokenisation probes with EXPLAIN, and a reviewer's 411-million-candidate differential
  found no bypass. A heavy graph query that outlives its timeout keeps its console slot until the engine answers
  (live: 504 at 7.0 s, the next query refused, freed at 13.6 s).
- **Gates on the final code:** `pnpm -r typecheck`; shared 73, web 544, and server 1,109 tests passed (8 skipped: the
  optional external read-only remote suite), with the cluster, Sentinel and mutual-TLS topology up; full Playwright
  suite 701 passed, 0 failed, 0 flaky (2 skipped by design), against a disposable read-only upstream.
- **Live QA** in Chromium as viewer, operator and admin, through local accounts and Keycloak SSO, with 0 CSP or Trusted
  Types violations and 0 page errors: [qa/v04-geo.md](qa/v04-geo.md), [qa/v04-vectorset.md](qa/v04-vectorset.md),
  [qa/v04-array.md](qa/v04-array.md), [qa/v04-graph.md](qa/v04-graph.md) and the fix rounds
  ([r1](qa/v04-review-r1-fixes.md), [r2](qa/v04-review-r2-fixes.md), [r3/r4](qa/v04-review-r3-r4-fixes.md)).
