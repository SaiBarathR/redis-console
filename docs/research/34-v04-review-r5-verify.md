# v0.4 round 5: last-fix verification

Reviewer: GPT-6.1 Sol. Date: 2026-10-27.
Snapshot: `release/v0.4 @ 5253c7f` (`5253c7f4c95d750fdfec499c85b67dbdc9afa783`).
Review branch: `review/v04-r5`.

**One Low finding, L1; no new High or Medium finding reproduced. Fixes 1, 2 and 4 pass this targeted
verification. Fix 3 is partial: cancellation can still have the wrong terminal state when a graph error and
“Stop on first error” coincide.** There is no reproduced extra dispatch or authorization bypass in that case.
Only this report is committed; product code and permanent tests are unchanged.

## Scope and environment

Read the local machine rules first, then the agent guide, particularly sections 2, 4, 8 and 9;
`docs/research/32-v04-review-r4-data.md`; and the round-4 data and graph verdicts in `docs/REVIEW-LOG.md`.
Reviewed the source and tests for `cd3d46d`, `55959e3`, `be44e41`, `4bd3cd4`, `1468c8c` and `c81048d`.
The scope is the four requested fixes, their adjacent dispatch/confirmation paths and their browser flows.
This is not a general v0.4 audit or qualification of every release gate.

Built the web application before starting a separate, non-watching server on port 4500 with disposable application
state. Used a temporary derivation of `config/rconsole.dev.json`: omitted the snapshot entry, set the graph entry's
`poolSize` to 2 for the live cross-user slot-wait check, and added a graph alias with `poolSize: 1`.
Database discovery consequently stayed on the permitted sandbox services. Node 24.14.1; pnpm 11.7.0;
Redis 8.10.2; existing FalkorDB sandbox; Playwright 1.64.1 with headless Chromium; existing Keycloak on 8089.
No forbidden Redis endpoint, owner application port, owner application data or other checkout was used.

Every Redis fixture used `rv5:20261027:`. Writes were on `sandbox-e2e` (6411) and `sandbox-graph` (6413).
The graph cancellation check used **one** long expression, with `TIMEOUT 1`; it returned its timeout error in
about 1.5 seconds. Other graph probes were constant-result queries or one-node fixture setup/cleanup.
No shared service was started, restarted or stopped. QA accounts were created against this review's instance
from an empty QA directory; their credentials stayed in the ignored QA file and process memory.

## Finding

### L1. A cancelled graph import ends “Stopped” when its reply is an error and stop-on-error is enabled

- **Where:** `apps/server/src/routes/import.ts:435`–`:450`, especially the return at `:446` before the final
  `signal.aborted` check. Browser surface: Guided → Import, “Stop on first error”, progress status.
- **Reproduction:** create the sandbox graph `rv5:20261027:graph` with one node. As operator, paste this single line
  into Import, check the file, enable **Stop on first error**, start it, and cancel while it is running:

  ```text
  GRAPH.RO_QUERY rv5:20261027:graph "RETURN size(reduce(s = '', i IN range(1,300000) | s + 'x'))" TIMEOUT 1
  ```

  The review cancelled within the first few hundred milliseconds, before the engine replied. Poll
  `GET /api/v1/databases/sandbox-graph/import/:id` after the engine finishes.
- **Observed, live Chromium and HTTP:** the cancel was accepted, but the final job and UI were **`stopped`**, with
  `processed: 1`, `failed: 1`, `succeeded: 0`, `skipped: 0`, failure `redis_error: Query timed out`, and stop reason
  `Stopped at the first failure (line 1); the remaining commands were not sent.` The admin audit's `import.finish`
  entry likewise said `stopped: succeeded=0 failed=1 skipped=0`. The line's error was correctly counted.
- **Independent deterministic reproduction:** exercise the real Import routes with an in-memory application store
  and a deferred fake graph connection. Plan/start one read line, await its send, POST cancel, then reject that
  send with Redis `ErrorReply('Query timed out')`. With `stopOnError: true`, the assertion
  `expect(final.state).toBe('cancelled')` fails with `stopped`. Three controls pass: successful reply with either
  stop-on-error setting, and error reply with `stopOnError: false`. No real graph work was used for these controls.
- **Cause:** `execute` represents an engine error reply as a completed command with `reply.t === 'err'`;
  Import records that failure and returns `stopped` at `:446`. The new cancellation check at `:450` is unreachable
  in this branch. The earlier cancellation branches handle thrown execution failures, not this completed error reply.
- **Expected/impact:** a job cancelled while its graph line runs should end `cancelled`, retaining the completed
  line's failure count and explaining that it finished. The present result loses the user's cancellation intent in
  the UI/API/audit. No following command was sent in the reproduction, and this finding does not imply that closing
  or cancelling can stop FalkorDB's already-running expression. Severity is Low: reporting and audit accuracy.
- **Suggested fix:** after recording a completed line and its error, give an already-requested cancellation precedence
  over the stop-on-error return. Preserve the line's success/failure counts and skip only the remaining lines.
  Add controls for successful/error graph replies, both stop-on-error settings, and a remaining second line.

## Verdicts for the requested fixes

| Fix | Verdict | Evidence and qualification |
|---|---|---|
| **1. Piecewise array matching — `cd3d46d`** | **Verified** | Original short-needle reproduction repeated with an independent HTTP client; native scans no longer produce the prior 400 ms individual stall. Four concurrent native searches peaked at 32 ms health wait. 1,296 chunked/one-go comparisons agreed; boundary, NOCASE, EXACT, AND/OR, many predicates, threshold sizes, several near-cap values, GLOB and continuation controls passed. GLOB retains its existing synchronous work allowance; measured limits are detailed below. |
| **2. Same-byte argument rules / VSIM limit — `55959e3`** | **Verified** | 73 direct browser/server policy comparisons agreed. Chromium accepted the old escaped-200 and literal-300-é VSIM reproductions, accepted 1,024 actual FILTER bytes and refused 1,025. Literal and mixed escaped UTF-8 graph queries at 65,536 bytes ran; 65,537-byte queries were blocked on both sides, for every reviewed role/session type. |
| **3. Import cancel / pre-aborted execute — `be44e41`, `4bd3cd4`, `1468c8c`** | **Partial: L1** | Successful completed graph reply and default-setting graph-error cancellation controls end `cancelled`. Live cancel during a graph-slot retry ends `cancelled`, `processed: 0`, `skipped: 1`, with no in-flight claim. A deterministic cancel/release race sent zero commands. Pre-aborted `execute` sends neither graph nor ordinary commands. Live BLPOP cancels promptly for operator/admin. A completed graph error with stop-on-error enabled still ends `stopped` (L1). |
| **4. Pool of one policy refusal — `c81048d`** | **Verified** | Console returns 400 `validation` with the `poolSize` explanation before confirmation, including mutating graph commands for writer roles. Import plans mark graph query lines blocked and retain the GRAPH.LIST control. Viewer restrictions continue to take precedence for writes and Import. |

## Checked and sound

### Array matching, latency and result integrity

`matchInPieces` folds in bounded slices and scans slices overlapping by needle length minus one; it reuses the folded
value across non-glob predicates. The work allowance remains shared across predicates and elements. Both combiners
short-circuit without replenishing it. EXACT keeps the original equality semantics; predicates are still capped at
1,024 bytes. Large GLOB values keep the bounded glob matcher, not substring chunk semantics.

The direct matrix compared `searchMatcherInPieces` with `searchMatcher`, with sufficient allowance to compare actual
answers: eight value sizes from empty through 256 KiB − 1, exactly 256 KiB, 256 KiB + 1 and near 8 MiB; EXACT/MATCH/GLOB;
both case settings and AND/OR; one/eight predicates; empty needles, non-ASCII bytes, NUL, classes and escaped patterns.
Additional 1,024-byte needles crossed the first and second piece boundaries at several offsets. **1,296 comparisons,
zero answer mismatches.** Production allowance/skip behavior was checked separately through the integration tests and
real HTTP calls; the unbounded comparison allowance was not used to claim production CPU safety.

The live latency client ran in a different process from the server and polled health while issuing search requests.
The final measurements used 12 ms polling, asserted HTTP 200 on health probes, and included requests overlapping the
end of a search. This avoids missing the last blocked health request. The original fixture had two values each
`8 * 1024 * 1024 - 64` bytes of `a` followed by `b`; eight NOCASE MATCH `ab` predicates used OR.

| Live shape | Search duration | Maximum overlapping health wait |
|---|---|---|
| Original reproduction, three repeats | 722 / 712 / 705 ms | 10 / 10 / 11 ms |
| Eight AND MATCH `a` predicates | 55 ms | 12 ms |
| Eight case-sensitive MATCH `ab` predicates | 783 ms | 10 ms |
| Eight NOCASE EXACT `ab` predicates | 50 ms | 9 ms |
| Four concurrent original searches, two runs | 2,787 / 2,766 ms overall; all eight responses 200 | 32 / 32 ms |
| Values at 256 KiB − 1, 256 KiB, 256 KiB + 1; AND/OR and both case settings | 4–67 ms | At most 18 ms |
| Three near-cap values, continued from 0 → 1 → 2 | 709 / 725 / 432 ms | 13 / 11 / 11 ms |

The three-near-cap run reached the final small element without skipping an index or returning its own continuation
start. The boundary fixture found a mixed-case needle straddling 256 KiB; the browser used that same fixture.

**Retained bound, not a strict 10 ms scheduling guarantee:** GLOB still executes synchronously until its shared
16-million-step allowance is spent. Large short/long suffix globs and character-class globs returned explicit
`skipped: ["0"]`, `next: "1"`; single-search health waits were at most **107 ms** across the completed probes.
Four concurrent short globs completed in 395 ms with a **166 ms** maximum health wait; four class globs completed
in 263 ms with a 98 ms maximum wait. No unlimited matcher or return to the original native-scan stall was reproduced.
These timings qualify the tested environment and shapes, not a universal CPU deadline or worker isolation.

### Byte rules and browser role coverage

`serverForm` now uses `tokenizeCommandLineBytes` directly and converts each resulting byte to one latin1 character.
`argumentRule` documents that representation; VSIM counts its length once. The 73-case comparison covered ASCII,
two-/three-/four-byte Unicode and mixed literal/raw-byte forms at 1,023/1,024/1,025 FILTER bytes; graph size boundaries;
raw control/high bytes; and graph refusal controls. No shared-rule verdict disagreement was found.

Ten completed Chromium sessions comprised four primary role sessions, two cancellation sessions and four graph-byte
boundary sessions: local viewer, operator and TOTP-admin, plus Keycloak viewer. Every primary role session used the
actual array inspector for the crossing-boundary match and large native scan, then Continue; executed VSIM in Console
and escaped-byte VSIM in Workbench; and used the pool-one Console flow. Operator/admin used the Import plan UI;
both viewer sessions had Import hidden and received 403 on the corresponding direct request.

For every role/session type, the actual Console Run control and identical-line API checks agreed at the VSIM boundary.
The later graph-byte sessions tested two literal/mixed-escape forms at each side of the 64 KiB limit: **16 browser
decisions**, with accepted cases also executed against FalkorDB and refused cases returning server 403.
Completed sessions recorded **zero page errors, zero CSP/Trusted Types violation events, zero unexpected external
requests, and zero fixture-data URLs**. CSP events were retained outside the document across navigation.

### Import dispatch, counters and pool policy

The one live long graph Import ran as operator with stop-on-error enabled. While it occupied the single permitted
graph slot on the pool-two entry, admin started a one-line graph Import and cancelled during its retry wait. Admin's
job ended `cancelled`, `processed: 0`, `failed: 0`, `skipped: 1`, without `inFlightLine` or “may have run”. Its audit
finish entry said `cancelled: succeeded=0 failed=0 skipped=1`; it had no graph `import.exec` event. The operator's
engine-error outcome exposed L1. Subsequent constant queries succeeded after the engine released its slot.

The deterministic route test held the graph slot, started Import, cancelled while it waited, then released the slot.
After more than a retry interval, the fake transport still had **zero sends**, the current line was skipped rather
than processed, and no “cancelled while in flight” audit was recorded. The shipped `execute` test separately proves
that an already-aborted signal is refused before dispatch or slot acquisition for graph and ordinary commands.

Actual BLPOP Imports on nonexistent review-prefixed keys requested a five-second wait. The UI cancellation controls
ended them `cancelled` in **45 ms (operator)** and **26 ms (admin)** after cancellation, with an honest in-flight
qualification. The isolated shipped BLPOP regression passed too. Import's wrapper still propagates its signal to
ordinary transport sends and explicitly preserves the graph send's separate socket lifetime.

`prepare` checks the pool size after authorization and before caps/preview/confirmation; CLI, Workbench and Import
planning share it. Browser pool-one RO_QUERY returned 400 without any confirmation dialog in all four primary
sessions. Additional QUERY, PROFILE and EXPLAIN API controls were refused before confirmation; viewer QUERY/PROFILE
remained 403 by role. Both writer Import plans contained RO_QUERY, QUERY, EXPLAIN and GRAPH.LIST: exactly three blocked
lines and one admitted read, without raising a graph-write confirmation for the blocked lines.

## Validation and limits

| Check | Result |
|---|---|
| Web production build, including web TypeScript | Passed |
| Server unit `array.test.ts` + `graph-engine-slots.test.ts` | 21 passed |
| Array integration file, temporary copy adapting only its fixture prefix | 26 passed |
| Insight integration, temporary prefix-adapted copy; two selected Import tests | 2 passed, 18 intentionally unselected |
| Web `lib/policy.test.ts` | 21 passed |
| Shared array, vector-set and graph-policy files | 49 passed |
| Additional deterministic Import route checks, no Redis socket | 4 passed, **1 failed: L1** |
| Direct matcher / byte-policy comparison matrices | 1,296 / 73 passed |
| Final server/shared TypeScript checks after removing temporary tests | Both passed |

The selected shipped tests total **119 passed**. Temporary checks and prefix-adapted copies are review probes, not
permanent regression additions. Initial harness attempts split a surrogate pair in a mixed-byte fixture, raced login
completion or exceeded the independent CLI line-length limit; the corrected probes passed. Continuous 2 ms health
polling also exhausted the server's general per-IP rate gate and produced 429 responses. Those incomplete latency
runs are excluded from the final table; the final 12 ms runs asserted successful health and search responses.

Full E2E, topology, other release features, failover, mobile and screen-reader behavior were not tested.
The targeted fixes introduce no reproduced High/Medium blocker, but fix 3 should not be described as completely
verified until L1 is addressed and its error-reply control passes.

## Cleanup

Deleted five remaining review keys on 6411 and the one-node graph on 6413. Final scans found **zero**
`rv5:20261027:*` keys on 6410, 6411 and 6413. Integration fixtures had already been removed by their teardown.

Stopped only the review application's child/parent PID pairs: **51568/51556** for the initial successful start and
**59898/59886** for the pool-two configuration run. All four PIDs were absent afterwards and port 4500 had no listener.
Every headless Chromium instance was closed. Removed the disposable application-state directory, owned server log,
QA credentials/directory, derived config, temporary test copies, deterministic probe and other review harness files.
The only remaining worktree change is this report. No shared service/container was stopped; no commit was pushed.
