# v0.4 review, round 4: FalkorDB graph fixes (targeted verification of the round-3 fixes)

Reviewer: Claude Sonnet 5.5 (reviewer of rounds 2 and 3; the fixes were written by Claude Opus 5.5).
Snapshot: `release/v0.4` @ `acbffbe`. Date: 2026-10-27. Round-3 report: `31-v04-review-r3-graph.md`; verdicts: `REVIEW-LOG.md`
("v0.4 Round 3 – graph fix verification").

**Result: all seven round-3 fixes (M1, M2, L1–L5) work as described. No High or Medium finding.** Cancelled Import jobs keep
their graph slots (three start/cancel cycles: never more than one query in the engine, where round 3 saw 1, 2, 3), the Import
confirmation shows the Cypher like the console and the Workbench, and Import's cancel still aborts a non-graph command in
flight. Per-database slots follow `min(2, poolSize - 1)`; a pool of one is refused. The guard refuses exactly the queries it
refused before (300,000 random queries, old against new: 0 differences) and names the reason. Browser and server agree on
60,400 random graph lines with non-ASCII, control characters and sizes around 64 KiB, **except** the one family in L4 below.
Seven Low findings follow, none of them a bypass: two are behaviours of Import's cancel around graph lines, one is a
poolSize-1 refusal that comes after the confirmation, one is a residual of the L5 fix, one is a side effect of that fix on
another rule, and two are a documentation gap and a test gap.

The finding IDs below are this round's own (L1–L7); the verdict table calls the round-3 fixes "r3 M1" and so on.

## Scope

- r3 M1, M2 (`edc4628`): `apps/server/src/routes/import.ts` (`jobScope`), shared `commandPreview` in `routes/cli.ts`; every
  path that runs graph commands: console, Workbench (cancel), Import (cancel, stop-on-error, retries); and that the signal
  change left Import's cancel intact for non-graph commands.
- r3 L2 (`a085bb2`): `executeGraph`, per-database slots `min(2, poolSize - 1)`, poolSize 1.
- r3 L4 (`368e76a`), L5 (`1655251`): refusal reasons; `serverForm` in `apps/web/src/lib/policy.ts`; browser and server verdicts.
- r3 L1, L3 (docs `90566fc`, `de20cc4`): SECURITY, INSTALL, USER-GUIDE, D21, the guard's comment.

## Environment and method

- Own instance of the built SPA on port 4700 (temporary data directory), started with `pnpm --filter @rconsole/server start` on
  a derived config: the generic dev config plus three more entries for the same FalkorDB sandbox with `poolSize` 1, 2 and 3.
  Removed afterwards.
- Accounts: local `qa-viewer`, `qa-operator`, `qa-admin` (TOTP) and Keycloak `operator1`. HTTP API (some twenty scripted probes) and
  Playwright Chromium (headless): eight sessions as viewer, operator, admin and Keycloak operator. Every session recorded
  `securitypolicyviolation` events, page errors and requests to other origins: **0 / 0 / 0**. Console errors were only the
  expected ones: 401 from the session check on the login page, 428 for confirmations, 400 for the poolSize-1 refusal.
- FalkorDB 6.0.3 sandbox, not restarted or recreated. Slow-query probes were `reduce` over `range(1, N)` with N = 500,000
  (about 4.1 s) for almost all of them, N = 700,000 (about 8 s) twice and N = 800,000 (about 10 s) once. No memory-heavy query.
  Two probes ran two 4 s queries at the same time, to test the per-database bound itself (never more than two in the engine).
- Keys: prefix `rv4g:20261027:` only (one 20-node graph and a few scalar keys); all deleted, a prefix scan returns nothing.
- Tests run as single files: shared `graphPolicy.test.ts` 33 passed; server unit `graph-engine-slots.test.ts` +
  `graph-policy.test.ts` 7 passed; web `lib/policy.test.ts` 19 passed; `pnpm -r typecheck` clean (4 projects). I did not run the
  integration suite (it writes under its own key prefix, not mine), the e2e suite or the topology script. The M1/M2
  integration test was replicated by hand through the API (below).
- Differential method for L4/L5: the browser verdict is the real `commandPolicy` from `apps/web/src/lib/policy.ts` loaded in
  Node; the server verdict is the real `/cli` route as viewer (`GRAPH.EXPLAIN`, so nothing executes) or the real `classify`
  from the server's policy module for the offline runs.

## Summary

| ID | Sev | Finding |
|---|---|---|
| L1 | Low | Cancelling an Import while a graph line is in flight does nothing visible until FalkorDB answers (or `commandTimeoutMs`); a single graph line (by the code, the last one too) then ends as `done`, not `cancelled`. |
| L2 | Low | Cancelling an Import while a graph line waits in the 429 retry loop reports "Cancelled while line N was running (it may have run)" and audits "cancelled while in flight" for a command that was never sent. |
| L3 | Low | The poolSize-1 refusal comes after the confirmation (console, Workbench) and after the Import plan; the UI cannot know it. |
| L4 | Low | The L5 fix is not exact for `\xHH` escapes of 0x80 or more: the browser counts them twice toward the 64 KiB limit. |
| L5 | Low | Side effect of the L5 fix on a non-graph rule: the VSIM FILTER limit ("1024 bytes") counts non-ASCII bytes twice, on the server and now in the browser. |
| L6 | Low | The config reference (OPERATIONS, `poolSize`) does not say that graph databases need `poolSize` 2 or more. |
| L7 | Low | Nothing pins that Import's cancel still aborts a non-graph command in flight, and the wrapper's `'signal' in o` depends on a convention. |

---

## Findings

### L1. Import cancel with a graph line in flight: no visible effect for a while, and the job can end as `done`

- **Where:** `apps/server/src/routes/import.ts:350` (the wrapper now leaves a graph command's `signal: undefined` alone, which is the
  M1 fix), `import.ts:420-440` (the cancelled branch only handles a *failed* outcome; an answered line is counted like any
  other and the loop ends with `st.state = 'done'`), `apps/web/src/pages/guided/ImportPanel.tsx` (the Cancel button stays
  until the state leaves `running`).
- **Reproduction (API as `qa-operator`, and Chromium as `qa-operator` and Keycloak `operator1`, database with the graph):**
  import the one line `GRAPH.RO_QUERY <g> "RETURN size(reduce(s = '', i IN range(1,500000) | s + 'x'))"`, start it, cancel
  after 0.6 s. The cancel answers 200 with `state: running`. The job stays `running` for 3.4–3.8 s (until FalkorDB answers,
  "Query timed out"), then reads `done`, "1 of 1 sent · 0 succeeded · 1 failed", no notice that it was cancelled (three API
  cycles; the same in the UI for both accounts). With a second line (`SET`) the job ends `cancelled`, "Cancelled; the remaining
  commands were not sent", and the `SET` does not run (checked). A non-graph line in flight is cancelled at once (L7).
- **Impact:** by design a graph query cannot be aborted, so the cancel waits for the engine (at most `commandTimeoutMs`, 5 s by
  default, configurable up to 60 s, then a 504 and "may have run"). What is not intended is that the user is shown "Finished"
  for a job they cancelled, and that for up to a minute the Cancel button seems to do nothing; the operator cannot start another
  import in that time (one import per user). No data or bound is affected.
- **Suggested fix:** after the loop ends, or after any outcome, `if (signal.aborted)` end the job as `cancelled` and say that
  the line in flight was answered by FalkorDB and counted ("Cancelled while line N was running; FalkorDB finished it"); show
  "Cancelling…" in the panel after the click.

### L2. "Cancelled while line N was running (it may have run)" for a line that was refused before it was sent

- **Where:** `import.ts:405-424`. A `rate_limited` refusal (the user's or the database's graph slot, the pool gate, the global
  command budget) is retried for up to 5 s (`import.ts:410`); it is not marked `notSent`, so a cancel during the retry takes the
  "aborted while in flight" branch (`import.ts:420`). The logic is older than this round (v0.2.1); it matters more now because a
  graph slot refusal lasts until the engine answers, and the M1 fix keeps the slots through a cancel.
- **Reproduction (API as `qa-operator`):** import `GRAPH.RO_QUERY <g> "<reduce over range(1,800000)>"` (about 10 s) then
  `GRAPH.RO_QUERY <g> "RETURN 9"`; start; the first line times out at 5 s (`timeout`, counted failed) and the second waits in
  the 429 retry loop; cancel at 7 s. Result: `cancelled`, `inFlightLine=2`, "Cancelled while line 2 was running (it may have
  run); the remaining commands were not sent." The audit holds `import.exec error GRAPH.RO_QUERY <8 bytes> cancelled while in
  flight` for `RETURN 9`, which never left the console.
- **Impact:** a misleading status and audit line (it says a command may have run); a person may re-check data for nothing, and
  the audit overstates what was sent. Low: nothing ran.
- **Suggested fix:** treat `rate_limited` (every one is raised before a command is sent: slot, pool gate, global budget) like
  `notSent`: the line counts as not sent, and the audit says "cancelled, not sent".

### L3. A poolSize-1 database refuses graph queries only after the confirmation, and the Import plan accepts them

- **Where:** `apps/server/src/routes/cli.ts:113-117` (inside `executeGraph`, which runs after `prepare` and `confirmOrThrow`).
  The browser has no way to know the pool size (it is server configuration).
- **Reproduction (poolSize 1 entry):** viewer `GRAPH.RO_QUERY` and `GRAPH.EXPLAIN` → 400 `validation` "Graph queries need a
  connection pool of at least 2 on this database (poolSize), so that a long-running query cannot hold every connection."
  (32 ms and 1 ms; `GRAPH.LIST` → 200). Operator `GRAPH.QUERY … CREATE` → 428 `confirmation_required`, then, confirmed, 400 with
  the same text; no node was created. Chromium as admin: Workbench policy line "1 command 1 write", Run enabled, the
  confirmation dialog appears, and after confirming the result row shows the refusal. Import: the plan accepts two lines (read
  and a `GRAPH.LIST`), the start runs and the graph line fails with `validation` ("1 succeeded, 1 failed").
- **Impact:** low: only a misconfigured pool, the reason is clear, nothing is sent and no data changes. But the person confirms
  an action that cannot run, and a plan promises lines that fail.
- **Suggested fix:** raise the refusal before the confirmation (for example in `prepare`, next to `authorize`, so the console,
  the Workbench and the Import plan all refuse it as a blocked line with the same text), or log a warning at start-up
  when a database has `poolSize: 1` and the module is FalkorDB.

### L4. The browser counts `\xHH` escapes of 0x80 or more as two bytes toward the 64 KiB limit

- **Where:** `apps/web/src/lib/policy.ts:24-67` (`serverForm` applied to the tokens of `tokenizeCommandLine`). In a double-quoted
  token that function turns `\xe9` into the code unit U+00E9, which `serverForm` then UTF-8-encodes (two bytes). The server
  tokenizes with `tokenizeCommandLineBytes`, where `\xe9` is one byte.
- **Reproduction (API as `qa-viewer` against the real `commandPolicy`, and Chromium as viewer):**
  `GRAPH.EXPLAIN <g> "RETURN '` + 32,700 × `é` + 100 × `\xe9` + `'"`: the query is 65,509 bytes on the server (accepted, 200);
  the browser counts 65,609 and refuses ("Graph queries are limited to 64 KiB.", Run disabled in the console). Without the
  escapes (65,409 bytes) both accept. Offline over 60,400 random lines (60,000 fragment mixes, a third of them with random `\xHH` escapes, and 400 size mixes around
  64 KiB, half of them with escapes): **96 mismatches, all of them lines with `\xHH` escapes ≥ 0x80 within a few hundred bytes of
  the limit, all in this direction (browser refuses, server accepts); none among the lines without such escapes.** The character
  verdicts and the reason texts agree in every case, because a byte of 0x80 or more is non-ASCII in both views.
- **Impact:** cosmetic and contrived (a query within a few hundred bytes of the limit that also uses these escapes); the browser
  never accepts what the server refuses. The L5 subject says the browser gives the rules "the bytes the server sees", which is
  not exact here.
- **Suggested fix:** build the rule input from the server's own tokenizer: `tokenizeCommandLineBytes(line)` with each byte
  mapped to one latin1 character, instead of `serverForm(tokenizeCommandLine(line))`.

### L5. The VSIM FILTER limit counts non-ASCII bytes twice, on the server and (since the L5 fix) in the browser

- **Where:** `packages/shared/src/commands.ts:346` (`utf8Length(value)`). `argumentRule` now gets latin1 strings of the argument bytes
  on both sides; `utf8Length` of such a string counts every byte of 0x80 or more as two. Outside the graph scope (it is the
  round-1 VSIM rule), found while checking what `serverForm` does to other rules.
- **Reproduction (API as `qa-viewer`):** `VSIM <k> ELE a FILTER ".name == '<300 × é>'"` (611 UTF-8 bytes) → 403 "VSIM FILTER
  expressions are limited to 1024 bytes here." Same for 400 and 520 é. The browser's `commandPolicy` now refuses the same
  lines (before the L5 fix it counted 611 bytes and, by the code, allowed them; I did not run the old version), so the browser and server agree, and both count about twice.
- **Impact:** a filter with more than about 250 two-byte characters is refused although the message says 1024 bytes. Low,
  vector-set only, and the browser/server agreement the L5 fix wanted is met.
- **Suggested fix:** measure `value.length` in `vsimRefusal` (its arguments are strings of one byte per character on the server
  and, now, in the browser).

### L6. The config reference does not mention the graph requirement for `poolSize`

- **Where:** `docs/OPERATIONS.md:162` ("Sockets per tier in each pool (1–32)"). `INSTALL.md:222-225` and D21 do say it
  (`poolSize` 3 or more; 1 is refused); ARCHITECTURE's v0.4 graph section does not mention slots or the pool.
- **Impact:** someone setting `poolSize: 1` for a small deployment finds out when graph queries are refused (L3).
- **Suggested fix:** one sentence in the OPERATIONS row: "FalkorDB databases: 3 or more (a held graph query keeps one
  connection; 1 refuses graph queries)".

### L7. No test pins Import's non-graph abort, and the wrapper's rule is a presence check

- **Where:** `import.ts:350` (`'signal' in o ? o : { ...o, signal }`). It stays correct only while `executeNow` always passes a
  `signal` key, set to the job's signal for every command except a graph query, whose `undefined` is the deliberate exception
  (`cli.ts:149`). The M1 regression test is an integration test (it skips without the sandbox) and covers only the graph half; the
  existing Import cancel tests cancel between commands, never a command in flight.
- **Reproduction of the behaviour (API as `qa-operator`):** import `BLPOP <k> 5` then `SET <k2> 1`, start, cancel after 800 ms →
  `cancelled` after 810 ms, `inFlightLine=1`, "Cancelled while line 1 was running (it may have run)", `SET` not run; the
  control without a cancel takes 2.2 s (`BLPOP … 2`). So the behaviour is right today; this is a regression-test gap, not a bug.
- **Suggested fix:** an integration test that cancels an Import during `BLPOP <k> 5` and asserts `cancelled` in under 2 s with
  `inFlightLine` set, next to the graph one; optionally an explicit marker (for example a `detached: true` send option for the
  graph query) instead of inferring intent from the key's presence.

---

## Verdict on each round-3 fix

| Fix | Verdict | Evidence |
|---|---|---|
| r3 M1 Import cancel keeps graph slots (`edc4628`) | **Fixed** | Three start/cancel cycles: next console query 429 each time (4, 2, 2 ms), `GRAPH.INFO` never showed more than one running query (200 ms sampling), slots free when the engine answered. Non-graph abort intact (L7 reproduction). Multi-line cancel, stop-on-error and the 429 retry path checked below. Residuals: L1, L2. |
| r3 M2 Import preview (`edc4628`) | **Fixed** | Console, Workbench and Import show the same preview of one 5,934-byte query (4,096 bytes and "5,934 bytes") and the short ones whole, `GRAPH.PROFILE` included. Chromium as local operator and Keycloak `operator1`: the 70-byte delete shows whole in the Import confirmation; a 4,934-byte one is cut at 4,096 bytes with "(4,934 bytes)"; the dialog scrolls inside the viewport. |
| r3 L1 docs: slot bound (`90566fc`) | **Fixed (docs accurate)** | Per user per entry, two per entry, `poolSize - 1`, "refused, not queued", not counted across entries (one operator on two entries: 2 running), other instances and clients not counted; user guide matches the 429 text. The 15-minute hold is checked in code and in the unit test, not waited out. Gap: L6. |
| r3 L2 poolSize slots (`a085bb2`) | **Fixed** | poolSize 1: refused (L3 for when). poolSize 2: one held query; every other graph user gets 429 "still running 1 console query", while the same tier's other commands answer in 4 ms (round 3: 429 after 2.0 s). poolSize 3: two held, third refused, other commands fine. |
| r3 L3 docs: doubled backticks (`de20cc4`) | **Fixed (docs accurate)** | EXPLAIN as viewer: doubled backtick in a label or alias and `'it''s'` are parse errors in FalkorDB 6.0.3; a backslash in a backtick name plans fine. The guard's reading of a doubled quote and the engine's agree on the quote state after any run of quotes (a parity argument, and round 3's differential), so the statement in D21 and the comment hold. |
| r3 L4 refusal reasons (`368e76a`) | **Fixed** | Four reasons (size, unbalanced, lone CR in a line comment, characters outside printable ASCII) shown identically by the console policy line, the Workbench policy line and the server's `hint` (403 `command_blocked`; the reason is in `hint`, `message` stays "is blocked by policy"). The set of refused queries did not change: 300,000 random queries, old against new guard, 0 differences. |
| r3 L5 bytes the server sees (`1655251`) | **Fixed, one residual** | 40,000 × é refused by both, 40,000 × a accepted by both; 65,535 / 65,536 / 65,537 bytes of 1-, 2-, 3- and 4-byte characters agree on both sides; non-ASCII, NUL, ESC, BOM, U+2028 and a lone surrogate agree. Residual: L4 (`\xHH`). Side effect: L5. |

---

## Checked and sound

### Slots and cancel, every path (API as local users; N = 500,000 queries unless noted)

- **Import cancel keeps the slots.** Three cycles (start, cancel at 0.6 s): `GRAPH.INFO` (default ACL user, count only) peaked at
  one running query, the next `GRAPH.RO_QUERY` by the same operator was 429 after 4, 2 and 2 ms, and 200 after the job ended and
  the engine was idle (idle at 12.9 s for all three). Round 3 saw 1, 2, 3 on the unfixed code.
- **Import, non-graph in flight.** `BLPOP … 5` + `SET`, cancel at 800 ms: `cancelled` at 810 ms, the `SET` not run, `inFlightLine=1`.
- **Import, graph first, then `SET`, cancel at 0.6 s.** Ends `cancelled` at 3.97 s (when the engine answered "Query timed out"),
  one failed, one not sent, the `SET` not run (`Cancelled; the remaining commands were not sent.`).
- **Stop on error.** The same shape with `stopOnError`: `stopped` at 3.98 s, "Stopped at the first failure (line 1)", `SET` not run.
- **Retries.** A line of about 8 s (N = 700,000) is answered by the console at 5 s as `timeout` (counted failed); the two reads
  after it are refused, retried every 250 ms and succeed when the engine answers: `done`, 2 succeeded, 1 failed, 7.8 s. No other
  failure group. The retry loop honours the cancel (`sleep` resolves on abort); L2 is only about the wording.
- **Workbench cancel.** Cancel at 0.6 s: 200 `cancelled: true`; the script returned after 605 ms with `cancelled: {inFlight: true}`;
  the next console query 429 and the next Workbench run 429 ("A workbench script of yours is still running"); both free when the
  engine finished (4.1 s); at most one query in the engine. Chromium as admin: the gutter shows "may have run" for the line in
  flight and "not run" for the next; the immediate re-run shows the 429 text; the run after the engine finished succeeds.
- **Console client disconnect** (fetch aborted at 500 ms): next query 429, one running in the engine, free afterwards.
- **Any spelling of the command** (`graph.ro_query`, `Graph.Ro_Query`) takes the slots as well (429 for the next query).
- **No false 429s:** an Import of 26 graph lines (20 reads, 5 `CREATE`, 1 EXPLAIN) finished in about 100 ms with 26 succeeded on a
  normal entry and on the poolSize-2 entry (one slot), and an 8-line Workbench script ran in full on both.

### Previews (M2)

- Same 5,934-byte `DETACH DELETE` through `/cli`, `/workbench` and `/import`: each lists it as 4,096 bytes with `bytes: 5934`;
  the short `PROFILE` and `DETACH DELETE` lines are whole in the Workbench and Import previews. `commandPreview` is the only
  builder these three use (`prepare` and the Import plan), and the preview is built from the capped argv that runs
  (`… TIMEOUT 1000` is visible).
- Chromium, Import page, local operator and Keycloak `operator1`: whole 70-byte query, 4,096-byte cut of the long one, summary
  "Import 1 commands into … 1 of them destructive" (existing wording), Escape cancels the dialog and nothing runs. Workbench as admin: a
  two-line script with a write lists both commands, the Cypher whole, summary "…with 2 commands that need confirmation".

### poolSize slots (L2)

| Entry | Probe | Result |
|---|---|---|
| poolSize 1 | viewer `RO_QUERY`, `EXPLAIN` | 400 `validation` with the reason, nothing sent |
| poolSize 1 | viewer `GRAPH.LIST` | 200 |
| poolSize 2 (1 slot) | viewer holds a query; operator `RO_QUERY` | 429 "still running 1 console query" in 21 ms |
| poolSize 2 | same viewer `GRAPH.LIST`, admin `GRAPH.LIST`, key scan | 200 in 4, 10 and 3 ms |
| poolSize 2 | same viewer, `EXPLAIN` | 429 "Your previous graph query is still running" (own slot) |
| poolSize 3 (2 slots) | operator and admin hold queries; viewer `RO_QUERY` | 429 "still running 2 console queries" in 18 ms |
| poolSize 3 | operator `GRAPH.LIST`, admin `GRAPH.LIST` | 200 in 3 and 1 ms; `GRAPH.INFO` shows 2 running |
| one user, two entries | operator on the default entry and poolSize 3 | 2 running (documented: other entries not counted) |

The user's slot is released when the pool-size refusal is raised (the next call on the same entry gets the same 400, not 429).

### Guard and browser (L4, L5)

- **Old against new guard:** 300,000 random queries (fragments with comment openers and closers, CR, LF, NUL, VT, FF, NBSP,
  NEL, U+2028, BOM, emoji, lone surrogates, quotes, doubled quotes and backticks, `LOAD CSV`, `CALL`, namespaced calls): the same
  verdict for all; 264,676 refused, with all six reasons occurring.
- **Browser against server, API:** 20 selected character cases, 14 size cases (65,535/65,536/65,537 bytes of four character
  widths, 40,000 é, 40,000 a) and 400 random lines through the real route as viewer: agree on verdict and reason text.
  Offline, 60,400 lines: agree except L4.
- **Chromium as viewer:** the policy line shows the specific reason for each refused case (lone CR, é outside strings, NUL, an
  open string, 80 KB of é); Run is disabled for them and enabled for CR LF after a comment, `'Zoë'` and 40,000 a, which then
  run (`success`). The long reason is clipped on screen but complete in the element's `title` and in the F1 docs dialog. The
  Workbench policy line as admin shows "Line 2: Outside strings and `quoted` names…" for a four-line script with three refused lines,
  and the line status list has each line's reason.
- The server's `hint` field carries the reason for graph refusals (the `message` is generic), so any client reading only
  `message` shows no reason; the web UI reads `hint`.

### Data leaving the server

My server log (about 4,600 lines, audit included) contains no Cypher text (no `DETACH DELETE`, `reduce(`, `range(1`,
`MATCH (n`, `LOAD CSV`, `CREATE (`, `RETURN 1`); audit lines carry `key#<hash>` and `<n bytes>`. The poolSize-1 message names
`poolSize`, which is tuning information, not a secret. I did not re-check URLs and browser storage.

## Not covered

- The 15-minute hold (checked in code and the unit test; not waited), memory exhaustion in FalkorDB, a half-open connection to a
  hung engine (round 3's unreproduced suspicion; the fixers left it as it is).
- The global `maxInflightCommands` coupling was not re-measured; INSTALL now states it and the code matches (`CappedPool.send`
  holds the slot until the command returns).
- Revocation during an Import with a graph line (logout, disable, demotion): the code paths are unchanged by the fixes and
  were not exercised this round. Several console instances, cluster and Sentinel graph setups, assistive technology.
- The integration, e2e and topology suites (single unit files and typecheck only).

## Observations (not findings)

- `GRAPH.EXPLAIN` takes the same slots as a query, so a user's EXPLAIN is refused while their own slow query runs (it does not
  execute anything; round 2's design).
- The slots bound held graph queries only: another user's `BLPOP` (up to 5 s, one per user) can still occupy the second
  connection of a poolSize-2 tier, as the fix's title says (graph queries never take every connection).
- Test additions leave a stray blank line at the end of `graph-engine-slots.test.ts` and `graphPolicy.test.ts`; the
  INSTALL, SECURITY and D21 paragraphs have unwrapped lines of 370-440 characters.

## Cleanup

Server stopped by PID (the `pnpm` launcher and its `node` child), all `rv4g:20261027:` keys deleted from the graph sandbox (prefix
scan: 0), the derived config, server log, helper scripts, screenshots, session files, the temporary data directory and the
temporary QA accounts file removed. No product code or test file was changed; the build output of the web app is gitignored.
