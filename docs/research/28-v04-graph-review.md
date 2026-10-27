# v0.4 review, round 2: FalkorDB graph support (S4b)

Reviewer: Claude Sonnet 5.5 (not the author of this stream; the stream was written by GPT-6.1 Sol).
Snapshot: `release/v0.4` @ `79663bb`. Date: 2026-10-27.

**Result: two High and two Medium findings remain** (H1, H2, M1, M2). Five Low items follow (L1–L5). Everything in
the "checked and sound" section held under live use.

## Scope

- Policy: `packages/shared/src/graphPolicy.ts`, the graph block and `argumentRule` of `packages/shared/src/commands.ts`,
  `applyCaps` in `apps/server/src/policy/policy.ts`, the confirmation path (`routes/cli.ts`, `policy/confirm.ts`,
  `policy/preview.ts`), audit output.
- Web: `lib/graphReply.ts`, `components/GraphView.tsx`, `RichReply.tsx` / `richReply.ts` wiring, the `graphdata`
  key-browser hint, and commit `dfde937` (`lib/policy.ts`: the console verdict comes from the shared rule that matches
  the typed command).
- Infra: the FalkorDB sandbox service, the generated ACL and config templates, `scripts/graph-sandbox-config.sh`,
  the CI sandbox bootstrap.
- Tests and docs: `graphPolicy.test.ts`, server `graph-policy` unit and `graph` integration tests, web `graph.test.tsx`,
  e2e `specs/ui/graph.spec.ts`; ARCHITECTURE "v0.4 graph results and execution", DECISIONS D21, SECURITY
  "v0.4 FalkorDB graph boundary", `docs/qa/v04-graph.md`, the 2026-10-27 CONTRACT-CHANGES entry.

## Environment and method

- Own server instance with the built SPA and a temporary data directory, QA accounts `qa-viewer`, `qa-operator`,
  `qa-admin`, Keycloak `viewer1` and `admin1` (browser OIDC sign-in), driven through the HTTP API and Playwright
  Chromium (headless). The first config was `config/rconsole.dev.json`. Later the instance was restarted on a derived
  config that adds four extra database entries pointing at the same FalkorDB sandbox: `readOnly`,
  `environment: prod`, `maxRole: viewer`, and `prod` + `readOnly`, so the read-only, prod and maxRole rules could be
  exercised without touching any other instance.
- FalkorDB 6.0.3 (`sandbox-graph`, Redis 8.10.2, module args `TIMEOUT_DEFAULT 1000 TIMEOUT_MAX 1000 RESULTSET_SIZE 10000
  MAX_QUEUED_QUERIES 25`). Only that container and its generated ACL users were used. Keys: prefix `rv2g:20261027:`,
  all deleted afterwards. Direct engine access (RESP client as `rc-viewer`, `redis-cli` as `default` for `ACL DRYRUN`,
  `COMMAND INFO` and `GRAPH.INFO`) was limited to reads and my own keys.
- Differential fuzzing of the Cypher guard against the live engine used **`GRAPH.EXPLAIN` only** (it builds a plan and
  executes nothing) on a throwaway graph, with non-existent file names and function names. No network request to any
  external host was made.
- Existing tests, run individually: shared `graphPolicy.test.ts` 27 passed, web `graph.test.tsx` 6 passed, server unit
  `graph-policy.test.ts` 3 passed, server integration `graph.test.ts` 16 passed (live FalkorDB). I did not run the e2e
  suite or the topology script.

## Summary

| ID | Sev | Finding |
|---|---|---|
| H1 | High | The Cypher guard ends a `//` comment at a lone CR; FalkorDB does not. A viewer can hide `LOAD CSV`, user-defined function calls and any `CALL` procedure from the guard. |
| H2 | High | `TIMEOUT` is cooperative: a single expression runs for tens of seconds past it, keeps running after the app answers 504, and one viewer can pin the engine's worker threads. No per-query memory cap. |
| M1 | Medium | The confirmation dialog shows only the first 16 bytes of the Cypher text, so it cannot show what a destructive `GRAPH.QUERY` will do. |
| M2 | Medium | Core `SLOWLOG GET` (viewer-readable, in the viewer ACL) shows other users' Cypher, including data literals; D21 and SECURITY say query logs are admin-only. |
| L1 | Low | The browser shows admin graph reads (`GRAPH.SLOWLOG`, `GRAPH.CONFIG GET`) as blocked on read-only databases, with the wrong reason, while the server runs them. |
| L2 | Low | Undocumented guard false positive on list slices (`[0..size(x)]`); the browser and server guards also disagree on non-ASCII whitespace. |
| L3 | Low | An operator can delete a whole graph with `DEL`/`UNLINK`/`RENAME` (plain confirm) or `DETACH DELETE`; the "GRAPH.DELETE is admin + typed" tier is not a barrier. |
| L4 | Low | The key browser shows `40 B` for a 37 MB graph key and prints an unrelated generic sentence next to the graph hint. |
| L5 | Low | Keyboard access: up to 200 tab stops in front of the result table, and edges are not focusable. |

---

## Findings

### H1. The guard and FalkorDB disagree about where a `//` comment ends, which hides `LOAD CSV`, UDF calls and procedures

- **Where:** `packages/shared/src/graphPolicy.ts:14` (`while (i < query.length && query[i] !== '\n' && query[i] !== '\r')`).
  Applies to `GRAPH.QUERY`, `GRAPH.RO_QUERY`, `GRAPH.EXPLAIN`, `GRAPH.PROFILE` through `argumentRule`
  (`commands.ts`), for every role, and to the browser hint (`web/lib/policy.ts`, same function).
- **Engine fact (FalkorDB 6.0.3):** a `//` comment ends at LF only. A lone CR stays inside the comment. As viewer,
  directly on the engine:
  - `RETURN 1 AS a //x<CR>, 2 AS b` returns one column (`a`); the `, 2 AS b` was swallowed by the comment.
  - `RETURN 1 AS a //x<LF>, 2 AS b` and `…//x<CR><LF>, 2 AS b` return `a` and `b`.
  The guard ends the comment at CR as well. After a CR the guard is therefore in code state while the engine is still
  in the comment. A backtick placed right after the CR opens an "identifier" for the guard that swallows everything up
  to the next backtick, while for the engine that backtick is comment text, and the code after the next LF is live.
- **Reproduction (API, `qa-viewer`, `sandbox-graph`; `<g>` is any existing graph key):**
  1. Control: `POST /api/v1/databases/sandbox-graph/cli` `{"argv":["GRAPH.RO_QUERY","<g>","RETURN lib.fn(1)"]}` →
     `403 command_blocked` (as designed).
  2. UDF call: same route, query ``RETURN 1 AS a //x\r`\n, rv2g.fn(1) AS b\n//` `` (JSON escapes for CR and LF) → **`200`**,
     reply `err: Unknown function 'rv2g.fn'`. That error comes from the engine looking the function up in its UDF
     registry, so a library named `rv2g` exposing `fn` would have been executed.
  3. Procedure: ``//x\r`\nCALL rv2g.nope() YIELD x RETURN x\n//` `` → `200`, `err: Unknown function 'rv2g.nope'`
     (the engine resolved the CALL). `CALL algo.pageRank(...)` hidden the same way is accepted by the guard (shown by the failing test below, not run
     against the engine).
  4. LOAD CSV, plan only: `GRAPH.EXPLAIN <g> "//x\r`\nLOAD CSV FROM 'file:///nonexistent.csv' AS row RETURN row\n//`"` →
     `200`, plan lines `Project`, `    Load CSV`.
  5. LOAD CSV, executed (non-existent file): `GRAPH.RO_QUERY` with the same query → `200`,
     `err: Failed to canonicalize import folder path '/var/lib/FalkorDB/import/': No such file or directory`. The
     engine's loader ran; this sandbox merely has no import folder.
  6. Browser: Workbench as Keycloak `viewer1` (and `admin1`), line
     `GRAPH.EXPLAIN <g> "//x\r`\nLOAD CSV FROM 'file:///nonexistent.csv' AS row RETURN row\n//`"` (redis-cli escapes): the
     policy line reads "1 command · 1 read", Run is enabled, the result is the plan tree with `Load CSV`. The hint
     uses the same guard, so the UI does not warn either.
- **Failing test** (kept out of the commit; add to `packages/shared/src/graphPolicy.test.ts`). All three cases fail
  today with "expected undefined to be defined" (3 of 3):

  ```ts
  const hiddenLoad = "//x\r`\nLOAD CSV FROM 'file:///nonexistent.csv' AS row RETURN row\n//`";
  const hiddenUdf = 'RETURN 1 AS a //x\r`\n, lib.fn(1) AS b\n//`';
  const hiddenCall = '//x\r`\nCALL algo.pageRank(null, null) YIELD node RETURN node\n//`';
  it.each([hiddenLoad, hiddenUdf, hiddenCall])('refuses a lone CR inside a line comment (%j)', (q) => {
    expect(graphQueryRefusal(q)).toBeDefined();
    for (const cmd of ['GRAPH.QUERY', 'GRAPH.RO_QUERY', 'GRAPH.EXPLAIN', 'GRAPH.PROFILE']) expect(argumentRule([cmd, 'g', q])?.class).toBe('blocked');
  });
  ```
- **How it was found:** a differential fuzz (guard verdict vs. what `GRAPH.EXPLAIN` makes of the same bytes). Random
  noise (2.4 M queries over two runs with different templates) produced one hit; a systematic search (22.6 M prefix/suffix combinations of 22 lexical
  fragments, 1.2 M of them accepted by the guard and explained) found none without CR. With CR in the alphabet the same
  search finds 159 hits on the unfixed guard.
- **Impact:** the central control of D21 ("cannot run host I/O or user code") is bypassed by every role that can
  reach an RO_QUERY or EXPLAIN, that is viewers. The ACL tier does not help: `rc-viewer` is granted
  `graph.ro_query` and `graph.explain`.
  - LOAD CSV: reads files inside the engine's `IMPORT_FOLDER` and, depending on the deployment, fetches HTTP(S)
    URLs from the Redis host (FalkorDB's own address guard is then the only barrier). Reaching the loader is
    reproduced; reading a real file or making a request was not attempted (no import folder here; no external
    requests allowed).
  - UDFs: name resolution is reproduced. A library loaded into the engine by any other client can be invoked by a
    viewer with their own arguments. Not reproduced beyond name resolution (no library was loaded).
  - Procedures: any `CALL` (`algo.*`, `db.idx.*`, `dbms.*`). RO_QUERY still refuses write procedures at the engine;
    through QUERY/PROFILE an operator reaches the write ones (they could already write).
- **Suggested fix:**
  1. End `//` comments at LF only and fail closed on a CR that is not followed by LF. A candidate patch of four lines
     (loop condition `query[i] !== '\n'`; inside the loop `c === 13 ? query[i + 1] !== '\n' : (c > 126 || (c < 32 && c !== 9))`
     returns `undefined`) was validated against the engine: the same random run (seed that hit) and the 28.1 M
     systematic run, this time with CR in the alphabet, produce **zero** hits.
  2. Defence in depth: have the guard emit the text it analysed (comments replaced by one space) and send that text,
     so the engine cannot read comment boundaries differently. Strings and backticks matched the engine in every probe
     (see "checked and sound").
  3. Add a live differential test to `graph.test.ts` (it already has one live lexer regression): EXPLAIN a corpus of
     tokenisation probes (lone CR, CR LF, NUL, doubled quotes and backticks, backslash forms) and require that the
     guard refuses whatever the engine reads as `Load CSV`, a `CALL`, or a namespaced call.
  4. Deployment hardening that does not depend on the lexer: point `IMPORT_FOLDER` at an empty, unreadable directory
     and deny egress from the FalkorDB host; add both to INSTALL §5. (This sandbox's missing import folder is what kept
     step 5 harmless.)

### H2. `TIMEOUT` ≤ 1000 ms is not a bound: single expressions overrun it, the engine keeps running after the app gives up, and one viewer can pin the worker threads

- **Where:** `apps/server/src/policy/policy.ts:239-255` (the `TIMEOUT` rewrite), `docs/SECURITY.md` ("the sandbox module
  bounds read **and write** execution with TIMEOUT_DEFAULT/MAX"), D21, `docs/INSTALL.md` §5, `routes/cli.ts:75`
  (per-user blocking slot) and `timeoutFor` (7 s for blocking commands). The sandbox config has
  `QUERY_MEM_CAPACITY 0` (`GRAPH.CONFIG GET *`), `THREAD_COUNT 18`.
- **Why:** FalkorDB checks the timeout between records and operators, not inside one expression. A list or string
  comprehension over one record is not interruptible.
- **Reproduction (API as `qa-viewer`; each call is `GRAPH.RO_QUERY <g> "RETURN size(reduce(s = '', i IN range(1,N) | s + 'x'))"`,
  the app appends `TIMEOUT 1000`; `<g>` an existing graph key):**

  | N | Engine time | Result |
  |---|---|---|
  | 200,000 | 692 ms | normal reply |
  | 400,000 | 2,562 ms | `Query timed out`, but only after 2.5 s (timeout is 1 s) |
  | 1,000,000 | about 13–16 s | the app answered `504 timeout` after **7.0 s**; the engine was still running (see below) |

  The time grows quadratically. In contrast, a streaming query (`MATCH (a),(b),(c) RETURN count(*)` over 30,000 nodes)
  stops at 1.00 s as designed, also with `TIMEOUT 0` and `TIMEOUT 99999999` (both normalised to 1000).
- **After the socket closes:** with `GRAPH.INFO` read directly (default ACL user, not through the console) during the
  N = 1,000,000 call: at t = 1.5 s `Running queries … Execution duration 1510 ms` with the full query text, and at
  t = 12 s the same query at `12029 ms`, **five seconds after the app had returned 504**. It was gone by t = 17 s.
- **Accumulation:** the per-user blocking slot (`MAX_BLOCKING_PER_USER = 1`, graph commands carry the `blocking`
  flag) is released when the app answers at 7 s, not when the engine finishes. Request A at t = 0; request B at
  t = 8 s: at t = 9.5 s the engine listed two running queries (9,515 ms and 1,513 ms), and A finished only at about
  t = 15 s. A viewer who repeats this every 7 seconds adds one pinned worker thread each time; at 18 threads
  (`THREAD_COUNT`) the pool is full and the 25-slot queue (`MAX_QUEUED_QUERIES`) fills next. Runtime scales with N²:
  N = 10,000,000 would pin a thread for roughly 25 minutes (extrapolated from N = 1,000,000, **not run**).
- **Memory (unreproduced, deliberately not executed):** `QUERY_MEM_CAPACITY` is 0 (unlimited). `RETURN size(range(1,N))`
  with N = 20,000,000 took 123 ms and about 320 MB transiently, so the cost is roughly 16 bytes per element with no
  cap and no timeout check inside `range()`. A viewer-sized N of 2·10⁹ would ask for tens of GB; I did not run it because
  it could kill the shared sandbox. If the process is killed, every key in that Redis goes with it.
- **Impact:** any viewer can deny the graph engine to all users with a single repeating `RO_QUERY` (engine threads and
  queue), contrary to the documented bound; the memory path may take the whole Redis down. Non-graph traffic on the
  main thread is not affected by the thread pinning.
- **Suggested fix:**
  1. Set `QUERY_MEM_CAPACITY` (and consider a lower `THREAD_COUNT`) in the sandbox template and require them in INSTALL
     and in the CI readiness check, next to `TIMEOUT_MAX`.
  2. Keep a per-database graph slot (for example 4) held until the engine has actually answered or until
     `TIMEOUT_MAX` plus a margin has passed, whichever is later, instead of releasing it at the app's 7 s timeout. The
     engine cannot be cancelled from here, but the console can stop adding work.
  3. State plainly in D21/SECURITY that the timeout is cooperative and that viewer `RO_QUERY` can be withheld per tier
     (drop `+graph.ro_query` from the viewer ACL, or use `maxRole`) where untrusted viewers exist.
  4. A lexical ban on `reduce(`/`range(` is not a fix (many other amplifiers exist); do not rely on it.

### M1. The confirmation preview cuts the Cypher to 16 bytes, so it cannot show what a destructive query does

- **Where:** `packages/shared/src/api.ts:93-95` (`PREVIEW_VALUE_FULL_BYTES = 32`, `PREVIEW_VALUE_PREFIX_BYTES = 16`),
  `apps/server/src/policy/preview.ts:40` (`previewArg`), `routes/cli.ts:57-62` (`prepare` builds the preview from the
  capped argv). D21 relies on it: "Confirming every write command makes the consequence clear".
- **Reproduction:** as `qa-operator` on `sandbox-graph`, `GRAPH.QUERY <g> "MATCH (n:Person) WHERE n.age > 30 AND n.country = 'DE' DETACH DELETE n"`.
  - API: `428` with `preview.commands[0].argv` =
    `GRAPH.QUERY`, `<g>`, `MATCH (n:Person)` (flagged `bytes: 70`), `TIMEOUT`, `1000`.
  - Browser (Workbench, operator): the dialog reads "Run a workbench script with 1 destructive command(s) …
    `GRAPH.QUERY <g> "MATCH (n:Person)"… (70 bytes) TIMEOUT 1000`". `WHERE …` and `DETACH DELETE` are not shown.
  - A query of 32 bytes or less is shown whole (`MATCH (n) DETACH DELETE n`), which is why the short probes in the
    author's tests do not notice.
- **Impact:** QUERY and PROFILE are confirmed on every call, and confirmation is the only guard before a Cypher
  mutation. The token does bind the full argv (checked: a swapped argv is refused, see the sound list), but the person
  confirming cannot read the part that matters. In a Workbench script with several graph lines they see a list of 16-byte
  prefixes.
- **Suggested fix:** show the Cypher in full for graph query commands (up to a cap of, say, 4 KiB, then "N more bytes"),
  in a monospaced block. `previewCommand` can take the query index as a "show in full" argument for
  `GRAPH.QUERY`/`GRAPH.PROFILE`. The `1 destructive command(s)` wording for a single query is also a little odd.

### M2. Viewers can read other users' Cypher through the core slow log

- **Where:** `infra/redis/users-graph.acl.template` (`+slowlog|get` for every tier), `shared/commands.ts:209`
  (`SLOWLOG|GET` is a viewer read), `routes/diagnostics.ts:60-75` (`GET …/slowlog`); contradicts
  `docs/DECISIONS.md:514-515` ("INFO running/waiting … disclose other users' query text … SLOWLOG includes query
  text and remains admin-only") and `docs/SECURITY.md:139` ("query logs/config reads require admin").
- **Reproduction:** as `qa-operator`, `GRAPH.QUERY <g> "UNWIND range(1,30000) AS i CREATE (:Secret {note:'rv2g-operator-secret-marker', n:i})"`
  (30 ms; the sandbox's `slowlog-log-slower-than` is 1000 µs, the Redis default is 10,000 µs). Then as `qa-viewer`
  `SLOWLOG GET 10` in the console: the first entry is
  `GRAPH.QUERY <g> UNWIND range(1,30000) AS i CREATE (:Secret {note:'rv2g-operator-secret-marker', n:i}) TIMEOUT 1000`.
  The Diagnostics route returns the same: `GET /api/v1/databases/sandbox-graph/slowlog?count=5` as viewer contained
  an operator-written literal (`rv2g-victim@example.invalid`). Redis truncates each slow-log argument at 128 bytes.
  INFO output (`commandstats`, modules) carries no query text; bare `GRAPH.INFO` is correctly refused.
- **Impact:** the boundary D21 describes does not hold. Cypher text commonly carries the data (literals in `CREATE`,
  `WHERE` filters), and any slow query is exposed to every viewer of the database. This is the generic slow-log
  behaviour for all commands (a slow `SET key value` is exposed the same way), but the graph documents claim
  otherwise and graph queries are the commands most likely to embed data in the command text.
- **Suggested fix:** in `redactReply` (and the Diagnostics slow-log mapper), for non-admins replace the arguments of
  `GRAPH.*` entries from the query argument on with `<n bytes>`, as the audit does; or state the limitation in D21,
  SECURITY and INSTALL and drop `+slowlog|get` from the viewer tier where that matters.

### L1. The browser blocks admin graph reads on read-only databases that the server allows

- **Where:** `apps/web/src/lib/policy.ts:73` (`!(database.readOnly && commandClass !== "read")`) and `:83`; the server
  exempts `ADMIN_READS` (`apps/server/src/policy/policy.ts:51`, includes `GRAPH.CONFIG` and `GRAPH.SLOWLOG`).
- **Reproduction:** as `qa-admin`, on the read-only variant database, Workbench, type `GRAPH.SLOWLOG <g>`: Run is disabled
  and the policy line reads "This database is read-only. Writes are refused for every role." Same for
  `GRAPH.CONFIG GET TIMEOUT_MAX` (and for the older `CONFIG GET maxmemory`). The API on the same database answers
  `200` for both (matrix below). dfde937's comment says the browser applies the server's rule for read-only, but it
  does not mirror the admin-read exemption.
- **Impact:** on a read-only graph database (the typical prod-like case) the admin cannot read the slow log or config
  from the console, and gets a wrong reason. Fail-safe, low.
- **Suggested fix:** export the admin-read set (or `isMutating`) from `@rconsole/shared` and use it in both places.

### L2. An undocumented false positive on list slices, and a browser/server mismatch on non-ASCII whitespace

- **Where:** `graphPolicy.ts:62-66` (`ts[i - 2] === '.'`), and the guard's input differing between browser (JS string) and
  server (`latin1` of the bytes).
- **Reproduction:** `RETURN [1,2,3,4][0..(1+1)]` and `RETURN [1,2,3,4][0..size([1])]` both run in FalkorDB 6.0.3
  (results `[1, 2]` and `[1]`). The guard refuses both with "Namespaced and quoted function calls are disabled",
  because the `..` range operator gives `ts[i-2] === '.'`. `list[0..size(list)-1]` is a common idiom.
  Separately: a query with U+00A0 between tokens is "1 read" in the browser (`\s` matches) but `403` on the server
  (bytes `C2 A0`, fail closed).
- **Documented false positives that I confirmed** (all valid in the engine, refused by the guard): `n.load`, a label
  `:Load`, `$load`, `vec.euclideanDistance(...)`, `CALL { … }`, `CALL db.idx.fulltext.queryNodes(...)`,
  `CALL db.idx.vector.queryNodes(...)`. Vector and full-text search are therefore unavailable; acceptable for a first
  release and the document says so, but call it out in the user guide.
- **Suggested fix:** count a dot as a namespace separator only when the token before it is an identifier or a quoted
  identifier (not `.`, a digit or `]`). Run the browser hint on the same representation as the server.

### L3. The admin-only, typed `GRAPH.DELETE` tier can be bypassed by an operator

- **Where:** D21 ("GRAPH.DELETE is admin with typed database confirmation"), SECURITY, the `DEL`/`UNLINK`/`RENAME` rules
  in `commands.ts:40-43`.
- **Reproduction:** `qa-operator`: create a graph, `TYPE` → `graphdata`, `GRAPH.DELETE` → `403`, `RENAME` → confirm
  (level `confirm`) → `200`, `DEL` → confirm → `200`, `EXISTS` → `0`. `MATCH (n) DETACH DELETE n` is available through
  `GRAPH.QUERY` to every operator as well.
- **Impact:** the docs imply that deleting a graph needs an admin and a typed name. It does not; this is ordinary
  operator reach (any key can be deleted), so Low.
- **Suggested fix:** reword D21 and SECURITY ("`GRAPH.DELETE` is the admin tier; operators can still remove graph data
  with `DEL` or Cypher").

### L4. The key browser mis-sizes graph keys and prints an unrelated sentence

- **Where:** `routes/keys.ts` meta (core `MEMORY USAGE`), `apps/web/src/components/KeyContent.tsx:549`.
- **Reproduction:** a 600,000-node graph: `MEMORY USAGE <g>` → `40`; `GRAPH.MEMORY USAGE <g>` → `total_graph_sz_mb 37`. The UI showed `40 B` for the 2-node graph I opened and gets the same core number for any graph. The detail also shows the new hint ("Values of type graphdata are not shown … GRAPH.RO_QUERY
  in the Workbench") **and** the old generic text "The key browser does not read this type yet … (for example
  BF.INFO or CF.INFO)".
- **Impact:** misleading size; I did not check the Analysis page's biggest-keys ranking (unreproduced there, but it
  uses the same number).
- **Suggested fix:** show "not measured" for `graphdata` (or call `GRAPH.MEMORY USAGE`, which is cheap: 12 ms at
  600,000 nodes), and suppress the generic sentence when a type hint exists.

### L5. Keyboard: 200 tab stops and no way to reach edges

- **Where:** `components/GraphView.tsx` (every node has `tabIndex={0}`; edges carry only a `<title>`).
- **Reproduction:** a 300-node result: 200 `[tabindex="0"]` nodes in the first diagram, in front of the result table; no
  skip link or arrow-key navigation. Edge details (type, endpoints) exist only as a hover title, and edge properties
  are not shown anywhere but the table.
- **Suggested fix:** one tab stop for the diagram with arrow-key movement (roving tabindex) or a "skip diagram" link;
  list edges for the selected node and show edge properties.

---

## Checked and sound

### 1. Reachable by role

- **API matrix** (`POST …/cli`, `sandbox-graph`, local `qa-*` accounts; anonymous is `401` for every shape):

  | Shape | viewer | operator | admin |
  |---|---|---|---|
  | `GRAPH.LIST`, `GRAPH.INFO ObjectPool`, `GRAPH.MEMORY USAGE g [SAMPLES n]`, `GRAPH.RO_QUERY`, `GRAPH.EXPLAIN` | 200 | 200 | 200 |
  | `GRAPH.QUERY`, `GRAPH.PROFILE` | 403 forbidden | 428 confirm | 428 confirm |
  | `GRAPH.DELETE g` | 403 | 403 | 428 typed |
  | `GRAPH.SLOWLOG g`, `GRAPH.CONFIG GET x` (also lowercase `get`) | 403 | 403 | 200 |
  | bare `GRAPH.INFO`, `GRAPH.INFO RUNNING`, `GRAPH.INFO ObjectPool x` | 403 command_blocked | same | same |
  | `GRAPH.MEMORY` without `USAGE`, extra args, `SAMPLES abc` (400 validation) | blocked | blocked | blocked |
  | `GRAPH.CONFIG SET/GET`(short)/`GET a b`, `SLOWLOG g RESET`, `COPY`, `CONSTRAINT`, `UDF`, `BULK`, `RESTORE`, `DEBUG`, `EFFECT`, `RECORD`, `GRAPH.FOO` | blocked | blocked | blocked |

  Option grammar: `TIMEOUT 0` and `99999999` become `1000`, `TIMEOUT 5` stays 5, `TIMEOUT abc`, a repeated `TIMEOUT`,
  a repeated `--compact`, an unknown option and a missing query are `400`; a 64 KiB+ query is `403`. Mixed-case names work.
- **Redis ACL tier** (`ACL DRYRUN` per user, no execution): every refused shape above is refused by the ACL too —
  viewer cannot `GRAPH.QUERY/PROFILE/DELETE/SLOWLOG/CONFIG GET`, operator cannot `DELETE/SLOWLOG/CONFIG`, nobody
  (admin included) can `GRAPH.CONFIG SET`, `COPY`, `CONSTRAINT`, `UDF`, `BULK`, `RESTORE`, `DEBUG`, `EFFECT`, `RECORD`, bare
  `GRAPH.INFO`, `GRAPH.INFO RUNNING`, `GRAPH.MEMORY FOO`. `COMMAND INFO` confirms none of the 18 graph commands has an
  ACL category, so the explicit grants are what counts. The first-argument grants (`+graph.info|objectpool`,
  `+graph.config|get`, `+graph.memory|usage`) are enforced on Redis 8.10.2 (documented as deprecated; the INSTALL note to
  revalidate on upgrade is right).
- **Executing user:** `CLIENT LIST` as admin right after one call per role showed `rc-viewer` with
  `last-cmd=graph.RO_QUERY`, `rc-operator` with `graph.QUERY`, `rc-admin` for the admin connection.
- **readOnly / prod / maxRole** (derived config, same FalkorDB): on `readOnly` (also `prod` + `readOnly`) `QUERY`, `PROFILE`
  and `DELETE` are `403 read_only` for operator and admin and never offer a challenge; reads, `EXPLAIN`, `MEMORY`, and for
  admin `SLOWLOG`/`CONFIG GET` are `200`. On `maxRole: viewer` the admin's effective role is viewer: reads `200`,
  everything else `403 forbidden` (including `SLOWLOG`, `CONFIG GET`, `DELETE`). On `prod`: `QUERY`/`PROFILE`/`DELETE` ask for the
  database name **and** a reason (`428 typed+reason`); a missing reason, a wrong name, or both are refused with a fresh
  challenge, and the reason appears in the audit line.

### 2. Confirmations

- The preview and the executed argv are the same normalised argv (`prepare` in `routes/cli.ts`): `TIMEOUT 50` shows
  `50`, `TIMEOUT 999999` shows `1000`, a missing one shows `1000`. (The text it shows is the issue in M1, not its
  source.)
- Token reuse: a token issued for `RETURN 1` used with a different argv → `428 Confirmation does not match this
  request`; a used token → `428 expired or invalid`; the same command in `line` form instead of `argv` →
  mismatch; an operator's token used from the admin's session → mismatch.
- `GRAPH.DELETE`: a wrong typed name → `428`, the database **name** (not the id) is the expected text; correct name →
  executes. `GRAPH.QUERY` uses level `confirm` and runs after one click; the same applies to `PROFILE`.
- Prod: see section 1.

### 3. Resource bounds (besides H2)

- Streaming queries stop at 1.00 s (cartesian count, 3 runs).
- Reply caps through the measured transport: `MATCH (n:Secret) RETURN n` (10,000 node rows) → `413 too_large`
  ("Redis reply exceeded the element or nesting limit"); 10,000 scalar rows and a 20,000-row UNWIND → `200` with
  `more` set on the array (10,000 elements kept); 500 rows of a 3,000-byte string → about 1 MiB, truncated with `more`;
  a single row collecting 30,000 nodes → `200`, nested `more`. The renderer labels such replies incomplete.
- Renderer caps in Chromium as viewer (300 nodes, 299 chain edges): the first diagram drew 200 nodes and said "100 more
  nodes not drawn"; the edge result drew 200 endpoint nodes and 199 edges and said "100 more edges not drawn"; a
  1,200-row scalar result showed 1,000 rows and "1,000 of 1,200 rows". Plan caps are covered by the unit test.
- Core `MEMORY USAGE` on a 600,000-node graph takes about 1 ms. `DUMP` of it (a viewer read in the existing policy)
  took 78 ms on the main thread and came back `truncated`; not graph-specific, noted only.

### 4. Data leaving the server

- Audit lines for QUERY/RO_QUERY/EXPLAIN/PROFILE carry only `argvRedacted` (`["GRAPH.QUERY","key#<hash>","<44 bytes>"]`),
  no Cypher, no literals. The same for denials and for the `confirmation_required` lines. Errors audit as
  `redis_error: ERR` (code only), even when the engine's error echoes the user's query. I searched the server log
  for the marker literals used above: none.
- The error returned to the caller contains the caller's own query context (`Invalid input … errCtx: …`); fine.
- URLs and storage: the page URL stays `/db/<id>/workbench`; `localStorage` holds `rconsole.theme` and
  `rconsole.database` only; `sessionStorage` is empty; neither contains the key name, query or hostile text. No request
  left the app origin except the OIDC redirect (Keycloak runs).
- Other users' query text: see M2 (slow log) and the H2 note on `GRAPH.INFO` (blocked for every role in the console).

### 5. Cypher lexical guard (besides H1)

Engine behaviour measured with `GRAPH.EXPLAIN`/`RO_QUERY` and compared with the guard:

- Backslash inside backticks is literal; `\'` and `\"` escape inside strings; both match the guard.
- Doubled quotes (`'a''b'`) and doubled backticks are **not** escapes in the engine (two adjacent tokens, a parse
  error), whereas the guard treats them as escapes. The quote state after any run of quotes is the same for both, so
  there is no exploitable divergence; worth a comment in the code.
- The engine requires valid UTF-8 (`Couldn't parse as UTF-8 string`), so binary argv with invalid bytes never parses.
  The server guard sees the bytes as `latin1`, so every byte of a multi-byte character outside a string or comment is
  refused.
- NUL truncates the engine's view of the query; the guard sees more, which is the safe direction. `\v`, `\f` and `\x1c` are
  not whitespace for the engine (parse error); the guard treats them as whitespace, also harmless.
- Block comments match; `/*/` is not closed by its own slash in both.
- Beyond CR (H1): 2.4 M random and 22.6 M systematic combinations of 22–60 lexical fragments around `LOAD CSV`, a
  namespaced call, a quoted call, `CALL`, a call after `db.labels()` and after a `CYPHER` parameter prefix found no
  other case where the guard accepts and the engine reads the feature. The three allowed procedures
  (`db.labels()`, `db.relationshipTypes()`, `db.propertyKeys()`, also with `YIELD`) run as viewer and return their rows.
- The 64 KiB query cap is applied before tokenising; the tokeniser is linear in practice.

### 6. Rendering

Chromium, `qa-viewer`, `qa-operator`, `qa-admin`, Keycloak `viewer1`, `admin1`. A hostile graph (label
`<img src=x onerror=alert(1)>`, property `<script>alert(1)</script>`, `javascript:alert(1)`, a bidi override, a 3,000-character
string, `<b>bold</b>&amp;`, an edge type `<b>REL</b>`) rendered as text in the diagram `<title>`s, labels and the selection
panel; no `img`, `script`, `[onload]`, `[onerror]` or `a` element appeared in the view; the bidi character is shown as
the escape `‮`; no dialog fired. **Zero `securitypolicyviolation` events (CSP and Trusted Types) and zero page
errors** in every session; the only console messages are the expected 4xx/428 resource lines. Enter and Space select a
node (`aria-pressed`); the selection shows the labels and all properties as text. `9223372036854775807` stays exact
in the result table (`int` replies are decimal strings; unit tests cover IDs above 2⁵³). The plan tree renders for
EXPLAIN. No external asset or request.

### 7. The console (dfde937)

In the Workbench as viewer, operator and admin (local) the policy line and the Run button matched the server matrix for 23
shapes each. Valid shapes show allowed and run: `GRAPH.INFO ObjectPool`, `GRAPH.MEMORY USAGE g`, `GRAPH.RO_QUERY` (also
lowercase), `GRAPH.EXPLAIN`, `GRAPH.LIST`; admin additionally `GRAPH.SLOWLOG g` and `GRAPH.CONFIG GET x` ("1 admin"). As
Keycloak `admin1` all five commands of a script returned `success`. Role-blocked shapes show the generic "unavailable for
your role or database"; refused shapes show their rule hint: bare `GRAPH.INFO` and `GRAPH.INFO RUNNING` (ObjectPool hint),
`GRAPH.CONFIG SET`, `GRAPH.UDF`, `GRAPH.SLOWLOG g RESET`, `GRAPH.COPY`, `GRAPH.FOO`, LOAD CSV, `CALL algo…`, `lib.f(1)`.
The read-only exception is L1. The key-browser hint for `graphdata` appears (L4 for its neighbours).

## Not covered

- LOAD CSV reading a real file or URL, an executed UDF, and the memory-exhaustion path of H2 (all deliberately not run;
  see the findings for what is and is not reproduced).
- Cluster, Sentinel and failover behaviour of the graph module, mobile layouts, assistive technology other than
  keyboard use, the Analysis page's treatment of graph keys.
- Keycloak `operator1` in a browser (the local operator account covered the operator paths with the same effective
  role).

## Cleanup

Server stopped by PID, all `rv2g:20261027:` keys deleted from `sandbox-graph` (checked with a key scan), temporary data
directory and derived config removed. No code or test file was changed; the temporary reproduction test for H1 was
removed before committing this report.
