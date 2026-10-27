# v0.4 round 4: targeted data fix verification

Reviewer: GPT-6.1 Sol. Date: 2026-10-27.
Snapshot: `release/v0.4 @ acbffbe` (`acbffbefbe834b0b210f13d2ffcd9211332f0d83`).
Review branch: `review/v04-r4-data`.

**Release recommendation: hold for M1. No High finding; one Medium and two Low findings reproduced.**
Round-3 H1 is partially fixed: costly globs are bounded, but short native MATCH scans still pause unrelated HTTP
requests for hundreds of milliseconds. Round-3 M1 and M2 passed. The browser argument-rule change fixes ordinary
UTF-8 parity but mishandles raw byte escapes (L1). The non-ASCII VSIM check also exposes an existing byte-counting
error, now mirrored in the browser (L2). Only this report is committed; product code is unchanged.

## Scope and environment

Read `AGENTS.local.md` first, the agent guide including sections 2, 4, 8 and 9, round-3 report
`docs/research/30-v04-review-r3-data.md`, its data-fix verdict table in `docs/REVIEW-LOG.md`, and D22.
Reviewed `22db3c1`, `b639ffa`, `73c64c7`, and `1655251`; the matcher, read accounting, continuation, redaction,
shared argument rules, both tokenizers, server classification and changed browser flows.

Built the web application before starting an isolated server with `config/rconsole.dev.json`, port 4500 and disposable
application state, using `start` without a watcher. Node 24.14.1; pnpm 11.7.0; Redis 8.10.2; Playwright 1.64.1 with
headless Chromium. All fixture writes were on `sandbox-e2e` (6411), under `rv4d:20261027:`. Cleanup checked both
permitted sandboxes, 6410 and 6411. The existing Keycloak sandbox (8089) supplied one Chromium viewer sign-in;
local viewer, operator and TOTP-admin sessions supplied the other three completed browser sessions.

**Scope deviation:** the required dev config also lists the snapshot and graph services. The database picker calls
`GET /api/v1/databases`, whose handler connects to every configured entry and reads `INFO server modules` or `PING`
(`apps/server/src/routes/databases.ts:67`). Browser discovery therefore made incidental metadata connections to 6412
and the explicitly excluded 6413; the server's open sockets confirmed those connections. This was a reviewer error.
No graph query, graph fixture, or write on either service was performed. After identifying it, further verification
used explicit sandbox endpoints without database discovery. No banned Redis endpoint or owner application port was
contacted; no other checkout was modified. Future isolated review config must omit excluded entries before browser
sign-in, since selecting a permitted database does not constrain discovery.

Additional boundary and low-display-cap checks used Fastify HTTP injection against real sandbox Redis through the
measured transport, with test-role aliases pointing to 6411 and disposable in-memory application stores. They did
not start another HTTP listener. The latency findings used independent client and server processes.

The collaborative preview navigated but two snapshot attempts returned
`Preview automation snapshot timed out after 15000ms.` Headless Playwright supplied the browser evidence.

### Validation

| Check | Result |
|---|---|
| Web production build | Passed, including TypeScript |
| Server TypeScript check after removing temporary probes | Passed |
| Server unit array, redaction, RESP and capped files | 89 passed |
| Web policy and array component files | 39 passed |
| Shared array, graph-policy and vector-set files | 49 passed |
| Array integration file, temporary copy with fixture prefix adapted | 25 passed |
| Additional real-transport boundary searches | 56 passed, forward/reverse and fresh starts at the large element |
| Display byte/element-cap and malformed-argv probes | 113 checks passed |
| Live partial slow-log console and Workbench controls | Viewer/operator redacted; admin visible; all six responses 200 |
| Direct matcher matrix | 36 combinations: three kinds, two case settings, AND/OR, eight predicates, three value sizes |
| Additional native MATCH timing sweep | 40 cases, needle lengths 1–1,024; exposed M1 |
| Many-value continuation matrix | 24 cases, 456 requests, 840,000 total elements examined, no skips or repeated starts |
| Additional Redis ARGREP differential | 768 comparisons, zero mismatches when matching allowance sufficed |
| Browser/server policy matrix | 82 cases; 77 agreed, five byte-escape mismatches (L1) |
| Completed Chromium role/sign-in sessions | Four; zero page errors, unexpected external origins or fixture-data URLs; final-console CSP snapshots empty |

The many-value matrix searched 50,000 one-byte values and 20,000 one-KiB values, with eight predicates of every kind,
both case settings and AND/OR. It covered all elements through continuation; the longest request was 169 ms, with
yields between elements. Initial expanded harness attempts exceeded the real per-user search rate limit (429);
subsequent runs used fresh test actors between bounded groups of requests. One browser assertion expected the word
“matching” instead of the shipped “too costly to match”; correcting the assertion completed the flow. An interim
server typecheck included temporary probe TypeScript and failed on probe-only typing errors; removing those files
restored the passing product check. These initial attempts are not counted as passing verification.

Full E2E, topology/failover, graph engine behavior, mobile and screen-reader testing were not run. The review is a
targeted verification, not qualification of all release gates. Timings describe this environment, not a portable
worst-case CPU guarantee.

## Findings

IDs below belong to **round 4**.

### M1. Short native MATCH scans still hold the event loop far beyond the yield interval

- **Where:** `apps/server/src/redis/array.ts:203`, `:216`, `:221` and `:330`; the allowance charges native scans by
  value length, but `Buffer.indexOf` and all predicates for one value execute synchronously before the yield.
- **Reproduction:** on the writable sandbox, create `rv4d:20261027:latency:two` with index 0 and index 1 each holding
  `8 * 1024 * 1024 - 64` ASCII `a` bytes, and index 2 holding `b`. As viewer, POST
  `/api/v1/databases/sandbox-e2e/array/search` with this body:

  ```js
  {
    key: { enc: 'utf8', data: 'rv4d:20261027:latency:two' },
    start: '0', end: '2', values: false, nocase: true, combine: 'or',
    predicates: Array.from({ length: 8 }, () => ({
      kind: 'match', value: { enc: 'utf8', data: 'ab' }
    }))
  }
  ```

  From an independent client process, repeatedly request `GET /healthz` at approximately 2 ms intervals while the
  search runs. The client timer must not share the server's event loop: an in-process timer delayed by matching
  would conceal part of the outage.
- **Observed:** the first live search returned 200 in **717 ms**, while a health request waited **428 ms**. Three
  independent repeats took **706, 679 and 687 ms**, with maximum health waits **421, 406 and 413 ms**. The response
  was `{items:[],start:"0",searchedTo:"0",elements:1,next:"1"}`. Continuing from 1 completed at index 2; no value was
  skipped. Four concurrent allowed searches all returned 200, completing in 2,702 ms, with a maximum health wait of
  **818 ms**. No other application instance was stressed.
- **Cause:** `MATCH ab` repeatedly tests candidate `a` bytes before failing on `b`. Eight native scans of one near-cap
  value, plus its NOCASE fold, fit within the shared 16-million-step allowance. The timing sweep measured up to
  **418 ms** for that single matcher call. By contrast, eight failing 1,024-byte MATCH needles were much faster;
  testing only long patterns misses this case. Charging “8 bytes per step” does not make native scans have the same
  CPU cost as glob steps. The 10 ms yield is checked only after the complete value has been matched.
- **Expected/impact:** a viewer search should allow unrelated HTTP work to proceed near the intended cooperative
  interval. This remains a process-wide availability issue affecting health, sign-in and other users. The new bounds
  substantially improve the original multi-second glob case and limit admitted work, so this is rated Medium rather
  than treating the original unbounded-stall severity as unchanged. No authorization or result-integrity bypass was
  reproduced.
- **Suggested fix:** make scans and folding resumable in bounded chunks, yielding within a value/predicate sequence,
  or run matching in isolated workers. Preserve substring overlap across chunks and share the allowance across all
  predicates. Calibrate scan accounting conservatively, but do not rely on accounting alone for the yield promise.
  Add this short-needle case and an independent-client HTTP latency assertion; retain the long-glob regression.

### L1. Browser byte conversion re-encodes redis-cli byte escapes and refuses valid commands

- **Where:** `apps/web/src/lib/policy.ts:24`, `:48` and `:67`; compare
  `packages/shared/src/commands.ts`'s `tokenizeCommandLineBytes` with `tokenizeCommandLine`.
- **Reproduction:** seed vector set `rv4d:20261027:live:vector` with member `m`, vector `[1,0]` and attributes
  `{"x":"ok"}`. In the viewer console, construct a line with 200 UTF-8 `é` sequences entered as raw byte escapes:

  ```js
  const filter = ".x == '" + '\\xc3\\xa9'.repeat(200) + "'";
  const line = `VSIM rv4d:20261027:live:vector ELE m FILTER "${filter}"`;
  ```

  Put `line` in the actual console editor, then submit that identical line directly to the console API with the
  same authenticated session and CSRF token.
- **Observed:** Chromium disabled Run and displayed the 1,024-byte FILTER refusal. The identical API request returned
  **200**, with a valid empty array reply. The equivalent literal-text filter containing 200 `é` characters enabled
  Run. Server classification was `read`; browser classification was `blocked`. The browser implementation before
  `1655251` allowed the escaped form. The 82-case matrix found five such mismatches, including graph size decisions
  with raw escaped query bytes. Graph cases were policy-only; no graph engine was queried.
- **Cause:** the string tokenizer turns `\xC3` into the JS character U+00C3, losing the distinction between that raw
  byte and literal Unicode text. `serverForm` then UTF-8 encodes it again. The server uses the byte tokenizer and
  preserves the original byte. The resulting argument-rule inputs differ.
- **Impact:** valid byte-exact console commands are blocked by the browser; the shared Workbench policy uses the
  same conversion. The server's authoritative refusal remains intact. This is an over-refusal, not a server bypass.
- **Suggested fix:** derive argument-rule input from `tokenizeCommandLineBytes(line)`, converting those bytes directly
  to latin1 without encoding them again. Keep the display/documentation tokenizer separate as needed. Test literal
  Unicode, raw high-byte escapes, escaped UTF-8 sequences, mixed forms and byte-limit boundaries against server
  classification, rather than reconstructing bytes from an already-decoded string.

### L2. VSIM's byte limit counts a UTF-8 encoding of the byte representation

- **Where:** `packages/shared/src/commands.ts:346` and `:351`, called with latin1 byte strings by
  `apps/server/src/policy/policy.ts:61` and `:108`, and now by the browser's `serverForm`.
- **Reproduction:** use the same sandbox vector fixture and a literal filter
  `".x == '" + 'é'.repeat(300) + "'"`. Its actual UTF-8 size is **608 bytes**, below
  `VSIM_FILTER_MAX_BYTES = 1024`. Submit `VSIM <fixture> ELE m FILTER "<filter>"` through the console.
- **Observed:** server policy returned **403 `command_blocked`** with the 1,024-byte limit hint; the browser disabled
  Run too. The same filter against that fixture directly in sandbox Redis succeeded with an empty result. A
  200-character literal control was accepted through the console. The previous browser implementation allowed the
  300-character case; the current browser agrees with an already-incorrect server measurement.
- **Cause/impact:** server classification already represents each wire byte as a latin1 character. `utf8Length`
  UTF-8 encodes that representation again, inflating non-ASCII arguments. This is a **pre-existing server bug**, not
  a new server bypass introduced by `1655251`; that commit propagates the conservative refusal into the browser.
  Legal filters below the documented byte limit become unavailable through console/Workbench.
- **Suggested fix:** define one byte representation for shared argument rules and measure that representation's
  byte count once. With latin1 byte strings, use their length; normalize any Unicode callers before the rule. Test
  ASCII, two-/three-/four-byte text and raw byte escapes at 1,023, 1,024 and 1,025 actual bytes.

## Round-3 fix verdicts

| Fix | Verdict | Evidence and remaining limit |
|---|---|---|
| H1 — `22db3c1`, matcher allowance/yields | **Partial** | Original 1 MB, 1,024-byte suffix-glob case and eight-predicate class controls exhaust the allowance and report index 0 skipped, then advance. Live eight-predicate glob controls took 44–76 ms, health waits at most 67 ms. Glob inner/class loops share the counter; folding and native scans share it across predicates/values. **Round-4 M1 remains for short native MATCH scans.** |
| M1 — `b639ffa`, first element alone | **Fixed** | Shipped integration and 56 additional forward/reverse boundary searches never returned their own start. With a two-digit element index, value size 8,388,583 fit; 8,388,584 crossed the complete-reply boundary and was skipped. Tested through 8 MiB + 1, sparse neighbors, first large values and later large values. Subsequent matching neighbors remained reachable. All four Chromium sessions skipped 8 MiB − 1 and Continue reached index 1. |
| M2 — `73c64c7`, partial slow-log redaction | **Fixed** | 113 synthetic cap/shape checks; actual console and Workbench at a 1 KiB display cap hide viewer/operator canaries while retaining the admin control. Byte- and element-cut argv and entries retain omission metadata. Chromium viewer/operator/Keycloak-viewer console controls hide the canary; admin sees it. |
| Graph L5 / shared browser argument rules — `1655251` | **Partial** | Ordinary non-ASCII graph queries now agree with the server's 64 KiB decision; shared policy tests pass. Raw byte escapes are re-encoded (L1). Ordinary VSIM Unicode now mirrors the server, including its pre-existing length error (L2). ASCII role, read-only, production, confirmation and catalog checks were not changed by this patch. |

## Checked and sound

### Matching correctness, allowance and continuation

The step counter is shared across all evaluated predicates and values; AND/OR short-circuiting does not replenish it.
Glob literal steps and character-class loops charge inside their loops. Consecutive-star cleanup is pattern-bounded,
and wildcard admission remains capped at eight. NOCASE folds only ASCII; one value's folded buffer is reused across
its non-glob predicates and its scan is charged once. No unchecked predicate path restoring an unlimited allowance
was found in `searchArray`. Native scan timing remains the exception described in M1.

The 36-case matcher matrix used one-KiB, one-million-byte and near-eight-MiB values, eight predicates, both combiners,
and case-sensitive/NOCASE EXACT, MATCH and GLOB. Costly globs threw at the shared allowance. The shipped unit controls
check that sufficient allowance preserves results; 768 additional real Redis ARGREP comparisons had zero mismatches
for empty, escaped, binary, ASCII and Unicode values, classes and generated patterns. The shipped integration file
also compares predicate combinations. Redis builds with different signed-character range behavior remain outside
qualification, as documented in D22.

A value costing more than a whole allowance is explicitly skipped with its index; a value encountered after earlier
work has exhausted the allowance is retried by the next request with a fresh allowance. The shipped unit tests
exercise this distinction. Both the original expensive glob and near-cap byte skip displayed the notice in all four
browser sessions, and Continue advanced and terminated. The new native-scan reproduction also progressed correctly.
The search is not a snapshot under concurrent writes; no stronger consistency promise is inferred from these checks.

The read-cap test is a complete RESP reply boundary, including framing, not an exact value-byte cutoff. Reading the
first element alone fixes the old framing-overflow loop. Byte and element limits, monotonic continuation in both
directions, and accounting after an overflowing batch passed their scoped checks. Redis still builds replies before
the client can close the socket; these tests qualify application-side retention, not cancellation of engine work.

### Slow-log boundaries and browser behavior

The display-cap sweep combined nine byte budgets with twelve element budgets, plus five malformed-argv controls.
It covered entries ending before client fields, partial argv, truncated strings, and non-array argv placeholders.
Available command/key fields remained visible; value canaries and client addresses did not. The transformation
preserves array omission counts. A non-array top-level entry is still passed through by the redactor, but neither
Redis's fixed slow-log entry shape nor display truncation produced a data-bearing malformed entry in these probes;
no reachable disclosure was reproduced from that source-only possibility.

The live low-display-cap fixture used an ordinary large `SADD` under the review prefix. No shared slow-log threshold
was changed and no log was reset. All viewer/operator console and Workbench controls redacted the canary despite
partial entries; admin controls retained it. Normal shipped-cap console use passed in all four Chromium sessions.

Each completed Chromium session exercised costly array search, its skip notice and Continue; near-cap array search
and Continue to the matching later element; and console slow-log execution. Viewer additionally reproduced L1 using
the actual console Run state and the identical API request. Local admin completed TOTP and the Keycloak viewer
returned through the OIDC callback. The browser recorded no page errors, unexpected external origins or fixture values in URLs. CSP event arrays were
empty on the final console documents; counts from earlier full navigations were not retained, so full-session CSP
coverage is unqualified. No claim is made about actual screen-reader behavior.

## Cleanup and handoff

Stopped the application child PID **83458** and its pnpm parent **83446**, both started by this review. Port 4500 had
no listener afterwards. Closed headless Chromium and the collaborative preview. Deleted the remaining five live
fixture keys, then verified zero `rv4d:20261027:*` keys on both 6410 and 6411. Removed the disposable application state,
QA credentials, temporary probe/test files and comparison module. Synthetic fixture arguments may naturally remain
in the shared slow log; it was deliberately not reset. No shared service/container was started, restarted or stopped;
no commit was pushed. The incidental metadata access to excluded configured entries is recorded above rather than
claimed as compliant coverage.

After this cleanup, continuation found newly created QA files, a temporary array test, a recreated application-state
directory and a different listener, PID **18153**, on port 4500. These were not created by this review's recorded
commands; ownership was unverified. They were left untouched. The zero-key and removed-state assertions above refer
to this review's completed cleanup, not to that subsequent activity. Only the report is staged and committed.
