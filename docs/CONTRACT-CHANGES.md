# Contract changes

Changes to `packages/shared` made after the initial scaffold. Newest first. All are additive unless marked **breaking**.

## 2026-10-27 — v0.4 review round 2 fixes (fix/v04-review-r2)

### `api.ts`
- **`array/search` no longer runs ARGREP** (review v0.4 r2 H2, D22): the server reads the range with ARSCAN in batches
  and matches the values itself (ARGREP's meanings). `ARRAY_SEARCH_MAX_BYTES` is now 16 MiB of values read per request
  (was a 64 MiB weighted estimate); each read is at most half of it. **Breaking (unreleased):**
  `ARRAY_NOCASE_MATCH_MAX_BYTES` is removed (case-insensitive values follow `ARRAY_PREDICATE_MAX_BYTES`, 1 KiB).
- `ArraySearchResult` (additive): `skipped?: string[]`, values larger than one read (not tested; `next` is after them).
  `searchedTo` is where the search actually got to (the last element read, the last match when `limit` was reached,
  or `end`), and `elements` counts the elements read and tested. Audit: action `array.search`, command `ARSCAN`
  (was `ARGREP`), argv with predicate kinds and value sizes only.

## 2026-10-27 — v0.4 review round 1 fixes (fix/v04-review-r1)

### `api.ts`
- **`ARRAY_PREDICATE_MAX_BYTES` lowered from 16 KiB to 1 KiB** (**breaking** for clients sending longer values: the
  server answers 400 `validation`). New `ARRAY_NOCASE_MATCH_MAX_BYTES` (64): a `match` predicate with `nocase` longer
  than that is refused with 400. New `ARRAY_SEARCH_MAX_BYTES` (64 MiB): `array/search` visits at most that much element
  data divided by the search's weight per request (review v0.4 r1 H1); `searchedTo`/`next` report the cut as before.
  The route additionally sends `MEMORY USAGE <key> SAMPLES 5` and `ARCOUNT` (fixed reads on the caller's tier).
- `array/range`, `array/search`, `array/aggregate` check TYPE first: a missing key is 404 `not_found` (before: an
  empty page or result) and another type 400 `validation` "This key is not an array." (before: 502 WRONGTYPE);
  **breaking** for clients that relied on the empty page (review v0.4 r1 L3).
- Vector coordinates (`zVsetSearchRequest`, `vset.add`) must also be finite as doubles (`1e309` is 400, was a 502 from
  Redis). `vectorset/members` with an empty `after` pages after the empty member name instead of failing with 502,
  and Redis's "invalid vector specification" is a 400 (review v0.4 r1 L3).
- Full last pages: `array/range`/`key/read` (arrays) and `vectorset/members` name `next` only when another element
  or member follows (review v0.4 r1 L1). VRANGE is sent with `count + 1`.

### `commands.ts`
- `argumentRule` blocks `ARGREP` when a predicate value is over `ARGREP_VALUE_MAX_BYTES` (1 KiB) or a `MATCH` value
  is over `ARGREP_NOCASE_MATCH_MAX_BYTES` (64) with `NOCASE` anywhere among the options (additive; new
  `argrepParts`). Audit: the refused command as `blocked`, as for `RE`.
- `argumentRule` blocks `VSIM` with `TRUTH` or `NOTHREAD`, `COUNT`/`EF` outside 1–1,000, `FILTER-EF` outside
  1–100,000, a `FILTER` over 1 KiB, or an argv the vector-set module would not parse (review v0.4 r1 M2). New
  constants `VSIM_COUNT_MAX`, `VSIM_EF_MAX`, `VSIM_FILTER_EF_MAX`, `VSIM_FILTER_MAX_BYTES` and helper `vsimRefusal`
  (additive; **breaking** for console users who ran those forms). Audit: `denied`, command `VSIM`.

## 2026-10-27 — S4 graph (feat/v04-workbench-geo-graph)

### commands.ts

- Additive: explicit GRAPH command policy, with conservative Cypher feature guards in `graphPolicy.ts`. RO_QUERY,
  EXPLAIN, LIST, INFO ObjectPool and MEMORY are reads; QUERY/PROFILE are operator writes with confirmation on every
  call; DELETE is admin + typed; SLOWLOG/CONFIG GET are admin reads (SLOWLOG RESET is refused). Unsafe and future commands fail closed.
- Additive: GRAPH.MEMORY supports only USAGE, with SAMPLES capped to 100 (zero/all becomes 100).
- Additive server behavior: only reviewed TIMEOUT/--compact options, positive timeout <=1000 ms in exact-command
  previews; readOnly/maxRole/prod and late actor enforcement remain in force. Audit uses existing cli/workbench
  actions with redacted argv, hashed graph keys and denied outcomes for refusals. No values or Cypher are audited.

### Rich replies and sandbox

- Additive UI kinds `graph` and `graphPlan` over the existing binary-safe Reply contract; no new endpoint/schema.
  Graphdata key reads return an unsupported-value hint naming the Workbench and GRAPH.RO_QUERY.
- Additive dev/e2e database `sandbox-graph`, a pinned ephemeral FalkorDB service on loopback 6413, separate generated
  ACL/config files, and CI readiness checks. New test IDs are listed in `apps/web/TESTIDS.md`.

## 2026-10-26 — v0.4 S2 vector sets (feat/v04-vectorset)

### `api.ts`
- **`KeyValue` variant `vectorset`** (additive): `key/read` of a vector set returns `{ type: 'vectorset', info, page }`
  (VCARD, VDIM and selected VINFO fields; the first `VRANGE` page). Before, vector sets read as `unsupported`.
- **New read routes** (additive, POST bodies, viewer and up, the caller's tier, measured transport): `vectorset/members`
  (`VRANGE` pages with an exclusive start and an optional byte prefix), `vectorset/attributes` (`VGETATTR` for up to
  100 rows, 1 KiB each), `vectorset/element` (attributes up to `maxValueBytes`, `VEMB` up to 4,096 values and not
  above 16,384 dimensions, `VLINKS … WITHSCORES` bounded per layer), `vectorset/search` (`VSIM` by `ELE` or `VALUES`,
  COUNT ≤ 100, EF ≤ 1,000, a FILTER with FILTER-EF always sent, never TRUTH or NOTHREAD). Bounds are exported
  (`VSET_*`). Audited like other data reads.
- **New typed ops** (additive, operator and up, refused on read-only databases): `vset.add` (`VADD`; `expect` must
  say the member is absent, so an existing member is a 409, never an overwrite), `vset.setattr` (`VSETATTR` with
  compare-and-set on the attribute bytes), `vset.remove` (`VREM`, with the same confirmation as removing a hash field).

### `commands.ts`
- Explicit rules for every `V*` command: the reads already listed, plus `VADD`, `VREM`, `VSETATTR` as writes (no
  console confirmation, like `HDEL`/`SREM`/`ZREM`). A command Redis adds to the family later fails closed until reviewed.

### Redis ACL (deployment)
- Vector-set commands have no ACL category: the viewer user needs the `V*` reads and the operator user also `+vadd
  +vrem +vsetattr` (`infra/redis/users.acl.template`, `docs/INSTALL.md` §5). Without them the inspector answers 403.

## 2026-10-26 — v0.4 S3 arrays (feat/v04-array)

The array inspector (Redis Insight parity F24) for Redis 8.8+ native arrays (`TYPE` = `array`). All additive. Array
indices travel as decimal strings in canonical form (`zArrayIndex`: 0 … `ARRAY_MAX_INDEX` = 18446744073709551614),
because they exceed 2^53.

### `api.ts` (`// v0.4 arrays` section and marked lines)
- `REDIS_TYPES` gains `array` (additive).
- **`KeyValue` variant `array`** (additive): `key/read` of an array returns `{ type: 'array', info: ArraySummary, items,
  start, end, reverse, next? }`. `ArraySummary` is ARINFO (`count`, `length`, `nextInsertIndex` as strings; `slices`,
  `sliceSize`). The page is `ARSCAN key start end LIMIT count`: `cursor` (digits) is the start index, `reverse` reads
  from the highest index down, `count` 1–1000. Items are `ArrayElement { index, value: Bin, truncated?, ref }`,
  previewed like other collections. `KeyDetails.length` is ARCOUNT. Audited as `key.read` with command `ARSCAN`.
- **`zElementRef` variant `{ kind: 'array', index, identity }`** (additive): `POST /key/element` runs ARGET bounded by
  `maxValueBytes`, answers 409 when the element's SHA-256 differs from `identity` and 404 when the index is empty.
  Audited as `key.element` with command `ARGET`.
- **New read routes** (POST bodies, viewer and up, no confirmation; in `ROUTES` and the role matrix):
  - `arrayRange: POST /databases/:db/array/range` (`zArrayRange` → `ArrayPage`): a page from any index, either
    direction; `next` is the index just past the last one returned. Rate 20/s (burst 40) per user. Audit
    `array.range`, command `ARSCAN`, detail `returned=N [more] [truncated]`.
  - `arraySearch: POST /databases/:db/array/search` (`zArraySearch` → `ArraySearchResult`): ARGREP with 1–8
    predicates of kind `exact` | `match` | `glob` (each value ≤ 16 KiB; GLOB ≤ 8 `*`), `combine` `or` (Redis's
    default) | `and`, `nocase`, `limit` 1–1000, `values` (WITHVALUES). `RE` is not a predicate kind (400). At most
    `ARRAY_SCAN_MAX_ELEMENTS` (1,000,000) existing elements are searched per request; the response's `searchedTo`,
    `elements` and `next` say what was covered and where to continue. Rate 5/s (burst 10). Audit `array.search`,
    command `ARGREP`, argv with predicate kinds and value sizes only.
  - `arrayAggregate: POST /databases/:db/array/aggregate` (`zArrayAggregate` → `ArrayAggregateResult`): AROP
    `sum` | `min` | `max` | `and` | `or` | `xor` | `used` | `match` (with `value`) over `start`–`end` (either order).
    `result` is Redis's reply as text or `null`; `elements` is AROP USED. Ranges holding more than 1,000,000
    elements are refused with 400 naming the count. Rate 5/s (burst 10). Audit `array.aggregate`, command `AROP`.
- **New typed ops on `POST /ops`** (operator and up, refused on read-only databases, prod writes need the typed name
  and a reason; audit action = the op name):
  - `array.set` `{ key, index, value, expect }`: `ARSET key index value`, compare-and-set with a **required** `expect`
    `{ type: 'array', sha256 }` (the element's SHA-256, or `null` when the index is empty). 409 `conflict` carries the
    current element and an `expect` for "Overwrite anyway".
  - `array.insert` `{ key, values (1–1000), expect }`: `ARINSERT key value…`. ARINSERT overwrites what sits at the
    insert cursor, so the server checks under WATCH that the positions it writes are empty (ARNEXT, `AROP … USED`);
    otherwise 409 with "The insert cursor is at index N and ARINSERT would overwrite K existing elements" and no
    overwrite expectation. `expect` is required: `{ type: 'array' }` appends to an existing array, `{ type: 'none' }`
    creates the key and answers 409 "This key already exists" when it does (creates never overwrite). `sha256` is
    refused (400).
  - `array.delete` `{ key, indexes (1–1000) }`: `ARDEL`, `confirm`, preview from the exact argv.
  - `array.delete-range` `{ key, start, end }`: `ARDELRANGE key start end`, `confirm`; the summary names the range.
- New constants: `ARRAY_MAX_INDEX`, `ARRAY_PAGE_MAX` (1000), `ARRAY_SCAN_MAX_ELEMENTS` (1,000,000),
  `ARRAY_PREDICATES_MAX` (8), `ARRAY_PREDICATE_MAX_BYTES` (16 KiB), `ARRAY_SEARCH_KINDS`, `ARRAY_AGGREGATES`;
  `isArrayIndex`.

### `commands.ts` (`// v0.4 arrays` block)
- Explicit rules for every AR* command (additive; before, they were classified from COMMAND INFO flags, so
  ARDELRANGE ran without a confirmation): ARGET, ARMGET, ARGETRANGE, ARSCAN, ARGREP, AROP, ARLASTITEMS, ARNEXT, ARLEN,
  ARCOUNT, ARINFO → `read`; ARSET, ARMSET, ARINSERT, ARSEEK → `write`; ARDEL, ARDELRANGE, ARRING → `write` +
  `confirm` (ARRING overwrites the oldest elements and drops those outside a smaller ring). ARRING, ARSEEK and ARMSET
  are console-only.
- **`ARGREP … RE …` is blocked** for everyone by `argumentRule` (new helpers `argrepPredicates`, `ARGREP_RE_HINT`),
  in any case and position; a value that reads "RE" (`EXACT RE`) is not a predicate. Redis evaluates RE with no time
  limit; see `docs/ARCHITECTURE.md` section 7 (Arrays) for the measurements.

### Server behaviour
- `redis/checked.ts`: probes `array` (ARGET; absent = `null`) and `arrayInsert` (ARNEXT + `AROP … USED`); conflicts
  for an occupied insert target or an existing key on create offer no overwrite.
- The web's read-retry list (`lib/api.ts`) includes the three array routes; nothing else changes for other types.

## 2026-10-24 — v0.2.1 web review fixes (feat/v021-wfix)

Fixes for `docs/research/24-v021-web-review.md` (`docs/REVIEW-LOG.md`, "v0.2.1 review – web (GPT reviewer)").
One additive contract change; everything else is web behaviour.

### `api.ts`
- **New typed op `stream.consumer.delete`** (additive): `{ op, key, group, consumer }`, where `group` and `consumer` are
  a string or a `Bin` (exact bytes, like the other `stream.*` ops). The server runs the fixed
  `XGROUP DELCONSUMER key group consumer` on the caller's tier. It is a write (operator and above, refused on
  read-only databases) with `confirm`: the first call answers 428 with the usual summary ("Delete consumer (its
  pending entries are dropped from the group)") and preview, where XGROUP and DELCONSUMER are shown as the command
  and the group and consumer as redacted-size arguments. The result is Redis's reply, `{t:'int', v}` = the number of
  pending entries the consumer had. Audited as `stream.consumer.delete` with the group and consumer redacted.
  `commands.ts` already classified `XGROUP|DELCONSUMER` as write + confirm, so the console policy is unchanged.

### Web (no contract impact)
- The stream inspector uses the existing `stream.group.create` (no confirmation; prod still asks for the typed name
  and reason) and `stream.group.destroy` (confirm) besides the new op. Its confirmation dialogs carry a client note
  with the pending counts of the last refresh (`keyOperation(db, op, note)`; the server summary and preview stay
  authoritative).
- Presentation preference `drawerSplit` (boolean, default false), validated like the other preferences. Nothing new is
  stored about Redis data.
- Profiler download, rich-view bound notices, the index wizard source binding, the command helper selection and the
  PHP / Java / MessagePack views are browser-only.

## 2026-10-24 — v0.2.1 server review fixes (feat/v021-sfix)

Fixes for `docs/research/23-v021-server-review.md` (F1–F5; `docs/REVIEW-LOG.md`, "v0.2.1 review – server").
One contract tightening (list element references); everything else is server behaviour.

### `api.ts`
- **`zElementRef` list variant: `identity` is required (tightening).** `{ kind: 'list', index, identity }`, where
  `identity` is the hex SHA-256 of the whole element the page read. Key pages always include it. `POST /key/element`
  compares it after its bounded `LINDEX` and answers 409 `conflict` when another element now sits at the index (a
  push or pop moved it). A list reference without `identity` gets 400. Clients echo the page's reference, as the web
  does; a client that built list references from an index alone must read the page first.

### Server behaviour (no other type changes)
- **Imports are operator and above.** All four import routes (plan, start, status, cancel) need the operator role
  (403 for a viewer). The role is the effective one, so a `maxRole: viewer` database refuses imports for everyone.
  Operators can still plan on a read-only database, where write lines are refused one by one.
- **At most two planned or running imports per account**, across its sessions and databases. A new plan replaces the
  account's oldest plan that has not started; the replaced id then answers 404. Each account checks one file at a
  time, and the server checks two at once (429 otherwise). The server-wide cap of 16 is unchanged.
- **Planning** yields to the event loop every 200 lines. A plan keeps only the text and verdict of each line. When
  the import runs, it tokenizes and checks each line again with the plan's command table, so the verdicts, audit
  events and confirmation are the same as before.
- **Blocking commands in an import** (BLPOP, XREAD BLOCK, WAIT, …) share `policy.workbenchBudgetMs` (30 s by default)
  of total wait, as in the workbench. Each one is still capped at 5 s. When the budget is used, later blocking lines
  are not sent: each is a failure with code `timeout` in `failures`, audited as `import.exec` `denied`.
- **Analysis jobs**: starting a job is rate limited per account (1/s, burst 3; 429 `Too many requests; slow down.`).
  Each account holds at most five jobs across its sessions, and its oldest finished job is dropped first (that id
  then answers 404). When the table is full (64), the oldest finished report of anyone is dropped instead of
  refusing the new job with 429.
- **Cluster per-key deletes** (bulk-delete job, synchronous bulk delete, typed multi-key delete): after the first
  failure, such as a revoked actor, the request or job ends only after the commands already sent have settled.
  Reported and audited counts include them.

### Web (no contract impact)
- Import is hidden from viewers: Guided mode drops the Import tab (`?tab=import` falls back to Tasks), and the
  command palette leaves out "Import commands from a file".

## 2026-10-24 — DETAIL parity (feat/v021-detail)

All API changes are additive. Existing writes retain their previous behavior.

- `zKeyRead`: optional `match` (hash/set/zset SCAN MATCH), binary `exact` (HGET/SISMEMBER/ZSCORE),
  `reverse` (ZRANGE REV), `scoreMin`/`scoreMax` (ZRANGE BYSCORE, ZCOUNT), and `streamStart`/`streamEnd`
  (inclusive XREVRANGE bounds). Exact, pattern and score criteria are separate modes. Collection cursors must
  be numeric. COUNT is a hint for SCAN; pages are never sliced. List/zset offsets are zero based.
- `KeyDetails.filter?: {matches, totalMatches?}`: `matches` counts this page; `totalMatches` is present only for
  exact lookups and score ranges. MATCH does not claim a full-collection count. `value.total`/`length` still
  describe the entire collection. Zset pages add optional `cursor`, `reverse`, `matchedTotal`.
- Hash pages batch one `HTTL ... FIELDS` for returned fields and add `entries[].ttl` (-1 persistent, -2 missing),
  `fieldTruncated`, and `hashFieldExpiry: {supported, reason?}`. Empty pages check support with an actor-checked HTTL of the empty field (no value read). Unknown HTTL or ACL denial disables expiry with
  an explanation; other failures propagate. New typed `hash.expire` / `hash.persist` map to HEXPIRE / HPERSIST.
- `POST /key/element`, `zKeyElementRequest`, `ElementRef`, `KeyElementResponse`: fetch one full value plus its
  optional full field/member `identity` and zset `score`. Collection rows add optional `ref` (sets: parallel
  `memberRefs`). Short identities are inline; longer identities use a scan/rank position plus SHA-256 identity
  digest. An exact lookup reads no page, so its row is addressed inline (identities up to 64 KiB). The server rereads the bounded page and refuses a moved identity with 409, rather than addressing a
  shortened preview. References are untrusted POST data, contain no credentials and are never put in URLs.
  Missing elements give 404; over-cap elements give 413. Both value and identity must fit `maxValueBytes`;
  transport wire limits apply while reading. Page references stay compact even after the display budget is used.
- New reads use fixed read authorization and the scoped actor-checked measured transport, sharing the existing
  request wire budget. Every command checks the actor immediately before writing its request bytes. Key-read
  bodies allow 256 KiB to accommodate a binary key plus lookup identity.
- Stream pending adds inclusive `start`/`end` and optional `consumer`; exclusive start `(id)` supports paging.
  Stream group/consumer inputs also accept `Bin`; group/consumer metadata adds optional exact `nameBin` /
  `consumerBin`. Groups report optional `total` and `consumerTotal` so 100-row display limits are explicit.
  New `stream.claim` uses XCLAIM JUSTID, bounded IDs and minimum idle time, and always requires confirmation.
  `stream.ack.confirmAck?: boolean` opts into confirmation; the new inspector always sends true. Existing ACK
  clients retain their previous behavior. Both actions enforce effective role, read-only and production rules.
- Multi-entry UI uses the existing ops contract: at most 50 entries / 4 MiB, unique fields/members, validated
  scores. Each hash/score replacement is a separate existing CAS op with `expect` (unseen identities expected
  absent). Set additions / list pushes use one bounded command. Sequential successes remain on later failure;
  the UI reports completed and uncompleted commands and stops at the first error. No ambiguous write is retried
  automatically. Full retrieved hash/list/score edits also use the existing `expect` path.
- Vector formatters interpret float32/64 with explicit little/big endianness, alignment validation and 4 MiB
  decoding/copy limits. Raw downloads use exact original bytes (also after local inflation), a static filename and an opaque local Blob URL; no Redis
  data is put in navigation URLs or storage. Truncated values cannot be downloaded as complete data.

## 2026-10-24 — v0.2.1 insight: search wizard, search workflow, analysis jobs, import jobs (feat/v021-insight)

RI parity fixes F4, F7, F8, F10, F11, F12 (`docs/RI-PARITY-PLAN.md`). All additive except the **FT.DROPINDEX
policy tightening** (marked). New contract types live in `packages/shared/src/insight.ts` (exported from the
package index); `api.ts` gets additive fields and route entries.

### `commands.ts` (policy)
- **`FT.DROPINDEX`: `write` + `confirm` → `admin` + `typed`** (tightening). Dropping an index is an admin action
  with a typed confirmation wherever it runs (console, workbench, import, Search tool).
- **`argumentRule(argv)`** (new): argument-dependent rules, checked before `lookupRule` by the server's `classify` and
  by the browser's policy hints. It refuses `FT.DROPINDEX <index> DD` (would delete every indexed key) everywhere.
  The Search tool's drop can delete documents only when the new server policy `searchDropDeletesDocuments` is true.

### `insight.ts` (new)
- **Index wizard**: `zSearchIndexCreate` (`index` matching `SEARCH_INDEX_NAME`, `on` HASH|JSON, 1–10 non-empty
  `prefixes`, 1–64 `zSearchFieldSpec` fields with TEXT/TAG/NUMERIC/GEO/VECTOR options, `noStopwords`,
  `skipInitialScan`, `confirmation`), `searchIndexProblems`, **`buildFtCreateArgv`** (the exact argv the server runs;
  the wizard shows the same text), `inferSearchFieldType` / `mergeSearchFieldTypes`, `globEscape`, `jsonPathChild`.
- **Sampling**: `zSearchSample` `{on, prefix, keys (1–50, default 20), key?}` → `SearchSampleResponse` (`fields` with
  suggested type, counts, ≤2 examples cut to 80 characters, `dim` for vectors; `ignored`; `overlapping` indexes;
  `sampled`/`skipped`/`scanned`/`complete`).
- **Index detail**: `zSearchIndexRef` `{index}` → `SearchIndexDetail` (definition, prefixes, filter, language,
  options, fields with options, docs, indexing %, failures, memory facts, other FT.INFO facts, last error with the
  key as `Bin`).
- **Drop**: `zSearchIndexDrop` `{index, deleteDocuments (default false), confirmation}` → `{ok, documentsDeleted}`.
- **Query options**: `buildFtSearchArgv` (SORTBY / RETURN / LIMIT / DIALECT in FT.SEARCH order; no TIMEOUT).
- **Analysis**: `ANALYSIS_RULES` (thresholds), `AnalysisRecommendation` (`id`, `severity`, `title`, `detail`,
  `action`, `affected` of `basis` sampled keys, example `keys` as `Bin`, `prefixes`, `at`, `module`, `search`),
  `AnalysisCoverage` (`sampled`, `dbSize`, `complete`, `stoppedBy`), `AnalysisJob`, `zJobCancel`.
- **Import**: `MAX_IMPORT_COMMANDS` (10,000), `MAX_IMPORT_BYTES` (4 MiB), `IMPORT_CHUNK_SIZE` (100), `zImportPlan`
  `{script, fileName?}` → `ImportPlan`, `zImportStart` `{stopOnError, skipBlocked, confirmation}` → `ImportStatus`
  (`state`, `processed`/`succeeded`/`failed`/`skipped`, `chunks`, `stopReason`, `inFlightLine`, `failures` grouped
  per command and error code with the first 20 line numbers). At most 4 imports run at once server-wide (429 otherwise; the slot is checked
  before the confirmation is spent).

### `api.ts` (additive)
- `zSearchQuery`: optional `sortBy`, `sortOrder` (ASC|DESC), `returnFields` (1–32), `dialect` (1–4).
- `SearchResult.docs[].key?: Bin`: the document id's exact bytes ("Open in key browser" for binary ids). The
  server reads FT.SEARCH ids as bytes now; `id` (text) is unchanged.
- `AnalysisReport.recommendations?` and `AnalysisReport.coverage?` (also on the existing synchronous `POST /analysis`).
- `ROUTES`: `searchIndexInfo`, `searchSample`, `searchIndexCreate`, `searchIndexDrop`, `analysisJobStart`,
  `analysisJob`, `analysisJobCancel`, `importPlan`, `importStart`, `importStatus`, `importCancel`.

| Route | Role / policy | Notes |
|---|---|---|
| `POST /databases/:db/search/index/info` | viewer+ (FT.INFO) | audited read `search.index.info` |
| `POST /databases/:db/search/sample` | viewer+ | bounded SCAN (1.5 s), then HSCAN or JSON.GET of ≤50 keys on the measured transport, each capped at 256 KiB (larger keys are skipped, never cut); rate 2/s |
| `POST /databases/:db/search/index/create` | classified like the console (`FT.CREATE` → write: operator+; read-only and maxRole apply) **and** the role's Redis ACL user must allow it (the sandbox operator user does not: NOPERM → 403) | always a confirmation (`confirm`; prod: typed name + reason); preview lists the full argv; actor-checked measured send; audit `search.index.create` with redacted argv |
| `POST /databases/:db/search/index/drop` | admin; read-only refused | typed confirmation of the index name (prod adds a reason); `deleteDocuments` → 403 unless `policy.searchDropDeletesDocuments`; audit `search.index.drop` |
| `POST /databases/:db/analysis/jobs` → `GET …/jobs/:id` → `POST …/jobs/:id/cancel` | viewer+ (reads) | same per-user (1) and global (4) slots as `POST /analysis`; `policy.analysisMaxMs`; finished reports held for polling are capped at 32 MiB server-wide (oldest dropped); jobs belong to the session and database (others get 404); kept 10 min after they end; a cancelled job returns its partial report |
| `POST /databases/:db/import` → `POST …/import/:id/start` → `GET …/import/:id` → `POST …/import/:id/cancel` | per line, the workbench policy (`prepare`) for the caller | plan lists counts by class and every refused line (first 200); start refuses refused lines unless `skipBlocked`; one confirmation for any write (prod: typed + reason; stronger line rules such as FLUSHDB win; preview lists destructive lines first); commands run one at a time through the workbench `execute` (measured transport, role ACL user, actor check, per-line audit `import.exec`), session validity re-checked before each command, 15-minute budget; one running import per user, one plan or run per session and database, 16 server-wide; plans expire after 10 min; ids are opaque and session-bound |

### Server configuration
- `policy.searchDropDeletesDocuments: boolean` (default `false`).

### Behaviour the web client should know
- Job ids (`[0-9a-f]{24}`) are the only path parameters; index names, prefixes, queries and scripts travel in JSON
  bodies. Polls send `X-RC-Background: 1`.
- `server cli.ts` now exports `prepare`, `execute`, `auditBase`, `STRONGER` (used by the import job); behaviour is
  unchanged.

## 2026-10-24 — key browser v0.2.1: names-only scan, lazy metadata, pattern-delete jobs (feat/v021-kb)

Redis Insight parity for the key browser (KB stream of `docs/RI-PARITY-PLAN.md`: names-only scan, F2, F14, F16, F20).
All additive: `POST /keys/scan` and `POST /bulk-delete` are unchanged (Guided mode and the bulk-delete preview still use
`keys/scan`). Measurements: `docs/qa/v021-key-browser.md`.

### `api.ts`
- **`POST /api/v1/databases/:db/keys/names`** (`ROUTES.keyNames`; body `zKeyNamesRequest`, response `KeyNamesResponse`).
  Request `{ cursor = '0', match = '*', type?, count = 10000 (1–10,000), scanThreshold = 10000 (100–10,000,000) }`,
  strict. Response `{ cursor, keys: Bin[], scanned, dbSize, threshold, exact?: true, stopped?: 'time' | 'bytes' }`: key
  names only (binary-safe `Bin`, canonical encoding). The server loops `SCAN cursor MATCH m COUNT ≤2000 [TYPE t]` until
  `count` names were found, `threshold` slots were examined (`min(scanThreshold, policy.keyScanThresholdMax)`, reported
  back), the cursor returned to 0, `policy.scanBudgetMs` passed (`stopped: 'time'`) or the kept names reached half of
  `maxReadReplyBytes` (`stopped: 'bytes'`); continue with `cursor`. Cluster: per primary with the existing opaque
  cursor. A `match` with no unescaped `*`, `?` or `[` is one key (backslash escapes resolved, a trailing `\` literal):
  one `TYPE` lookup, `exact: true`, `cursor: '0'`, `scanned = dbSize`, and the type filter applies.
- **`POST /api/v1/databases/:db/keys/meta`** (`ROUTES.keyMeta`; `zKeyMetaRequest`, `KeyMetaResponse`). Request
  `{ keys: Bin[] (1–500), ttl = true, size = true }`, strict, body limit 4 MiB. Response `{ keys: KeyMetaItem[] }` in
  request order, `KeyMetaItem { key, type, ttl?, size? }`: `TYPE`, and when asked `PTTL` (reported as whole seconds,
  rounded up; -1 no expiry, -2 gone) and `MEMORY USAGE key SAMPLES n` (bytes; absent when MEMORY USAGE is denied or the
  key is gone; `n` = `policy.keyMetaMemorySamples`, 5 by default). A missing key is `type: 'none'`. A key repeated in
  one request is read once and reported at each position. If the tier's ACL user may not run `TYPE` the request is 403;
  a key it may not access (ACL key pattern) is reported as `type: 'unknown'` without TTL or size.
- **Pattern delete as a job (F20)** (`BulkDeleteJob`, `BulkDeleteJobState`, `BulkDeleteJobResponse`):
  - `POST /api/v1/databases/:db/bulk-delete/jobs` (`ROUTES.bulkDeleteJobs`): the `zBulkDelete` body and the same 428
    challenge as `bulk-delete` (impact count and sample, typed database name, reason on production; the token is bound to
    this route). Confirmed: starts the delete and answers at once `{ job }`.
  - `GET /api/v1/databases/:db/bulk-delete/jobs/:id` (`ROUTES.bulkDeleteJob`) and `POST …/jobs/:id/cancel`
    (`ROUTES.bulkDeleteJobCancel`, body `{}`): status / stop between batches. Operator role; 404 for any session but
    the one that started the job, and on another database.
  - `BulkDeleteJob { id, state: 'running'|'done'|'cancelled'|'stopped'|'failed', scanned, deleted, failed, expected?,
    errors: { code, count }[] (≤ 8 codes, Redis or API error codes only), complete, stopReason?: 'cancelled'|'session'|
    'time'|'keys'|'errors'|'shutdown', startedAt, finishedAt?, elapsedMs }`. A server shutdown stops running jobs between
    batches (`stopped`, `shutdown`) before Redis and the audit store close, and their outcome is audited. `expected` is the count the confirmation showed when
    the count was complete. Limits: 10 minutes, 1,000,000 keys visited, three pages in a row where every UNLINK failed.
    Finished jobs are kept 10 minutes. The job keeps running when the browser goes away (cancel to stop it).
- Constants `KEY_NAMES_MAX_COUNT` (10,000), `KEY_SCAN_THRESHOLD_DEFAULT` (10,000), `KEY_SCAN_THRESHOLD_LIMIT`
  (10,000,000), `KEY_META_MAX_KEYS` (500).

### Server behaviour
- **Measured, actor-checked metadata batches.** `keys/meta` (and the exact lookup of `keys/names`) run through the new
  `Conn.pipeline`: one batch per node (each primary in cluster mode, at most four at once) written at once on one
  measured socket and read back reply by reply, each reply capped at 4 KiB and charged to the request's cumulative
  `maxReadReplyBytes` budget; the actor check runs once, with the write of the batch. Error replies are per-key results.
  In cluster mode the batches share one deadline and stop after the first failure; MOVED replies (a stale slot map)
  make node-redis rediscover the map once and those keys go out again as one batch per node of the refreshed map (known
  primaries only); anything still redirected (ASK during a migration) comes back as that key's error reply (`unknown`).
- `MEMORY USAGE … SAMPLES 0` walks every element of a collection (exact sizes for folder sums, as Redis Insight does),
  so its cost grows with the collection, and Redis keeps running commands it has already read when a client timeout
  drops the socket: `commandTimeoutMs` does not bound it. What bounds it: distinct keys only, 500 per request, two
  requests per user at once, 10/s. For databases with very large collections set `policy.keyMetaMemorySamples` (new;
  default 0, 0–1000) to a small number such as 5 (Redis's own default), which estimates collections in constant time.
  The browser skips MEMORY USAGE when the Size column is hidden.
- **Limits.** `keys/names`: 10/s, burst 20, at most two running per user (shared with `keys/scan`). `keys/meta`: 10/s,
  burst 30, at most two running per user. Both also take one of the user's four data-read slots. Jobs: `bulk` 1/s
  burst 3 to start (as `bulk-delete`), one running job per user and four per server (429 otherwise); status and cancel
  10/s, burst 20. A normal open (one names request, then a metadata batch per screen while scrolling) stays far below
  these (`docs/qa/v021-key-browser.md`).
- **Audit**, one event per request. `key.names`: command `SCAN` (or `TYPE` with the key tag for an exact lookup), detail
  `keys=N scanned=M threshold=T[ exact][ stopped=time|bytes][ type=…]`. `key.meta`: command `TYPE`, argv
  `TYPE [PTTL] [MEMORY]` plus the key tags of the first 50 keys and `<+N keys>`, `keyCount`, detail `keys=N missing=M`.
  Jobs: the 428 challenge as before, `key.bulk-delete.start` when confirmed (reason, `job <id>; expected N`), and
  `key.bulk-delete` when it ends (outcome `allowed`, or `error` for `failed`; `keyCount` = deleted; detail
  `job <id>; scanned S; deleted D; failed F; <state>[ (<stopReason>)][; errors CODExN,…]`). Never key names.
- **New policy** `keyScanThresholdMax` (default 100,000; 1,000–10,000,000) and `keyMetaMemorySamples` (default 5, Redis's own default: constant cost per key; 0 is exact but walks whole collections).
- A job's start is checked against the job limits again right before it is registered, so two confirmed requests sent
  together cannot both start.
- `Confirmations.require` / `confirmOrThrow` also return what a bulk challenge counted (`confirmedKeys`).

### Web (no contract impact)
- The key browser uses `keys/names` + `keys/meta` + the job routes. "Keys to scan" (500–100,000, default 10,000) is
  stored in `localStorage` as `rconsole.keyScanCount` (a number only; removed when back at the default); everything
  else (names, metadata, view, columns, sort, auto-refresh) stays in session memory.

## 2026-10-24 — final server review (feat/v02-server6)

See `docs/REVIEW-LOG.md` ("Final review – server (GPT reviewer)"). **No `packages/shared` change**; no type changes.

### Behaviour the web client should know (no type changes)
- **Request-body budget (429 before the body is read).** A request with a body takes one of its user's body
  counts and, above 64 KiB, its size from the user's and the server's byte budgets when its headers arrive. A full
  budget answers **429 `rate_limited`** at once, without reading the body; the message names the limit ("…
  request-body budget (24 MiB)…", "… limit 32 request bodies …"). A declared `Content-Length` over the route's limit
  is **413 `too_large`** at once (as before, only earlier). A browser sends one large upload at a time per user
  comfortably (two 12 MiB bodies fit a user's default share); retrying after the earlier upload finishes succeeds.
- **401 after a held body or a slot wait.** The session and account are checked again after the body arrived and
  after a wait for a request slot. A request whose session ended or whose account was disabled, demoted or otherwise
  changed meanwhile gets **401 `unauthenticated`** (nothing runs), like any request after revocation. Audited as
  action `auth.revoked`, outcome `denied`, with the method and route pattern (no data).
- **Checked edits: a type change while reading is a 409.** When the key's type changes between the server's `TYPE`
  and its element read (Redis `WRONGTYPE`), the server reads again (within the existing 3 attempts) and answers the
  usual **409 `conflict`** with `reason: 'type'`, instead of 502 `redis_error`. If the type keeps changing, the 409
  carries no `current.expect` (nothing comparable to overwrite). Other Redis errors stay as they were.
- **`expect` on an op without compare-and-set is 400.** Ops other than `string.set`, `hash.set`, `list.set`,
  `zset.add`, `json.set`, `json.delete`, `key.rename` and `key.delete` used to drop an `expect` field silently and run
  unchecked; they now answer **400 `validation`** (`expect: not supported for <op> …`). Requests without `expect`
  are unchanged.
- **New server policy**: `maxBodiesInFlight` (default 256; 1–65,536) and `maxBodyBytesInFlight` (default 48 MiB;
  12 MiB–4 GiB). Per user: an eighth of the bodies, half of the bytes (at least 12 MiB).

## 2026-10-23 — compare-and-set edits (feat/v02-webfix3, web review v0.2 r3)

See `docs/REVIEW-LOG.md` ("Round 3 – web (GPT reviewer)"). Every round so far found an editor that wrote something
other than what the user saw, or wrote to another item after a refresh. Besides the client fixes, edits that
replace existing data are now **compare-and-set** on the server. All changes are additive: requests without
`expect` behave exactly as before.

### `api.ts`
- **`zEditExpect` / `EditExpect`** `{ type: string; sha256?: string | null }` (new). What the client last read of
  the data an op replaces: the Redis `TYPE` reply, and the lowercase hex SHA-256 of the exact bytes (`null`: the
  element did not exist; omitted: check the type only). Compared per op:

  | Op (with `expect`) | Bytes compared | Notes |
  |---|---|---|
  | `string.set` | the whole string (`GET`) | not with `nx`; `type` `string`, or `none` (create if absent) |
  | `hash.set` | the value of its one field (`HGET`) | exactly one entry; `null` = field absent; `type` `hash` or `none` |
  | `list.set` | the element at `index` (`LINDEX`) | `null` = out of range; `type` `list` |
  | `zset.add` | the score of its one member (`ZSCORE`, the same text as `KeyValue` zset `score`) | exactly one member; `type` `zset` or `none` |
  | `json.set`, `json.delete` | the whole document as `JSON.GET key` returns it (`KeyValue.json`, UTF-8) | `type` `ReJSON-RL` |
  | `key.rename`, `key.delete` | optional: a string's value or a JSON document | `key.delete` with exactly one key; other types: `type` only |

  Expectations that cannot describe what the op replaces are **400 `validation`** (e.g. two hash entries, `nx`,
  `sha256` on a key-level op for a collection).
- **`string.set.keepTtl?: boolean`** (new): `SET … KEEPTTL` (not with `ttl`). The web's string edits used the CLI
  `SET … KEEPTTL` before; they use this typed op now, so they can carry `expect`.
- **`expect?: EditExpect`** on `string.set`, `hash.set`, `list.set`, `zset.add`, `json.set`, `json.delete`,
  `key.rename`, `key.delete` (new, optional). Other ops cannot carry one.
- **`ApiError.error.code` `'conflict'`** (new) → **HTTP 409**, with **`ApiError.error.conflict: EditConflict`**
  (new): `{ reason: 'type' | 'value'; expected: EditExpect; current: { type; value?: Bin; truncated?; totalBytes?;
  expect?: EditExpect } }`. `current.value` is the compared element now (at most `KEY_VALUE_PREVIEW_BYTES`, with
  `truncated`/`totalBytes` when longer). `current.expect` matches what Redis holds now; resending the op with it is
  "overwrite anyway", and it is checked again like any other. It is absent when the current state cannot be compared
  (an element larger than an editor can hold) or would change the key's type (a string edit over a hash). Nothing was
  written when a 409 is returned.
- **`sha256Hex(bytes)`** in `@rconsole/shared` (new): dependency-free SHA-256, so the browser can compute
  expectations in any context (also where `crypto.subtle` is unavailable). The server uses node:crypto.

### Server behaviour
- A checked op runs on **one exclusive measured socket** of the caller's tier: `WATCH key`, `TYPE`, the element read
  (`STRLEN`+`GET`, `HEXISTS`+`HSTRLEN`+`HGET`, `LINDEX`, `ZSCORE` or `JSON.GET`), compare, then `MULTI`, the op's
  usual command, `EXEC`. No Lua. If WATCH aborts (`EXEC` nil: someone wrote the key in between) the server reads and
  compares again, at most 3 transactions, then 409. The socket is closed after every exchange, so no WATCH/MULTI state
  can reach another request. A queued-command or `EXEC` error is the usual `redis_error`.
- **Cluster**: the exchange runs on the primary of the key's slot. A MOVED answer to `WATCH` (stale slot map) restarts
  the exchange once on the new owner, under the round-4 redirect policy (known primaries only); ASK (slot migrating) is
  **503 `unavailable`** ("nothing was written") so an exchange never spans two nodes. `key.rename` keeps Redis's
  same-slot rule (CROSSSLOT). Sentinel uses the current master.
- Comparisons read at most `max(policy.maxValueBytes, 64 KiB)` of a string, hash field or list element (string and
  field sizes are checked before reading); a larger element is a 409 without `current.expect`. JSON documents are read
  within `maxReadReplyBytes`, like the key browser's read.
- **ACL**: the operator tier's Redis user needs **`+@transaction`** (WATCH, MULTI, EXEC, DISCARD, UNWATCH);
  `infra/redis/users.acl.template`, the topology script and `docs/OPERATIONS.md` include it. Without it a checked op
  fails closed with **403** `forbidden` and the hint "grant +@transaction to this tier's Redis ACL user"; nothing is
  written and unchecked ops keep working. Admin's `+@all` already has it. The console still blocks MULTI/EXEC/WATCH
  typed by users (policy unchanged).
- **Audit**: a checked write is recorded as before with `detail: checked`; a conflict as outcome `denied` with
  `detail: conflict: <message>` (no values). The confirmation flow is unchanged: the token is bound to the body,
  `expect` included, so "delete anyway" asks for a new confirmation.

### Web
The web always sends `expect` for these edits: string and JSON values from the main editor, hash fields, list
elements and scores (inline and main editor), renames and deletes from the inspector. A hash field or sorted-set
member that the loaded page does not show is expected absent (`null`), so a value nobody saw is never replaced
blindly. Bulk deletes from the key list, element removals (HDEL, LREM, SREM, ZREM, XDEL), TTL changes and Guided /
console commands do not carry expectations.

## 2026-10-23 — HTTP fairness and deadlines (feat/v02-server5, review v0.2 r5)

No shared API type changes. Ordinary database requests acquire request slots in `preHandler`, after body parsing,
and release them in `onSend`, after serialization and before socket writes. Disconnects still release unfinished
work. The three SSE routes and Workbench cancellation are exempt by their exact routed paths; query values cannot
change admission. Per-user shares and bounded FIFO waits are unchanged.

New finite `server` settings: `requestTimeoutMs` 120000 (absolute upload deadline), `headersTimeoutMs` 15000,
`connectionTimeoutMs` 30000 (socket read/write inactivity, including unauthenticated bare sockets), and
`keepAliveTimeoutMs` 5000 (plus Node's 1 s buffer). Headers must finish before the request deadline; the idle timeout
must be at least 10 s, above SSE's 5 s heartbeat. Body-size limits are unchanged. Request receive timeouts do not
limit handler execution or SSE lifetime; existing command/workbench/stream budgets still apply. Parser deadlines
are checked at least once per second. Stalled connections are closed; parser deadline expiry can return HTTP 408.

Production `trustProxy` strings now require explicit IPs, narrow CIDRs (IPv4 /8+, IPv6 /16+, mapped IPv4 /104+), or
`loopback`, `linklocal`, `uniquelocal`. This deliberately refuses broad ranges instead of trying a few public-IP
samples; two /1 halves cannot bypass it. Explicit numeric hop counts are still supported. No dependency added.

## 2026-10-23 — limits around the measured transport (feat/v02-server4, review v0.2 r4)

No `packages/shared` change; no request or response type changes. Server behaviour the web client should know, which
supersedes the matching statements of the measured-replies entry below:

- **429 only after a short wait.** Console commands, typed reads and other database requests that find their pool,
  the server-wide command budget or the request slots busy now wait in a bounded FIFO queue (at most 2 s, or the
  command timeout if shorter; at most four waiters per slot; dropped when the request is aborted) before 429
  `rate_limited`. One user holds at most half of the server-wide request slots. Each 429 message names the limit it
  hit (the database's connection pool, the server's command budget, the server's request slots, the user's share).
- **Streams have their own limits.** Open pub/sub, profiler and metrics streams never use command or request slots.
  New server policy `maxStreams` (default 64; 1–1024) caps open live streams (pub/sub + profiler) and, separately,
  metrics streams, server-wide; over it the stream request gets 429 "Too many live streams are open on this server
  (limit N)". Per-user caps (3 live, 5 metrics) are unchanged.
- **Large stream events arrive cut instead of ending the stream.** A pub/sub message over 64 KiB is delivered with
  the existing `truncated: true` and `totalBytes` fields whatever its size (before, one over `maxReadReplyBytes`
  closed the stream with `error` `too_large`). A MONITOR line over 64 KiB is cut: its last shown argument ends with
  `…` and later commands still arrive (before, the profiler ended with `too_large`). An `error`/`too_large` event now
  only follows an event that would keep more than 256 KiB, which Redis does not send for pub/sub or MONITOR.
- **413 names the configured cap.** `too_large` messages and hints state `maxReadReplyBytes` (or the fixed internal
  cap), never the leftover budget; a request whose replies together exceed the budget says so ("exceeded its
  combined N-byte read budget").
- **Large keyspaces.** Bulk delete (its 428 preview count and the run) and memory analysis no longer charge every SCAN
  page to one request budget; they work up to their existing key/time limits. Analysis gets 413 only if the key
  names kept in its report exceed `maxReadReplyBytes`.
- **Server metadata** (`GET /databases`, `/overview`, `/metrics/stream`, `/commands`) uses fixed measured caps (INFO
  and COMMAND DOCS 4 MiB), so a lowered `maxReadReplyBytes` no longer breaks autocomplete or the database list.
- **Cluster redirects** are followed only to primaries of the known topology (a MOVED that disagrees with the slot
  map refreshes it first); any other target gets 503 `unavailable`.
- A stream request whose client leaves while the server is still connecting to Redis is dropped with no `ready`,
  no `pubsub.start` audit event, and no slot held (a profiler start records `profiler.start` with outcome `error`).

## 2026-10-23 — measured Redis replies (feat/v02-replycap)

No shared reply type changes beyond the additive cancellation contract. Console/workbench keep binary-safe
`Reply` trees, the display budget (`maxReplyBytes`, 10k displayed elements), and normal Redis errors as `{t:'err'}`.

- New server policy configuration: `maxReadReplyBytes` (default 16 MiB; range 1 KiB–64 MiB) is a hard RESP wire-byte
  cap, independent of the display budget; `maxInflightCommands` (default 16; range 1–128) bounds measured commands
  globally and ordinary database requests through response serialization. Per-role pools reject overload with 429,
  without a waiting queue. Typed data reads additionally allow four concurrent requests per user; key scans have a separate two-request limit.
- Console/workbench commands execute once through measured sockets. Overflow destroys that socket and returns
  **413 `too_large`** with the cap and a SCAN/COUNT/ranges hint. Workbench retains its HTTP 200 per-line error format.
  A write that returns too much may already have executed; closing a socket cannot undo it. Timeouts are exact
  deadlines (504); cancellation closes the socket, stops later lines, and frees the script slot promptly.
- No sizing probes, alias expansion, speculative JSON/search grammar, or sized/reviewed command list remain.
  Formerly refused JSON wildcards, search options, FT.CURSOR READ, FT.HYBRID and classified reads are subject to
  command policy/ACLs and measured limits. Redis, rather than a size planner, reports invalid options.
- Typed routes with data-dependent replies use the same cap and a cumulative per-request byte budget. An oversized
  key-browser JSON/stream/collection or search page now gets 413, rather than a prediction or an empty preview.
  SCAN COUNT remains a hint, capped at 1000; consumed key batches are never silently sliced away.
- Parser limits: 100k wire values, depth 32, simple strings/errors at most 64 KiB, other headers at most 512 bytes.
  RESP2/3 scalar/aggregate types, attributes and push frames are decoded; unsolicited command-socket pushes and
  unsupported streamed bulk strings fail closed. Maps retain binary keys for every command on the measured path.
- Pub/sub and MONITOR use measured dedicated sockets too (one cap per event, global command slot for stream lifetime).
  Oversize events close the SSE stream with an `error` event carrying `code: 'too_large'`; ordinary pub/sub previews
  retain their existing 64 KiB truncation. MONITOR simple-string lines also obey the 64 KiB structural ceiling.
- Internal COMMAND metadata has a separate, measured 2 MiB cap, so lowering the data cap cannot erase the policy
  table. Node-redis remains for topology discovery and proven fixed-size typed replies.
- Production rejects catch-all proxy CIDRs (`/0`) in addition to `trustProxy: true`. ACL errors are audited by code,
  never their text. Search planner errors that previously echoed options into audit records no longer exist.

## 2026-10-23 — replycap: workbench cancellation compatibility

Incorporates consolefix commit `15f4a2b`. Additive shared contract: `WorkbenchResponse.cancelled?: { inFlight: boolean }`,
`WorkbenchCancelResponse` and `zWorkbenchCancel`. `POST /databases/:db/workbench/cancel` cancels this session's running
script on that database. Disconnecting also stops later lines. An in-flight mutation may already have executed.
The measured transport settles cancellation by destroying its socket, so the script slot can be released promptly;
the older waiting-for-Redis description below is superseded. `cancelled.inFlight` still truthfully marks a line
that may have executed, preserving the merged web summary: N finished / line X may have run / M not run.

## 2026-10-23 — console fixer (feat/v02-consolefix), v0.2 console review round 1

See `docs/REVIEW-LOG.md` ("Round 1 – console (GPT reviewer)"), finding H1: aborting a Workbench request in the
browser did not stop the server's loop, so write lines after the one in flight still ran.

### `api.ts`
- **`POST /api/v1/databases/:db/workbench/cancel`** (new route; body `{}`, `zWorkbenchCancel`; response
  `WorkbenchCancelResponse { cancelled: boolean }`). Stops the caller's own running script on that database (keyed by
  session and database; another session or user gets `cancelled: false`) before its next line. Any role that can
  reach the database may call it; CSRF/Origin as for every POST; rate limit 5/s (burst 10) per user.
- **`WorkbenchResponse.cancelled?: { inFlight: boolean }`** (new, optional). Present when the script was cancelled:
  the response is sent at once; `results` holds the lines that finished, in script order; with `inFlight: true` the
  next line had been sent and was still running (Redis may have run it); no later line was sent. Absent otherwise.

### Behaviour (no type changes)
- **A client that goes away stops the work**: the workbench loop and the bulk delete check, before every line /
  batch, whether the response's connection closed before the response was sent (fetch aborted, tab closed).
  Nothing more is sent to Redis; the bulk-delete audit detail says `stopped: client disconnected`.
- A line cancelled while running is still audited (`workbench.exec`, allowed/error) when Redis answers, and keeps
  the user's one-script slot until then (a new script gets 429 for that moment). Lines never sent are not audited,
  as for lines skipped after a revocation or an exhausted budget.
- Server policy, confirmations, ACLs and the per-line checks are unchanged; cancelling only removes work.

## 2026-10-23 — server fixer (feat/v02-server2), v0.2 review round 2

See `docs/REVIEW-LOG.md` ("Round 2 – server (GPT reviewer)") for the findings.

### `api.ts`
- **`SearchResult.docs[].idBytes?: number`** (new, optional). `POST /search/query` now counts document ids (key names)
  in its response budget, ids first, measured as JSON text. An id that does not fit is **withheld, never shortened**:
  the document comes back as `{ id: '', idBytes: <length of the id in bytes>, fields: {}, truncated: true }`. Show
  it as "key name not shown (N bytes)"; never use `''` as a key. Field values are now budgeted as JSON text too, so
  values full of control characters are cut sooner (still flagged with `truncated: true`).

### Search page (no type changes)
- **413 `too_large`** when the page's ids alone could exceed `16 × policy.maxReplyBytes` (an indexed key name of
  hundreds of KB or more among the query's matches); narrow the query. Also 413 when the size check (one
  `FT.AGGREGATE` over the matches) does not finish within `policy.commandTimeoutMs`.
- JSON documents count 6 × their memory against the read budget, so fewer large JSON documents are read with
  content (the rest are listed by id with `truncated: true`, as before).

### Console / workbench (no type changes)
- **JSON text is sized with its escaping** (review R2-H1): `JSON.GET`, `JSON.MGET`, `FT.GET`/`FT.MGET` of JSON
  documents count 6 bytes per selected stored byte. New 413s: whole-document reads of JSON documents above about
  2.7 MiB of memory (they came back as up to 16 MiB of text before, cut to 1 MiB in the reply). Definite paths are
  still sized by the selected value (`JSON.GET big $.id` and now also `JSON.MGET k1 k2 $.id` work on documents of
  any size); `..` paths are measured on documents up to about 800 KB of memory.
- **Searches are sized in bytes before they run** (R2-M1). New 413s: `FT.SEARCH`/`FT.PROFILE SEARCH` whose ids,
  `RETURN` fields or documents could exceed the budget (e.g. one 18 MiB document matching `LIMIT 0 1`);
  `FT.AGGREGATE` whose loaded/referenced fields could; `EXPLAINSCORE`; `FORMAT EXPAND`; `HIGHLIGHT TAGS` /
  `SUMMARIZE SEPARATOR` strings over 8 bytes; `FT.AGGREGATE ... LOAD *`, `WITHCURSOR`, APPLY functions that can grow
  a string (`upper`, `lower`, `split`, `matched_terms` ...; fields, numbers, numeric functions, `substr`, `format`,
  `case` and `timefmt` are fine), unknown reducers; `FT.PROFILE ... HYBRID`. **403 `command_blocked`** (and
  `allowed: false` in `GET /commands`): `FT.CURSOR READ`, `FT.HYBRID`.
- **`FORMAT STRING` is accepted** in `FT.SEARCH`/`FT.AGGREGATE` (R2-L1; it was refused as an unknown option).
- When the size check itself gets a Redis error (unknown index, query syntax error, missing parameter, ACL), the
  command is not run and that error is its reply (`{t:'err'}`, HTTP 200), as the command would have returned.
- Deployments: the viewer/operator ACL users need `FT.AGGREGATE` (part of `@read`), `FT.INFO` and `MEMORY USAGE` for
  console searches and the search page.

### Audit and logs (no type changes)
- **New audit actions** (R2-M4): `slowlog.read` (`GET /slowlog`; detail `entries=… len=…`, never the entries) and
  `pubsub.channels` (`POST /pubsub/channels`; the pattern only as `<n bytes>`, detail `channels=…`).
- Failed requests (5xx) are logged on stdout with `detail` = the audit-style failure detail (`redis_error: <CODE>`
  for Redis errors) instead of the error message (R2-M5).

## 2026-10-23 — server fixer (feat/v02-server), v0.2 review round 1

See `docs/REVIEW-LOG.md` for the findings.

### `api.ts`
- **`SearchResult.docs[].truncated?: boolean`** (new, optional). `POST /search/query` now keeps its reply budgets:
  the page is sized before it is read, documents beyond `16 × policy.maxReplyBytes` are listed by id only
  (`fields: {}`, `truncated: true`), and the response shares `policy.maxReplyBytes` across all field names and
  values (each still cut at 4096 characters, now flagged). `total` and the page's ids are unchanged, so
  `offset`/`limit` paging works as before. Show a "cut" hint and offer the key browser for truncated documents.

### Console / workbench (no type changes)
- **RedisJSON reads are sized by what they return** (review H1). New **413 `too_large`** cases: `JSON.GET` with an
  `INDENT`/`NEWLINE`/`SPACE` string longer than 8 bytes, or formatting that could exceed the budget (the budget
  assumes the 128-level nesting limit, so pretty-printing works on documents up to about 64 KiB); `JSON.TYPE`/
  `STRLEN`/`ARRLEN`/`OBJLEN`/`ARRINDEX`/`DEBUG MEMORY` with a multi-match JSONPath (`*`, filters, slices, unions,
  `..`) on documents above about 100 KB (more than 100,000 possible matches); a union selecting more than 64 values
  per match; two `..` segments in one path; `FORMAT EXPAND`/`EXPAND1`, `JSON.RESP` and `JSON.OBJKEYS` above
  100,000 elements; `..` paths or several overlapping paths whose worst case exceeds the budget. Definite paths
  (`$.a.b`, `$.items[0]`, legacy `.a`) are now sized by the selected value, so `JSON.GET big $.id` works on large
  documents.
- **Search options are parsed with the grammar** (review M1): query text and `PARAMS` values are no longer taken for
  `NOCONTENT`/`LIMIT`, so `FT.SEARCH idx LIMIT` works; an option unknown to the RediSearch 8 grammar is refused
  with 413 and a hint (fail closed).
- **`SUNIONCARD`** is allowed (review L1).
- **Command timeouts** (review M3): on a standalone database a command that outlives its timeout still gets
  **504 `timeout`**, but now only the socket that carried it is replaced; other users' commands on the same tier
  are unaffected. On cluster/sentinel databases the tier's connections are still reset; commands in flight on them
  now fail once with **503 `unavailable`** (was 500 `internal`). Metrics streams keep sampling across a reset.

### Audit (no type changes)
- **New audit actions** (review M6), one event per request, outcome `allowed`/`denied`/`error`: `key.read`
  (command = the value read, e.g. `HSCAN`; detail `type=… returned=… length=… [truncated]`), `key.scan` (detail
  `keys=… scanned=…`; the pattern only as `<match n bytes>`), `stream.groups`, `stream.pending`, `timeseries.range`.
  Keys appear only as `key#<sha256 prefix>`; values, patterns, group names and query text never. `search.query`
  now also records failures and a `total=… returned=…` detail.

### Configuration (no type changes)
- With `NODE_ENV=production`, an `environment: "prod"` database needs its own ACL user for **every tier reachable
  under `maxRole`** (review M4): `{viewer, default}` with `maxRole: admin` is now refused (operator/admin would
  connect as `default`), as are two reachable tiers sharing one username. Exception: `acceptRisks:
  ["default-credentials"]`. The `deploy/` examples comply.

## 2026-10-23 — server agent (feat/server), self-review round 2

No type changes. Behaviour the web client and E2E should know:

### `commands.ts` (shared policy)
- **Internal module commands are blocked**: `SEARCH.*`, `TIMESERIES.*`, `FT._*` (except `FT._LIST`) and any name
  starting with `_`. They report `readonly` but change the coordinator's topology, and `SEARCH.CLUSTERINFO` never
  replies on standalone Redis.
- **`FT.CURSOR` is a subcommand parent**: `READ` is a read, `DEL` is a write (operator), `GC` and unknown
  subcommands are blocked. **`CF.COMPACT`** is a write.
- **New read rules** for reads their modules put in no ACL category (or only `@search`): `FT.INFO`, `FT.EXPLAIN`,
  `FT.EXPLAINCLI`, `FT.SPELLCHECK`, `FT.SYNDUMP`, `FT.DICTDUMP`, `FT.ALIASLIST`, and the vector-set reads
  (`VCARD`, `VDIM`, `VEMB`, `VGETATTR`, `VINFO`, `VISMEMBER`, `VLINKS`, `VRANDMEMBER`, `VRANGE`, `VSIM`).
- Server side, a `readonly` flag only makes a **read** together with the `@read` category (and without `@write`);
  otherwise the command is blocked.

### Console / workbench
- **Reads fail closed on reply size**: a read must either be sized before it runs or be on the reviewed list of
  bounded reads. Other reads get **403 `command_blocked`** with a hint, and `GET /commands` reports them with
  `allowed: false` and the same hint. Today this affects the sandbox Redis 8 `AR*` commands, `DIGEST`,
  `TS.NRANGE`/`TS.NREVRANGE`/`TS.READ`/`TS.QUERYLABELS` and any command added later.
- **New 413 `too_large` cases**: `XINFO STREAM k FULL COUNT 0`, `XPENDING` with a huge count, `GEOSEARCH`/
  `GEORADIUS*` without `COUNT` on big keys, `JSON.RESP`/`JSON.OBJKEYS`/`JSON.MGET` on big documents (`JSON.MGET`
  and `FT.MGET` take at most 64 keys), `TS.MGET` matching more than 10,000 series, `HGET`/`HMGET`/`LINDEX`/`LCS`/
  `SET ... GET` on huge values, pops with huge counts, `HSCAN`/`SSCAN`/`ZSCAN` on big compact-encoded keys,
  `VRANDMEMBER` with large negative counts.
- **Search**: at most **1000 rows** with document content (`FT.SEARCH ... LIMIT 0 1000`; 100,000 with
  `NOCONTENT`), every `LIMIT` occurrence counts, a `LIMIT` not followed by two integers is refused,
  **`FT.AGGREGATE` needs `LIMIT` or `WITHCURSOR`** (cursor `COUNT` ≤ 1000), `FT.PROFILE` sizes its inner query,
  `FT.CURSOR READ ... COUNT` ≤ 1000. The web's `FT.PROFILE ... LIMIT 0 20` and `FT.EXPLAIN` are unaffected.
- **Command timeouts now hold after the command was sent**: a command that outlives its timeout gets
  **504 `timeout`**, and that database tier's connections are reset (other in-flight commands on it may fail once
  with 503 and succeed on retry).
- `SLOWLOG GET` replies show `<hidden>` for the client address to non-admins.

### Other routes
- **`GET /slowlog`**: `entry.client` is `<hidden>` for non-admins.
- **Bulk delete**: patterns without a literal character outside `[...]` classes (`[^]*`, `[a-z]*`, `?*`) count as
  "delete every key" (admin, non-prod only), like `*`.
- **`GET /databases` `statusMessage`**: TLS failures read `TLS connection failed (<code>)`; socket errors no
  longer contain host names.
- **Rate limits**: per-IP limits key IPv6 clients by /64 (sign-in also per /48).

### Config
- **`auth.oidc.sessionTtlMinutes`** (optional, 5–10080): a shorter absolute lifetime for OIDC sessions.

## Final main — E2E findings F-05/F-06/F-07

### `DatabaseSummary.features` (additive, F-07)

`GET /api/v1/databases` now returns **`features: DatabaseFeatures`** on every database (required in the type; the
server always sends it):

```ts
interface DatabaseFeatures {
  /** Effective role is admin and the environment is in policy.profilerAllowedEnvironments. */
  profiler: boolean;
}
```

It is computed server-side from the same check the profiler route enforces (`profilerAllowed()` in
`apps/server/src/context.ts`), so the web no longer guesses from the role alone. The web hides the Profiler card
(and shows the reason) when `features.profiler` is false. The route still returns 403 on its own; the flag is
UI-only. Older clients can ignore the field.

### Config (not a contract type, but required): `auth.local.totpEncryptionKey` (F-05)

When local accounts are enabled the config must reference a secret (`{ "env" }` / `{ "file" }`, at least 32
characters) used to encrypt TOTP seeds at rest. No API change.

## 2026-10-24 (later) — server agent (feat/server), web review M1/M2

### Behaviour the web client should know (no type changes) — this round, incl. the server security audit fixes

- **Key browser pages can be smaller than `count`** (`POST /key/read`): the server shrinks the Redis read so the
  key's average element size x count stays within 16 x `maxReplyBytes`, and previews in one page share
  `maxReplyBytes`; elements past that are still listed but cut to 64 bytes with `truncated: true` (sets:
  `truncatedMembers`). Keep paging the usual way (list/zset `offset + items.length`, hash/set `cursor`, stream
  last entry id); never assume a short page means the end (use `total` / cursor `"0"`).
- **Workbench**: one script per user at a time (**429** otherwise; 16 server-wide). Results of one script share
  4 x `maxReplyBytes`; once used up, the remaining lines are returned with `error.code = 'too_large'` and were not
  run. If the user's session ends or the account is disabled/demoted mid-script, the remaining lines get
  `error.code = 'unauthenticated'` (not run). `line` in not-run results is clipped to 200 chars.
- **Bulk delete** stops between batches when the session ends or the account changes: **401**, partial count in
  the audit log.
- **Sessions end (401) when the account changes**: role, password, TOTP or disabled state (users carry an auth
  generation; sessions issued under an older one are refused). A sign-in or password change that races such a
  change fails with 401; sign in again.
- **Console 413** also for `SRANDMEMBER`/`HRANDFIELD`/`ZRANDMEMBER` with negative counts beyond what can be
  bounded (more than one repeat on non-compact encodings; |count| x key size over budget on listpack/intset), and
  for `TS.MRANGE`/`TS.MREVRANGE` over 100k samples (more than 1000 series needs `COUNT`).
- **Console 403 `command_blocked`** for `COPY ... DB n` (the logical database is fixed by config).
- **Non-admins** see `<hidden>` for network addresses in console replies (`CLIENT INFO`/`LIST` `addr`/`laddr`,
  `INFO` `listener*`, `CLUSTER NODES|SLOTS|SHARDS|REPLICAS`, `ROLE`) and for `listener*` in `/overview` `info`.
- **Logout** `redirectUrl` (OIDC, `rpInitiatedLogout`) no longer contains `id_token_hint`; the IdP may show its
  own logout confirmation.

### `ConfirmationChallenge.preview` — what will run (review M1)

Every 428 challenge now carries **`preview: ConfirmationPreview`** (always present; the field is required in the
type). The server builds it from the same argv it will execute, and the token is bound to a hash of the exact
request body, so the preview is exactly what runs when the same body is resubmitted (any other body gets a fresh
428 with its own preview). Render it as text (`visibleText`/`displayBin`), never as HTML.

```ts
interface ConfirmationPreview {
  total: number;                 // commands that will run
  commands: PreviewCommand[];    // in execution order, max PREVIEW_MAX_COMMANDS (50) and a 64 KiB budget
  more?: number;                 // total - commands.length -> show "+N more"
  bulk?: { match: Bin; type?: string; keys?: number; complete?: boolean; sample?: Bin[] };
}
interface PreviewCommand { argv: PreviewArg[]; moreArgs?: number }   // max PREVIEW_MAX_ARGS (20) args listed
interface PreviewArg { kind: 'command' | 'key' | 'pattern' | 'arg'; v: Bin; bytes?: number }
```

- `command`: command/subcommand name. `key`: a key name (also the PUBLISH channel), shown in full up to
  `PREVIEW_KEY_MAX_BYTES` (1 KiB). `pattern`: the bulk-delete glob, in full. `arg`: everything else; shown whole up
  to `PREVIEW_VALUE_FULL_BYTES` (32), otherwise the first `PREVIEW_VALUE_PREFIX_BYTES` (16, cut at a UTF-8
  boundary). When `bytes` is set, `v` is a prefix: show `<v>… (<bytes> bytes)`.
- What each path lists:
  - **CLI**: the one command, after caps (e.g. a blocking timeout of 0 shows as 5).
  - **Workbench**: each line that needs confirmation, in order (on prod: every write); reads are not listed.
    `summary` still says how many.
  - **Ops**: the mapped command (`key.delete` → `UNLINK k1 k2…`, `hash.set` → `HSET key field value…`,
    `stream.group.destroy` → `XGROUP DESTROY key group`, ...). In cluster mode a multi-key delete runs one
    `UNLINK` per key and the preview lists them that way.
  - **Bulk delete**: `SCAN 0 MATCH <pattern> COUNT 1000 [TYPE t]`, then `UNLINK <sample keys>` with `moreArgs` =
    remaining matches; `bulk` = `{match, type, keys, complete, sample}` (count and sample only on the first
    challenge, as with `impact`). Keys are deleted as SCAN finds them, so the set can change if keys are written
    meanwhile.
  - **Client kill** `CLIENT KILL ID <id>`, **slowlog reset** `SLOWLOG RESET`, **FLUSHDB** (via CLI) `FLUSHDB`,
    **publish** `PUBLISH <channel> <message prefix>`.
- The preview is sent only to the requesting user and is **never written to the audit log** (which keeps its
  redacted argv: names, `key#<hash>`, `<n bytes>`).
- Suggested client change (review item 4): for single-key deletes, send the op immediately and let the server
  challenge be the only dialog, now that it shows the key.

### **BREAKING** — no Redis data in URLs (review M2)

Key names, glob patterns, channel names and stream group names were sent in GET query strings, which reverse
proxies, load balancers, WAFs and APM agents log. Every such route is now a POST with a JSON body (or, for SSE, a
single-use subscription id). **The old GET routes are removed, not deprecated**: they answer 404, and any request
(API, health, or SPA deep link) whose query string carries `k`, `key`, `keys`, `match`, `pattern`, `patterns`,
`channel`, `channels`, `group`, `query` or `q` gets **400** before routing or authentication.

The new read POSTs have **no side effects and never ask for confirmation** (no 428, also on prod and read-only
databases). Like every POST they need `Origin` + `X-CSRF-Token` and `Content-Type: application/json`. Bodies are
strict: unknown fields are 400. Keys are `Bin` (`{enc:'utf8'|'base64', data}`), max 64 KiB raw; the base64url `k`
form is gone (`keyToParam`/`keyFromParam` remain in `bin.ts` only for client-side ids; never put them in a URL).

| Old | New | Body (defaults) | Notes |
|---|---|---|---|
| `GET /databases/:db/keys?cursor=&match=&type=&count=` | `POST /databases/:db/keys/scan` | `ScanRequest` `{cursor?: '0', match?: '*', type?, count?: 200}` (`zScanRequest`) | `count` is a JSON number 10..1000. Response `ScanResponse` unchanged. |
| `GET /databases/:db/key?k=<b64url>&cursor=&offset=&count=&full=1` | `POST /databases/:db/key/read` | `KeyReadRequest` `{key: Bin, cursor?, offset?: 0, count?: 100, full?: false}` (`zKeyRead`) | `full` is a boolean. Response `KeyDetails` unchanged. |
| `GET /databases/:db/streams/groups?k=` | `POST /databases/:db/streams/groups` | `{key: Bin}` (`zStreamGroupsRequest`) | Response `StreamGroupsResponse` unchanged. |
| `GET /databases/:db/streams/pending?k=&group=&count=` | `POST /databases/:db/streams/pending` | `{key: Bin, group: string, count?: 100}` (`zStreamPendingRequest`) | Response `StreamPendingResponse` unchanged. |
| `GET /databases/:db/timeseries/range?k=&from=&to=&bucketMs=&agg=&count=` | `POST /databases/:db/timeseries/range` | `TsRangeRequest` `{key: Bin, from?: '-', to?: '+', bucketMs?, agg?, count?: 2000}` (`zTsRangeRequest`) | `from`/`to`/`bucketMs`/`count` are JSON numbers (or `'-'`/`'+'`). Response `TimeSeriesRange` unchanged. |
| `GET /databases/:db/pubsub/channels?pattern=` | `POST /databases/:db/pubsub/channels` | `{pattern?: '*'}` (`zPubSubChannels`) | Response `PubSubChannels` unchanged. |
| `GET /databases/:db/pubsub/stream?channel=a&channel=b&pattern=p*` | 1. `POST /databases/:db/pubsub/subscriptions` → 2. `GET /databases/:db/pubsub/stream?sub=<id>` | 1. `PubSubSubscribeRequest` `{channels?: string[], patterns?: string[]}` (`zPubSubSubscribe`; at least one, max 10 together) → `PubSubSubscription` `{id, expiresAt}` | The id is opaque, **single-use**, bound to the session **and** database, and must be used within 60 s (`PUBSUB_SUBSCRIPTION_TTL_MS`). Unknown/used/expired/other session → 404 `not_found`. Validation (counts, glob `*` limit) happens on the POST (400). The SSE events are unchanged. `EventSource` auto-reconnect reuses the URL and gets 404, so on `error`/`end` create a new subscription before reconnecting. Max 10 outstanding ids per session (older ones are dropped); POST rate limit 10/s per user. |

Unchanged (no sensitive parameters): `GET /metrics/stream`, `GET /profiler/stream?seconds=`, `GET /slowlog?count=`,
`GET /admin/audit?...`, `GET /auth/oidc/callback?code=&state=`.

`ROUTES` changes: `scan`, `key`, `streamGroups`, `streamPending`, `tsRange`, `pubsubChannels` change method/path;
**new** `pubsubSubscribe`. Removed schemas: `zScanQuery`, `zKeyQuery`, `zTsRangeQuery` (replaced by the `*Request`
schemas above; numbers are no longer coerced from strings).

## 2026-10-24 — server agent (feat/server), security review

### `api.ts`
- **`PubSubMessage.truncated?: true` / `PubSubMessage.totalBytes?: number`** (new, optional). Messages larger than
  64 KiB (`KEY_ELEMENT_PREVIEW_BYTES`) are cut to that size on the stream; `totalBytes` is the original size.

### Behaviour the web client should know (no type changes)
- **413 `too_large` from `/cli` and `/workbench`**: unbounded reads are sized before they run and refused when the
  reply would exceed 100,000 elements or 16 x `policy.maxReplyBytes` (e.g. `SMEMBERS`/`HGETALL`/`LRANGE 0 -1` on huge
  keys, `GET` of a very large string, `SRANDMEMBER k -1000000`, `FT.SEARCH ... LIMIT 0 1000000`). `error.hint`
  suggests a ranged or SCAN-family alternative. In the workbench this is a per-line error.
- **429 from `/cli`**: at most 4 console commands in flight per user, and 1 blocking command (`XREAD BLOCK`, `BLPOP`...).
- **Workbench time budget**: after `policy.workbenchBudgetMs` (default 30 s) the remaining lines are not run and
  carry `error.code = 'timeout'`.
- **Glob patterns**: `match` (keys, analysis, bulk delete), pub/sub `pattern`s and console `SCAN ... MATCH` /
  `PUBSUB CHANNELS` patterns may contain at most 8 unescaped `*` (400 otherwise).
- **Console replies**: `CONFIG GET` shows `<redacted>` for password parameters (`requirepass`, `masterauth`, TLS key
  passphrases, anything ending in `-pass`/`-password`); `INFO` omits `executable`, `config_file`, `run_id`,
  `tcp_port`, `master_host`/`master_port`, `master_replid*` and masks replica addresses (same as the overview).
- **Command names** must be printable ASCII (Redis matches names byte-wise); anything else is blocked as invalid.
- **Request bodies** must be `application/json`; `text/plain` is now 415.
- **Audit**: failed sign-ins for unknown usernames are recorded as username `unknown` with a `name#<hash>` tag;
  unknown console commands as command `<unknown command>`; Redis errors only as `redis_error: <CODE>`.
- **SSE**: when the client falls more than 1 MiB behind, events are dropped and reported in the next `dropped`
  event; above 8 MiB the stream ends with `end` `{reason: 'client too slow'}`.

## 2026-10-23 (later) — server agent (feat/server)

### `commands.ts`
- **`tokenizeCommandLineBytes(line): Uint8Array[]`** (new). Same grammar as `tokenizeCommandLine`, but `\xHH` is one raw
  byte and other text is UTF-8. The server uses it for `/cli` `line` and `/workbench` scripts so `"\xff"` reaches
  Redis as byte 0xFF (the string tokenizer can't represent that). `tokenizeCommandLine` is unchanged; use it for
  hints only.

### `api.ts`
- **`zKeyQuery`** (new): query for `GET /databases/:db/key` — `k`, `cursor` (HSCAN/SSCAN cursor, or a stream entry id
  to continue *after*, newest first), `offset` (list/zset), `count` (1..1000, default 100), `full=1` (strings/JSON up to
  the server's `maxValueBytes` instead of the 64 KiB preview).
- **`KEY_ELEMENT_PREVIEW_BYTES` / `KEY_VALUE_PREVIEW_BYTES`** (64 KiB). Collection elements bigger than that are cut
  and flagged: optional `truncated: true` on hash entries, list items, zset members and stream fields; optional
  `truncatedMembers` count on sets. Don't offer to edit or delete a truncated element from its preview bytes.
- Stream values are **newest first**; next page: pass the last entry's `id` as `cursor`.

### Behaviour the web client should know (no type changes)
- **Origin**: every non-GET request needs an `Origin` equal to `server.publicUrl` (or one of `server.extraAllowedOrigins`),
  plus `X-CSRF-Token` when signed in. Browsers send Origin on fetch POST/PATCH automatically. When developing through
  the Vite proxy, either set `RCONSOLE_PUBLIC_URL` to the Vite origin (also makes the OIDC callback land on Vite), or
  add the Vite origin to `server.extraAllowedOrigins` in a local config.
- **Empty POST bodies**: send `{}` with `Content-Type: application/json` (e.g. `POST /slowlog/reset`,
  `POST /auth/totp/enroll`, `POST /auth/logout`); an empty JSON body is a 400.
- **403 hints** while a local account is restricted: `error.hint` = `password_change_required` or
  `totp_enrollment_required` (also visible as `me.mustChangePassword` / `me.mustEnrollTotp`).
- **Reply trees**: simple-string replies (`OK`, `PONG`) arrive as `{t:'str'}`, not `{t:'status'}`, because the
  server decodes them as bytes to keep integers exact (`{t:'int', v}` is the exact 64-bit decimal). Treat `status`
  as unused. `HGETALL`/`XREAD`/`XREADGROUP`/`CONFIG GET` maps keep binary keys.
- **`OpResult.result`** is a `Reply` tree (e.g. `{t:'int', v:'1'}`).
- **`ScanResponse.scanned`** = SCAN calls × COUNT (approximate slots examined). The cursor is opaque (in cluster mode it
  encodes the node), always digits, `"0"` when done.
- **Bulk delete**: a pure-wildcard `match` (`*`, `**`, `?*`) needs the admin role and a non-prod database.
- **SSE** (`/metrics/stream`, `/pubsub/stream`, `/profiler/stream`): unnamed `data:` events carry `MetricsSample` /
  `PubSubMessage` / `ProfilerEvent`. Named events: `ready` (pub/sub: `{subscribed:{channels,patterns}}`, profiler:
  `{seconds}`), `dropped` (`{dropped:n}`, more than 200 events/s were skipped), `error` (`{message}`), `end`
  (`{reason}`, sent right before the server closes: time limit, session ended, shutdown). `: ping` comments every 5 s.
  Pub/sub query: repeat `channel=`/`pattern=` (max 10 total). Profiler `seconds` 1..60 (default 30), admin-only,
  only for `policy.profilerAllowedEnvironments`. Max 3 pub/sub + profiler streams and 5 metrics streams per user (429).
- **Search**: `GET /search/indexes` needs `FT._LIST`, which is in Redis's `@admin` ACL category. The sandbox ACL template
  (`infra/redis/users.acl.template`, merged from `main`) grants `+ft._list +ft.info` to `rc-viewer`/`rc-operator`, so
  every role can list indexes there. Deployments must grant the same to their viewer/operator ACL users, otherwise
  the route answers 403 (`Redis ACL denied the command`).
- **Audit actions**: `auth.login`, `auth.logout`, `auth.totp`, `auth.oidc`, `auth.password`, `auth.totp.enroll`,
  `auth.totp.confirm`, `cli.exec`, `workbench.exec`, `<op>` (e.g. `key.delete`, `hash.set`), `key.bulk-delete`,
  `slowlog.reset`, `client.kill`, `analysis.run`, `search.query`, `pubsub.start|stop|publish`,
  `profiler.start|stop`, `admin.user.create|update|bootstrap`, `metrics.stream`.

## 2026-10-23 — server agent (feat/server)

### `api.ts`
- **`Me.mustEnrollTotp: boolean`** (new required field). Local users whose role is in `auth.local.requireTotpForRoles`
  must enroll TOTP before using anything else; until then every non-auth API returns `403 forbidden`. Order for the
  bootstrap admin: change password (`mustChangePassword`) → enroll TOTP (`mustEnrollTotp`). Needed because the client
  cannot know `requireTotpForRoles`.
- **Response types for routes that had none**: `HealthResponse`, `ReadyResponse`, `TotpVerifyResponse`,
  `PasswordChangeResponse`, `TotpConfirmResponse`, `LogoutResponse`, `DatabasesResponse`, `CommandsResponse`,
  `SlowlogResponse`, `OkResponse`, `ClientsResponse`, `PublishResponse`, `SearchIndexesResponse`,
  `StreamGroupsResponse`, `StreamPendingResponse`, `AuditResponse`, `UsersResponse`. List endpoints wrap arrays in an
  object (`{ databases: [...] }`, `{ users: [...] }`, ...) so fields can be added later.
- **Request schemas**: `zSlowlogQuery` (`?count=`), `zClientKill` (`{ id, confirmation? }`), `zTsRangeQuery`.
- **`OidcLoginError`**: the OIDC callback redirects to `/login?error=<code>` on failure (`oidc_failed`, `oidc_state`,
  `oidc_no_role`, `oidc_disabled`), to `/` on success.
- Documented HTTP status per `ApiError.code` (comment above the new types).
- Password change and TOTP confirm/verify **rotate the session**: the response carries a new `me.csrfToken`; use it.

### `commands.ts`
- `FT._LIST` → `read` and `FT.DROPINDEX` → `write` + `confirm`. Without these rules the COMMAND INFO fallback blocks
  them (`FT._LIST` is in `@admin`, `FT.DROPINDEX` in `@dangerous`).

## v0.2 Console: optional command key specifications (2026-10-23)

`CommandDoc.keySpecs?: CommandKeySpec[]` adds sanitized Redis `COMMAND` key extraction metadata to `GET /databases/:db/commands`. Supported complete specs use `begin: index|keyword` and `find: range|keynum`; unknown/incomplete or malformed specs are omitted, and `not_key` entries are excluded. The server reuses its existing cached COMMAND table: no new Redis requests, credentials or caller-supplied target settings. Existing COMMAND DOCS argument grammar remains the fallback for older servers.

The browser uses this editing metadata for argument-role highlighting and binary-safe key-browser links, including counted key lists, alternating key/value pairs and XREAD's parallel keys/IDs. It is not used to authorize commands or alter audit/cluster-routing behavior. Server policy, confirmations, Redis ACLs, CSP and Trusted Types are unchanged. Reference: https://redis.io/docs/latest/develop/reference/key-specs/ .

## v0.2 web review round 2 — background activity and BOM bytes

- Authenticated requests may send `X-RC-Background: 1`. Authentication, authorization, CSRF, auditing and idle/absolute expiry checks still run. Such requests do **not** call `sessions.touch`, so polling cannot slide idle expiry. Omission preserves existing user-request behavior. Web polling (database/status/overview/channel/key reads) and SSE admission send this header. The session warning refreshes `/auth/me` only on trusted pointer/key activity, at most once per minute; completed polls no longer trigger an unmarked auth refresh.
- Shared `binFromBytes` retains a leading UTF-8 BOM (`ignoreBOM: true`), matching the original bytes. BOM and plain keys no longer alias. API shapes are unchanged; both server and browser must use the updated helper.
- String edits preserve expiry through the existing CLI `SET key value KEEPTTL` path. No new operation contract. Unchecking Keep current expiry explicitly restores SET/TTL replacement behavior.

## v0.2.1 SHELL stream (feat/v021-shell) — additive only

- **`DatabaseSummary.db?: number`** (F13): the configured logical database index (`databases[].db`, 0 when unset), always
  sent by v0.2.1 servers. Display only. The browser cannot choose or change it; `SELECT` stays blocked and no route
  accepts a db index. The browser uses it to pick the selected database's entry out of `DatabaseOverview.keyspace`
  (selected-DB key count) and labels server-wide figures (CPU, memory, clients, ops/s) as server scope.
- **`DatabaseSummary.tags?: string[]`** (F21) and config **`databases[].tags`** (optional, at most 8 labels of 1–32
  letters/digits/space/`. _ / -`, de-duplicated). Display-only landing labels; no policy meaning.
- **`GET /databases/:db/slowlog/config` → `SlowlogConfigResponse`** (F19):
  `{ available: true, slowerThanMicros, maxLen }` or `{ available: false, reason }`. The server runs `CONFIG GET` for
  exactly `slowlog-log-slower-than` and `slowlog-max-len` (never a caller-chosen parameter) on the caller's tier, only
  when `CONFIG GET` (admin class) is allowed for the caller's effective role; other roles, `maxRole` caps and Redis ACL
  denials get `available: false` with a reason (HTTP 200). Audited as `slowlog.config` with the fixed argv. Cluster: the
  first primary's values. `CONFIG SET` stays blocked.

## TOTP key ring and recovery codes (feat/totp-keyring) — additive only

### `api.ts`
- **`Me.recoveryCodesRemaining?: number`**: local accounts with TOTP enabled only (absent for OIDC sessions and
  accounts without TOTP). Unused recovery codes, 0..`RECOVERY_CODE_COUNT`.
- **Constants** `RECOVERY_CODE_COUNT = 10` and `RECOVERY_CODES_LOW = 3` (the UI warns at or below it).
- **`zRecoveryCode`**: 12..32 characters of letters, digits, spaces and hyphens. Codes are shown as `xxxx-xxxx-xxxx`
  (Crockford base32); the server ignores case, spaces and hyphens, and reads o as 0 and i/l as 1.
- **`zTotpVerify`** is now a union: `{ code }` (unchanged) **or** `{ recoveryCode }`, never both. A valid unused code
  completes the TOTP step and is consumed; a wrong/used one is `401 "Invalid code."` and counts towards the lockout.
- **`zLocalLogin.recoveryCode?`**: an account with TOTP can sign in in one request with password + recovery code
  (`{ me }`). A wrong code gets the generic sign-in error. Without it, nothing changes (`{ totpRequired: true }`).
- **`TotpConfirmResponse.recoveryCodes: string[]`**: the first set, shown once. The response type was `{ me }`.
- **New route `recoveryCodesRegenerate: 'POST /api/v1/auth/recovery-codes'`** with `zRecoveryCodesRegenerate`
  (`{ currentPassword }`) → `RecoveryCodesResponse { recoveryCodes: string[]; me: Me }`. Active local session with TOTP
  on (400 otherwise); wrong password is 403 and counts towards the lockout (401 and sessions revoked once locked). The
  old set stops working. Same sign-in rate limit as login/verify/confirm.
- **Audit actions**: `auth.recovery` (allowed/denied; detail has the number of codes left, never a code),
  `auth.recovery.regenerate`, `auth.totp.confirm` detail `10 recovery codes issued`, `system.totp.rewrap` (startup
  re-encryption counts), `admin.cli.reset-totp` and `admin.cli.rotate-totp-key` (host CLI, user `cli:<os user>`).
- Admin `PATCH /admin/users/:id { resetTotp: true }` also deletes the user's recovery codes (shape unchanged).

### Config (not a contract type): `auth.local.totpEncryptionKeys` + `auth.local.totpPrimaryKeyId`
- Key ring `[{ id, secret: {env|file} }]` (1–16, unique ids `^[A-Za-z0-9._-]{1,64}$`, secrets ≥ 32 characters and
  distinct) and the primary key id (required with the ring, must be in it). The single `totpEncryptionKey` stays
  valid as a one-key ring with the id `default`; the two forms are mutually exclusive. `AppConfig.local.totpKeyring`
  replaces `AppConfig.local.totpEncryptionKey` inside the server.
- Stored seeds: `v2:<kid>:<iv>:<ct>:<tag>`; `v1:` and clear text are still read and re-encrypted at startup. Startup
  refuses (exit 78) when a seed does not decrypt with any key of the ring.
