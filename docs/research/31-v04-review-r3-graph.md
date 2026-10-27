# v0.4 review, round 3: FalkorDB graph support (verification of the round-2 fixes)

Reviewer: Claude Sonnet 5.5 (reviewer of round 2; the fixes were written by Claude Opus 5.5, the stream by GPT-6.1 Sol).
Snapshot: `release/v0.4` @ `2fdffbe`. Date: 2026-10-27. Round-2 report: `28-v04-graph-review.md`.

**Result: H1, M2, L1, L2 and L3 are fixed. H2 and M1 are fixed on the paths the round-2 report named (console, Workbench)
but each has a path that is not: Import jobs.** One Medium finding for each (M1, M2 below), plus five Low items about
documentation accuracy and resource coupling. No High finding, and no bypass of the Cypher guard in 695,000 engine
plans (402 M systematic and 9 M random candidates).

## Scope

- H1 (`bdd7d44`, `96be7b1`): `packages/shared/src/graphPolicy.ts`, the differential test in
  `apps/server/test/integration/graph.test.ts`, the sandbox template (`IMPORT_FOLDER`, `QUERY_MEM_CAPACITY`).
- H2 (`e880611`, `96be7b1`, `858fd3e`): `executeGraph` in `apps/server/src/routes/cli.ts`, its callers (console,
  Workbench, **Import**), the transport (`redis/capped.ts`, `context.ts`), the compose memory limit, and the wording of
  SECURITY, INSTALL, D21 and the user guide about engine-side limits.
- M1 (`dfb21dd`): `policy/preview.ts` and every place that builds a confirmation preview.
- M2 (`57440eb`): slow-log arguments in the console, Workbench, Import and Diagnostics.
- L1 (`a883554`, shared `ADMIN_READS`), L2 (`bdd7d44`, `a978852`), L3 (`a978852`, docs).
- L4 and L5 (another agent) are not covered.

## Environment and method

- Own instance of the built SPA (port 4700, temporary data directory), restarted three times on derived configs that
  add database entries pointing at the same FalkorDB sandbox: `readOnly`, `prod`, `maxRole: viewer`, a second plain
  alias, `poolSize` 1 and 2, and (for one probe) `maxInflightCommands: 1`. All of them were removed afterwards.
- Accounts: local `qa-viewer`, `qa-operator`, `qa-admin` (TOTP) and Keycloak `viewer1`, `operator1`, `admin1`. HTTP API
  plus Playwright Chromium (headless): 13 browser sessions. Every session recorded `securitypolicyviolation` events,
  page errors, console errors and requests to other origins: **0 / 0 / 0 / 0 in all of them**.
- FalkorDB 6.0.3 sandbox (Redis 8.10.2) as recreated from the updated template; `docker inspect` shows a 1 GiB memory
  limit and `restart: no`. I did not restart or recreate it. The H1 differential used `GRAPH.EXPLAIN` only (nothing
  executes), as the viewer ACL user, paced at 3,500 requests per second at most; guard verdicts were computed offline
  first so that only guard-accepted queries reached the engine. Slow-query probes were `reduce` over `range(1, N)` with
  N = 500,000 (4.1 s) for the slot tests and **one** N = 800,000 probe (about 10 s). No memory-heavy query was run.
- Keys: prefix `rv3g:20261027:` only (one 20-node graph, a few scalar keys), all deleted; a prefix scan returns nothing.
- Tests run individually (no Redis writes outside my prefix): shared `graphPolicy.test.ts` 32 passed; server unit
  `graph-engine-slots.test.ts` + `graph-policy.test.ts` 6 passed; web `lib/policy.test.ts` 18 passed. I did not run the
  integration, e2e or topology suites (the integration suite writes under its own key prefix).

## Summary

| ID | Sev | Finding |
|---|---|---|
| M1 | Medium | A cancelled **Import** job releases its graph slots at once while FalkorDB keeps running the query: an operator can pile up engine work, bypassing the H2 bound. |
| M2 | Medium | The **Import** confirmation still shows a graph query's Cypher cut to 16 bytes (the M1 fix covers console and Workbench only). |
| L1 | Low | Docs overstate the H2 bound ("never more than two runaway queries in one engine"), and the user guide says the next query "waits" (it is refused). |
| L2 | Low | A held graph query also holds a pool socket and a server-wide command slot for up to 15 minutes: with `poolSize` 1–2 it starves its tier; the global budget is shared with other databases. |
| L3 | Low | D21 and a code comment still say doubled backticks escape in Cypher; FalkorDB 6.0.3 does not parse them that way. |
| L4 | Low | The guard's refusal text for a lone CR, control characters and non-ASCII outside strings says "must have balanced strings, identifiers and comments". |
| L5 | Low | The 64 KiB cap counts characters in the browser and bytes on the server. |

---

## Findings

### M1. A cancelled Import job frees its graph slots while the engine is still running the query

- **Where:** `apps/server/src/routes/import.ts:344-350` (`jobScope.conn` sends with `{ ...o, signal }`) against
  `apps/server/src/routes/cli.ts:112` (`executeGraph` passes `signal: undefined` on purpose so the socket stays open and
  the slots follow the engine) and `apps/server/src/context.ts:124` (`scoped` lets an explicit `o.signal` win). The
  import wrapper puts the job's signal **after** `...o`, so it overrides the deliberate `undefined`. Cancelling the job
  aborts the in-flight graph command: the socket is destroyed, `run` rejects, `release()` frees the user and database
  slots, and FalkorDB goes on with the query (closing a socket does not stop it, round-2 H2).
  `unit/graph-engine-slots.test.ts` uses a fake connection that asserts `opts.signal` is `undefined`, so it cannot see
  this wrapper.
- **Reproduction (API as `qa-operator`, `sandbox-graph`; the console and Workbench paths hold correctly, see "checked and
  sound"):** repeat three times, 0.6 s apart: `POST …/import` with the script `GRAPH.RO_QUERY <g> "RETURN size(reduce(s = '', i IN range(1,500000) | s + 'x'))"`
  (a read, so no confirmation), `POST …/import/:id/start` (200, `running`), wait 0.6 s, `POST …/import/:id/cancel`. After
  each cycle `GRAPH.INFO` (default ACL user, count only) lists **1, 2, 3** running queries, and the same operator's next
  `GRAPH.RO_QUERY` is accepted every time (200, 2 ms; through `/cli` it would be 429 while one runs). The engine was idle
  again 5.9 s after the first cycle.
- **Impact:** the documented bound ("one per user, two per database, until the engine answers", SECURITY, INSTALL, D21)
  does not hold for an operator or admin: each start/cancel pair adds one pinned engine thread, limited only by the import
  rate limits (2 starts per second). With N = 1,000,000 (14 s each, round 2) about 18 cycles fill `THREAD_COUNT`; I ran 3.
  A user who simply cancels imports of slow graph scripts does the same unintentionally. Viewers cannot reach it (imports
  are operator-only). The container memory limit does not help against CPU pinning.
- **Suggested fix:** let an explicit `signal` win in the import wrapper, as `scoped` does:
  `send: (args, o = {}) => c.send(args, { signal, ...o })` (non-graph commands already get the job signal through the
  fourth argument of `execute`). Add a regression test that runs `execute` through the real `jobScope` wrapper (or an
  integration test: start, cancel, immediately a second graph query must be 429 until the first one finishes).

### M2. The Import confirmation still cuts a graph query to 16 bytes

- **Where:** `apps/server/src/routes/import.ts:215`: `previewCommand(p.argv, p.c.keep, p.c.keyIndexes)` has no query index,
  whereas `prepare` (`cli.ts`) passes `[2]` for graph commands. The confirmation of an import is built from these previews
  (`buildPreview([...previews.destructive, ...previews.other])`).
- **Reproduction (API as `qa-operator`):** `POST …/import` with `GRAPH.QUERY <g> "MATCH (n:Person) WHERE n.age > 30 AND n.country = 'DE' DETACH DELETE n"`
  → plan `destructive: 1, confirmation: confirm`; `POST …/import/:id/start` without a confirmation → `428`, summary
  "Import 1 commands into Graph sandbox: 1 change data, 1 of them destructive", preview
  `GRAPH.QUERY | <g> | MATCH (n:Person) [70 bytes] | TIMEOUT | 1000`. The same query in the console and in a Workbench
  script shows in full (verified in the API and in Chromium as local and Keycloak operator).
- **Impact:** the round-2 M1 situation on the third confirmation path: one confirmation covers a whole import, and the
  person confirming cannot read the Cypher (`WHERE …` and `DETACH DELETE` are hidden). Medium for the same reason as M1
  in round 2; it is limited to operators importing a file with graph writes.
- **Suggested fix:** pass the same query index (a shared helper such as
  `queryIndexes = (c) => GRAPH_QUERY_COMMANDS.has(c.command) ? [2] : []`, used by `prepare` and the import plan) and add the
  import case to the M1 regression test.

### L1. The documentation of the remaining engine-side limits is not accurate

- **Where:** `docs/SECURITY.md:146` ("so it never has more than two runaway queries in one engine"),
  `docs/INSTALL.md:222` ("so it never piles up more than that"), the round-2 paragraph of D21, and
  `docs/USER-GUIDE.md:328` ("your next graph query waits until it has finished").
- **What is wrong (each point checked):**
  1. Import cancel (M1): not true for operators and admins until M1 is fixed.
  2. The slots are per console **database entry**. One user on `sandbox-graph` plus a second entry for the same engine
     (`graph-b`, for example a second entry that gives a read-only or prod-tagged view of the same server): both accepted, `GRAPH.INFO` showed 2 running
     queries from one user, and 3 with the operator's query on the first entry (viewer: `sandbox-graph` + `graph-b`;
     operator: `sandbox-graph`), against the documented 2 per engine and 1 per user.
  3. The hold ends at `GRAPH_ENGINE_HOLD_MS` (15 minutes): the transport times out and destroys the socket, the slots
     free, and the engine keeps running. The cost grows with N² (measured N = 300k 1.6 s, 500k 4.1 s, 800k about 10 s), so
     about 7,500,000 elements would be needed to outlive the hold; extrapolated, **not run**. One user then adds a pinned
     thread per 15 minutes, two per database.
  4. The slots live in one console process; several console instances and non-console clients are not covered.
  5. The user guide says the next query "waits"; the console answers `429 rate_limited` ("Your previous graph query is
     still running in FalkorDB…"). Only imports retry that error (20 × 250 ms).
- **Impact:** an operator reading "never more than two" may leave `+graph.ro_query` in the viewer grants of a deployment
  where one of these cases applies. The mitigations the docs list (memory limit, withholding `+graph.ro_query`, `maxRole`)
  are the right ones.
- **Suggested fix:** say "the console starts at most one graph query per user and two per database entry at a time and
  keeps counting them for at most 15 minutes after it answered; it does not count other entries for the same engine, other
  console instances or other clients", and make the user guide say "is refused until it has finished".

### L2. A held graph query holds a pool socket and a server-wide command slot

- **Where:** `CappedPool.send` (`redis/capped.ts:302-337`) keeps the tier's pool slot and one of the server-wide
  `maxInflightCommands` slots (default 16, up to 128) until `c.send` returns, which for a graph query is now the engine's
  answer, up to 15 minutes. `GRAPH_ENGINE_SLOTS_PER_DB = 2` is justified only against the default `poolSize` of 4
  (code comment and a test assertion); `poolSize` accepts 1–32.
- **Reproduction (poolSize, API):** database entry with `poolSize: 1`: `qa-viewer` runs a 4 s query; meanwhile `qa-viewer`
  `GRAPH.LIST` on that entry → **429 after 2.0 s** ("All 1 Redis connections of this database's viewer pool are busy"),
  `qa-operator` `GRAPH.LIST` → 200 (own tier pool). `poolSize: 2` with Keycloak `viewer1` and `qa-viewer` both running
  one: `qa-viewer` `GRAPH.LIST` → 429 after 2.0 s; `qa-admin` → 200. A single viewer therefore takes a whole tier's pool
  of a `poolSize: 1` database for up to 15 minutes.
- **Reproduction (global slots; deliberately extreme setting):** `maxInflightCommands: 1`. `qa-viewer` N = 800,000 query →
  `504` at 7.05 s (engine still running); `qa-operator` `DBSIZE` on **another database** (`sandbox-main`) was accepted
  only at 10.26 s, 3.2 s after it was sent, when the engine finished (two waits of at most 2 s: the command-table read,
  whose 429 the route swallows, then the command; most likely, inferred from the code and not traced). At the default of 16 it takes 16
  held queries (8 graph database entries, or fewer users × entries) before other databases see 429; each graph entry
  removes up to two slots for the length of a query.
- **Impact:** a deployment with a small graph pool can lose all of one tier's access to that database to one viewer, and
  graph entries lower the server-wide budget. Neither is documented (OPERATIONS describes `poolSize` as 1–32).
- **Suggested fix:** document `poolSize ≥ 4` (or ≥ 3) for graph databases, or use `min(2, poolSize − 1)` slots and refuse
  graph queries when that is 0; optionally release the pool and global slots when the console answers 504 and keep only the
  graph slot (the engine socket can be detached from the shared gates).
- **Unreproduced suspicion:** `CappedPool.send` gives the connect and `HELLO` phase the same 15-minute deadline (`deadline`
  at `capped.ts:304`), so a half-open connection to a hung engine would hold the graph slots for that long. Not tried.

### L3. D21 and a code comment still describe doubled backticks as the escape

- **Where:** `docs/DECISIONS.md:511` ("Backtick identifiers use doubled backticks for escaping … (verified against the
  engine)") and `packages/shared/src/graphPolicy.ts:37`.
- **Reproduction:** EXPLAIN as viewer: ``MATCH (n:`a``b`) RETURN n`` → `Invalid input '`b`': expected ')'`; ``RETURN 1 AS `a``b` ``
  → `Unexpected clause following RETURN`; `'it''s'` the same. Doubled quotes are two adjacent tokens in FalkorDB 6.0.3. The
  round-2 report asked for a comment; the guard still treats them as escapes (harmless: the quote state after any run of
  quotes is the same, which the fuzz below confirms).
- **Suggested fix:** reword D21 ("the guard reads doubled quotes as one token; FalkorDB reads two; the resulting state is the
  same") and the comment.

### L4. The refusal message for control characters and non-ASCII is misleading

- **Where:** `graphPolicy.ts:60` (one message for every `tokens()` failure).
- **Reproduction:** Workbench as viewer, `GRAPH.RO_QUERY <g> "RETURN 1 AS a //x\r, 2 AS b"` (lone CR), or a query with
  U+00A0 between tokens: the policy line reads "Graph queries must have balanced strings, identifiers and comments." and the
  server answers the same (403). The query is balanced.
- **Suggested fix:** return a second message for the character case ("A lone CR in a comment, control characters and
  characters outside ASCII between tokens are refused; put Unicode in quoted labels and strings").

### L5. The 64 KiB cap differs between the browser and the server

- **Where:** `graphPolicy.ts:58` (`query.length`), applied to a JS string in the browser and to the latin1 view of the bytes
  on the server.
- **Reproduction:** `RETURN '<40,000 × é>' AS s` (40,014 characters, 80,014 bytes): browser view accepts, server view
  refuses ("limited to 64 KiB"). Computed with the shared function on both representations; the 13 other browser/server
  comparisons below agree.
- **Impact:** the Workbench enables Run for a line the server refuses; cosmetic.
- **Suggested fix:** measure `utf8` byte length in the shared function (as the message says).

---

## Verdict on each round-2 fix

| Fix | Verdict | Evidence |
|---|---|---|
| H1 comment end and ASCII whitespace (`bdd7d44`, `96be7b1`) | **Fixed, no bypass found** | Differential and byte-level probes below; the three round-2 payloads refused in API and Chromium; engine defence in depth verified (`LOAD CSV` fails with "Failed to canonicalize import folder path"). Docs wording: L3. |
| H2 slots until the engine answers (`e880611`, `96be7b1`, `858fd3e`) | **Partly fixed** | Console and Workbench hold correctly (per user, per database, cancel, disconnect, 504 at 7.05 s). **Import cancel bypasses it (M1).** Docs overstate (L1). Pool and global coupling (L2). |
| M1 preview up to 4 KiB (`dfb21dd`) | **Partly fixed** | Console and Workbench show the full Cypher (API, Chromium operator and `operator1`). **Import preview is still 16 bytes (M2).** |
| M2 slow log (`57440eb`) | **Fixed** | Viewer and operator see command names, keys and `<n bytes>`; admins see all. Console, Workbench, Diagnostics, as local and Keycloak roles. |
| L1 `ADMIN_READS` (`a883554`) | **Fixed** | Browser and server agree on the read-only database for viewer, operator and admin (local and Keycloak admin). |
| L2 slices and whitespace (`bdd7d44`, `a978852`) | **Fixed** | `[0..size(x)]` accepted, namespaced and quoted calls refused; browser and server agree on 13 cases (cap: L5; message: L4). |
| L3 `GRAPH.DELETE` wording (`a978852`) | **Fixed (docs accurate)** | Operator: `GRAPH.DELETE` 403, `RENAME` and `DEL` 428 `confirm` then 200, Cypher `DETACH DELETE` 428 then 200; admin `GRAPH.DELETE` 428 `typed`. |

---

## Checked and sound

### H1: the guard against FalkorDB 6.0.3

- **Differential, bounded.** The guard's verdict was computed offline for every candidate; every guard-accepted query was
  planned by `GRAPH.EXPLAIN` as the viewer, and a hit is "the engine plans a `Load CSV`, a `ProcedureCall` or a fulltext
  scan, or resolves `rv3g.fn` / `fnq`". Six payloads (LOAD CSV, a namespaced call, `CALL algo.pageRank`, a quoted
  namespaced call, a quoted call, a fulltext procedure), with up to three atoms of a 28-element structural alphabet
  (comment openers and closers, CR, LF, CR LF, NUL, VT, FF, NBSP, U+2028/2029, NEL, curly and full-width quotes, the three
  quote characters, backslash forms) in front and two behind; a 12-atom alphabet with four in front and three behind; a
  7-atom CR-focused alphabet with five and four; and random combinations that also insert atoms between the payload's own
  tokens (81 atoms including doubled quotes, backslash-u and backslash-x escapes of a quote, overlong UTF-8, lone
  surrogates, `%27`).
  **402,338,166 systematic and 9,000,000 random candidates; 51,171,541 + 122,775 accepted by the guard; 573,721 + 121,651
  planned by the engine; 0 hits.**
- **The fuzz can find the old bug.** Among the 83,416 queries of the CR alphabet that the round-2 guard accepts and the
  fixed guard refuses, 60,000 were planned: **135** were read by the engine as `Load CSV`. (Random sampling alone did not
  find it in 400,000 candidates; the systematic search did.)
- **Byte-level facts, measured per byte.** Whitespace between tokens: TAB, LF, CR, SPACE only (the guard's set). A `//`
  comment ends at LF only, for all 256 byte values; a block comment ends at `*/` only. None of 33 Unicode characters (NEL,
  NBSP, U+1680, U+180E, U+2000–200D, U+2028/2029, U+202F, U+205F, U+2060, U+3000, U+FEFF, curly and full-width quotes,
  U+02CB, U+02BC) is whitespace, ends a comment, or delimits a string or a backtick identifier; invalid UTF-8 never parses.
  Strings: `\'`, `\"`, `\\` escape; `\` before any other character keeps both; a backslash-u escape with four hex digits is
  processed after lexing (a string holding the escape for a single quote stays one string) and is not interpreted in
  keywords (`L`, backslash-u-004f, `AD CSV FROM …` is a parse error). Doubled quotes and backticks are two tokens (L3).
- **The new dot rule.** 29 shapes of `x.y(…)`: every shape the engine resolves as a function (`a.b.c(`, `` `a`.`b`( ``,
  ``` ``.fn( ```, `n.a.fn(`, comments or newlines around the dots, `true.fn(`, `$p.fn(`) is refused; the shapes the guard
  accepts (`1.5.fn(1)`, `[1].fn(1)`, `(1).fn(1)`, `'a'.fn(1)`, `rv3g..fn(1)`, `f(x).fn(1)`) are parse errors in the engine.
- **Browser vs server.** In the fuzz the UTF-8 view (browser) and the latin1 view (server) never disagreed on a valid-UTF-8
  candidate; in Chromium as viewer 13 cases (lone CR in a comment with LOAD CSV and with a UDF call, CR LF and LF, NBSP,
  U+2028 in a comment, slice, namespaced, quoted, LOAD, allowed procedure, `CALL algo`, non-ASCII in a string) gave the same
  verdict as the API (L5 is the one exception).
- **Defence in depth.** As viewer directly on the engine, `LOAD CSV` of an existing and a missing file both fail on the
  missing import folder; `GRAPH.CONFIG GET` shows the template values.

### H2: slots on the console and Workbench paths

Measured with N = 500,000 queries (4.1 s):

- Same user, same database: second graph query **429 in 5 ms**; a non-graph command on that database (`GRAPH.LIST`, 4 ms)
  and a command on another database (42 ms) are not blocked.
- Two users on one database (viewer, operator): a third (admin) gets `429` "FalkorDB is still running 2 console queries on
  this database" in 20 ms; a different console database entry is not blocked (L1 point 2 is the flip side).
- **Client disconnect:** the browser aborted the request at 511 ms; the next query 429 (4 ms); the slot was free at 4,248 ms,
  when the engine finished. The `signal: undefined` in `executeNow` overrides the request's signal as intended.
- **Cancelled Workbench script:** cancel answered `cancelled: true` and the script returned in 513 ms with `inFlight: true`;
  the viewer's next console query 429, a new Workbench run 429 ("A workbench script of yours is still running"), both free
  at 4.3 s. In Chromium the cancelled line shows "may have run" and the next run shows that error, then succeeds.
- **504 path:** N = 800,000: `504 timeout` at 7.05 s with the "still running… at most 15 minutes" text, audited as
  `error` with the code only; the slot and the global budget stayed taken until the engine finished (L2 probe).
- **No leaks and no false 429:** six consecutive graph lines in one Workbench script and an import of 30 lines all succeed
  (the slot is released before the next line); `Slots.release` is idempotent and removes empty entries; the 429 branch of
  the database slot releases the user slot; a rejected `run` releases through `run.then(release, release)`.
- Containers: the sandbox container has a 1 GiB limit (`docker inspect`); `QUERY_MEM_CAPACITY` not counting list building
  and the memory ceiling were **not** independently verified (no memory-heavy query was run).

### M1: preview in the console and Workbench

API and Chromium (local operator, Keycloak `operator1`): the 70-byte query shows in full; a Workbench script with a QUERY
and a PROFILE line lists both, summary "…with 2 commands that need confirmation" (1 command: "1 command that needs"); a
6,047-byte query is cut at exactly 4,096 bytes with "… (6,047 bytes)"; a 6,043-byte query of two-byte characters is cut on
a character boundary (no replacement character). The dialog stays inside a 1000 px viewport (509 px, the preview scrolls),
shows `<img src=x onerror=alert(1)>` as text (0 `img` elements), and cancelling runs nothing.

### M2: slow log

After an operator ran a 30,000-node `CREATE` with a marker literal (36 ms): viewer and operator `SLOWLOG GET`, Workbench
`SLOWLOG GET` and `GET …/slowlog` show `GRAPH.QUERY <key> <85 bytes> <7 bytes> <4 bytes>`; the marker is absent. Admin sees
the literal in the console and Diagnostics. Chromium: local viewer, operator, admin and Keycloak viewer1, admin1 on the
Console and Diagnostics pages: the marker is visible to the admins only. `slowlogArgv` on 27 odd shapes (no table, cut
arguments, `... (N more arguments)`, `HELLO … AUTH`, `MIGRATE … AUTH`, module commands) never throws and shows only names,
keys and sizes (without a command table keys are hidden as well, the safe direction). Cosmetic: Redis's own `(redacted)` for
`AUTH` arguments becomes `<10 bytes>`.

### L1 (read-only admin reads)

On the `readOnly` entry (API): viewer and operator get 403 `forbidden` for `GRAPH.SLOWLOG`, `GRAPH.CONFIG GET`,
`CONFIG GET`, `CLIENT LIST`, `MEMORY MALLOC-STATS`; admin gets 200 for all five and `403 read_only` for `GRAPH.QUERY`,
`GRAPH.DELETE`, `FLUSHDB`. In Chromium the Workbench policy line and Run button match: admin (local and Keycloak) "1
admin", Run enabled, a three-line script of `GRAPH.SLOWLOG`, `GRAPH.CONFIG GET TIMEOUT_MAX`, `CONFIG GET maxmemory` ran
`success` ×3; the same shapes as viewer or operator say "requires the admin role on this database (you have …)" (the
round-2 wrong "read-only" reason is gone); writes say "read-only".

### Data leaving the server

My server logs (three runs, about 2,200 lines, audit included) contain no Cypher text, no marker literal and no `LOAD CSV` or `reduce(`;
audit lines carry `key#<hash>` and `<n bytes>` as in round 2. I did not re-check URLs and browser storage this round.

## Not covered

- Memory exhaustion in FalkorDB (`QUERY_MEM_CAPACITY`, list building) and the 15-minute behaviour (extrapolated only).
- An executed UDF or a real `LOAD CSV` file (the guard and the missing import folder are verified; no library was loaded).
- Cluster and Sentinel graph deployments, several console instances, assistive technology.
- L4 and L5 of round 2 (reviewed by another model); integration, e2e and topology suites.

## Observations (not findings)

- A graph write that finishes after the console answered 504 has no later audit line; the audit says `error: timeout` while the
  write may have applied (the docs say timeouts do not promise rollback).
- `docker-compose.yml` sets `mem_limit: 1g` and no restart policy, so an out-of-memory kill leaves the sandbox stopped.

## Cleanup

Server stopped by PID (each of its three runs), background runners stopped, all `rv3g:20261027:` keys deleted from
`sandbox-graph` (prefix scan: 0), derived configs, session files, scripts, screenshots and the temporary data directory
removed. No product code or test file was changed.
