# Redis Console v0.2: measured replies

> **Round 4 update** (`feat/v02-server4`, see [REVIEW-LOG](../REVIEW-LOG.md) "Round 4 – server"): several limits
> below changed. Excess work now waits in a short bounded FIFO queue (at most 2 s) before 429. Streams no longer
> hold a measured-command slot; they have their own server-wide budget (`policy.maxStreams`). Pub/sub and MONITOR
> events keep at most 64 KiB per string and arrive cut instead of closing the stream. SCAN loops that drop their
> pages cap each reply alone instead of sharing one request budget. MOVED/ASK are followed only within the known
> topology. Server metadata reads use fixed caps. The design and measurements below are otherwise unchanged.

Branch `feat/v02-replycap`, based on `b9ea7e2`, with `release/v0.2` `7a47aa0` merged. Implementation: `62e3829` (consolefix cancellation),
`ace4bc4` (measured transport and estimator removal), `0b4b6a5` (socket/initialization regressions), `7851bfa`
(concurrent stream refresh compatibility), plus merge `5181a8e` preserving the updated cancellation UI. No push. No new dependencies.

## Design and bounds

Console and workbench commands use exclusive raw `net`/`tls` sockets. The RESP reader counts incoming wire bytes
before retaining/decoding them. Oversize bulk lengths can be refused at their header; otherwise reading stops as
soon as the byte/element/depth limit is crossed. The socket is destroyed, and CLI returns 413 `too_large`, with
the configured byte cap and a SCAN/COUNT/ranges hint. Workbench keeps its existing HTTP 200/per-line error shape.
No partially decoded result is returned or reused as a later command's reply.

Defaults: `policy.maxReadReplyBytes = 16,777,216`, `policy.maxInflightCommands = 16`, 100k wire values, depth 32.
Payload buffer allocation is bounded by the cap; one 64 KiB socket read chunk and bounded parser scratch/objects
are additional. RSS is not equal to live payload bytes: Node retains allocator pages and also holds clients,
parsed JS values and encoded HTTP/SSE output. Configuration must budget those constant-factor costs too.
Ordinary database requests hold a global slot through response serialization. Typed multi-read requests share a
cumulative wire budget, so earlier replies cannot accumulate without a limit while later reads run. Per-user
limits are four CLI commands, one blocking command, four typed data reads, two key scans and one workbench;
workbench also retains its four-display-budget output limit. Excess requests/pool work get 429 without a wait queue.

Pools are per database/role, at most `db.poolSize` exclusive sockets, retired after 30 seconds idle. Every new
socket uses HELLO 3 AUTH/SETNAME and SELECT with the same effective-role credentials, TLS verification/CA/client
certificate/key/servername and logical DB as the existing manager. Passwordless named ACL users are explicitly
authenticated too. An AUTH/HELLO/SELECT failure destroys the socket before it can enter the idle pool.

Cluster routing uses node-redis's current primary slot map, including binary hash tags. Keyless commands choose a
random primary. Only explicit MOVED/ASK replies get one retry; ASKING and the retried command share a socket.
Network failures, timeouts and second redirects never replay an ambiguous mutation. Sentinel uses the existing
sentinel client's current master. The hard deadline covers connection/authentication and redirects. Abort destroys
only the command socket, and workbench sends no later lines. A mutation may already have executed when canceled.

Node-redis remains for topology management and typed scalar/status replies whose sizes do not depend on stored
values/names. Data-dependent typed replies also use the capped path: key scans, collection/JSON/stream reads,
search pages, INFO/command docs, clients, slowlog and group/consumer metadata. Internal COMMAND policy metadata
has a fixed measured 2 MiB cap, so a small data cap does not erase the command table. Pub/sub and MONITOR were
also unbounded before preview truncation; their dedicated sockets now measure each event and close SSE with a
`too_large` error on overflow. Stream lifetimes hold a global measured-command slot.

The decoder covers RESP2/3 scalar and aggregate types, attributes, pushes and streamed aggregates. It preserves
binary map keys, including maps outside the old pair-command list. Unsupported streamed bulk strings fail
closed; Redis command replies do not emit them. Simple strings/errors/MONITOR lines have a 64 KiB ceiling;
numeric/aggregate headers have a 512-byte ceiling. These are additional structural limits, not size predictions.

## Removed

- `policy/replyGuard.ts` (753 lines) and `policy/searchGuard.ts` (380 lines), plus tests of those removed estimators.
- Alias/term expansion; MEMORY/STRLEN/JSON.DEBUG and FT.AGGREGATE prediction probes; JSONPath/search grammar sizing;
  the sized/reviewed read allowlist; average-element sizing in the key browser; speculative search-page planning.
- No Redis value is fetched merely to estimate another value. Key-browser MEMORY USAGE remains only as displayed
  metadata. Command policy, role ACLs, readOnly/prod confirmations, SCAN/glob/blocking caps and display budgets remain.

## Round 3 verdicts

The report was cut off inside H2. It announces 2 High, 3 Medium, 6 Low, but does not preserve the remaining finding
text/IDs. H1/H2 and script-labelled L3/L5 retain their identifiers below. Other recovered findings are labelled by
script rather than inventing reviewer IDs. Every supplied `.mjs` was inspected and rerun/adapted; the helper files
were imported. Checked scenarios without a demonstrated defect are distinguished from findings.

| Evidence / finding | Verdict | Reproduction and result | Commit / regression |
|---|---|---|---|
| H1: APPLY alias expansion | Fixed, High | Old 20-step request: 88.51 ms and +38.7 MiB heap at completion (not peak). Fixed 30-step, 820-byte viewer request: 21 ms, Redis index error, no RSS increase. Also tests FT.PROFILE AGGREGATE. No local expansion code remains. | `ace4bc4`; `integration/replycap` H1 |
| H2: oversized values/ranges/key names | Fixed, High | 40 MiB first/last stream entries, LINDEX/LRANGE/XRANGE/XREVRANGE/XINFO, 3 × 40 MiB range and 20 MiB key names: 413. Long-key SCAN, RANDOMKEY and typed scan all capped. Typed stream read also 413. Whole collection sampling cases capped; compressed DUMP fits and succeeds. | `ace4bc4`; `integration/replycap` H2, typed reads; `unit/resp`, `unit/capped`; old review regressions |
| `fairness`: scan flood | Fixed, Medium | Original 20 scans delayed the other viewer's PING to 823–1546 ms in an in-process baseline. Fixed live flood: two accepted, eighteen 429; other viewer's PING 1–3 ms. Eight metadata workers per scan avoid flooding node-redis's queue. | `ace4bc4`, `7851bfa`; live `fairness`, scan tests, concurrent typed-read regression |
| `mget-probes` / `mget-latency`: sequential prediction work | Fixed, Medium | Original 9,999-key MGET: 696.84 ms (in-process baseline). Fixed live: 18 ms with **zero STRLEN probes**. Normal 1/25/100-key reads work on 6412 and remote-6390 through the app. HTTP and inject timings are identified separately. | `ace4bc4`; `integration/replycap` MGET; live scripts |
| `audit-echo`: argument text in planner errors | Fixed, Medium | Reproduced on baseline: FORMAT canary copied into the 413 audit detail. Fixed: Redis error audited only as `SEARCH_INDEX_NOT_FOUND`; canary absent. | `ace4bc4`; `integration/replycap` audit, prior logging regressions |
| `json-false`: everyday wildcard refusals | Fixed, Low | Original ~120 KiB JSON document (153,024 memory bytes): TYPE/OBJLEN/STRLEN/ARRLEN all 413. Fixed: all six scripted reads succeed, including wildcard/recursive selections and GET/OBJKEYS. | `ace4bc4`; `integration/replycap` JSON and prior JSON regressions |
| L3 / `small-confirms`: probe errors skip bounds | Fixed, Low, part of H2 | Baseline fake MEMORY-denied probe allowed HGETALL, while the 900 MiB measurement refused it. Probes are removed; received bytes determine the bound regardless of MEMORY permission. | `ace4bc4`; measured-path integration, fixed-reply routing and raw transport tests |
| L5 / `small-confirms`: catch-all proxy CIDRs | Fixed, Low | Production rejected `true` but accepted `0.0.0.0/0,::/0`. Now every `/0` CIDR form is refused, including expanded IPv6 and nonzero IPv4 prefixes with /0. Explicit hop counts remain deployment configuration. | `ace4bc4`; `unit/config` |
| `noperm`: key text in ACL-denial audit | Not reproduced on Redis 8.10.2; hardened | Actual denied-key error is generic, without the key. Defense-in-depth: future ACL error text is recorded only as `forbidden: NOPERM`; synthetic key-canary regression. | `ace4bc4`; `integration/replycap` audit |
| `dictdump`: whole dictionary | Part of H2; viewer protected by ACL | Viewer receives Redis NOPERM. Admin's 300,000-term, ~33 MiB dictionary gets 413 (172 ms); fixture dictionary verified empty afterwards. | `ace4bc4`; structural parser tests and live admin/viewer runs |
| `h1-sampling2` / `redis7`: memory sampling | Version observation, not a separate confirmed current finding | Current Redis 8.10.2 reports the huge stored member in MEMORY USAGE; range averaging still fails as shown by H2. Redis 7-specific behavior was not requalified: its 6445 script was adapted to permitted 6411. The fix does not depend on memory sampling or a Redis version's estimate. | Generic RESP parser/transport tests; live scripts |
| `matrix`, `matrix2`, `tiers`, `acl`, `smoke`, `ver`, `dbg`, `leftovers` | No new defect | 126 restricted-route requests, nine workbench checks, twelve effective-ACL identity checks, and prod SET → 428 typed name + reason. Deliberately permitted writes removed. OIDC smoke/metadata checks succeed. | Existing policy-matrix/auth tests; live scripts |

`everyday.mjs` exercised 45 forms on snapshot: normal reads issue one Redis command rather than sizing probes.
Existing Redis ACL denials (e.g. MEMORY STATS/TIME/dictionary for viewer), OBJECT FREQ configuration errors, LCS's
Redis transient-memory error and the existing SORT_RO command-policy refusal remain distinguishable from successful
reads. They are not claimed as new transport regressions or silently reported as successful data reads.

## Latency: fixed command set

Node 24.14.1, Redis 8.10.2, 512 MiB heap in both baseline/fixed processes. Real string/hash/zset keys on 6412;
small fixtures for the other types. Same command descriptors and reset
fixture contents before each run. Fifteen warmups, then fifty HTTP requests per command, 55 ms spacing; all 715
requests per process returned 200 with the expected reply type. Units are milliseconds. Shared-machine timing
noise remains; no claim is made that every tiny delta is a speedup.

| Command | Before p50 | Before p95 | After p50 | After p95 |
|---|---:|---:|---:|---:|
| GET | 3.20 | 3.99 | 3.30 | 4.00 |
| HGETALL | 3.93 | 4.59 | 3.64 | 4.40 |
| JSON.GET | 4.06 | 5.94 | 3.02 | 4.20 |
| JSON.GET wildcard | 3.77 | 4.66 | 3.06 | 3.69 |
| FT.SEARCH | 5.35 | 5.92 | 3.70 | 4.55 |
| FT.AGGREGATE | 3.90 | 5.09 | 3.12 | 4.24 |
| ZRANGE | 3.58 | 4.75 | 3.10 | 3.75 |
| XRANGE | 4.21 | 5.03 | 3.13 | 3.98 |
| LRANGE | 3.52 | 4.35 | 2.67 | 3.23 |
| SCAN | 3.20 | 3.82 | 3.32 | 3.88 |
| SLOWLOG | 2.63 | 4.20 | 2.89 | 3.39 |

GET/SCAN p95 changed by +0.01/+0.06 ms; SLOWLOG p50 changed by +0.26 ms while its p95 improved. These sub-millisecond
variations are reported as effectively flat, not hidden. Every other command improved at both percentiles.

## RSS and large-reply qualification

- During the 40 MiB element/range/key-name scenarios, sampled RSS stayed around 391–392 MiB in a process that had
  initialized pools for eight configured database aliases. H2-unsized rose 0.3 MiB, the 120 MiB LRANGE 0.0 MiB,
  long-key cases 0.2 MiB, typed stream 0.1 MiB (25 ms outer sampler; scripts additionally sample at 2/5 ms).
  The core H2 commands returned 413 in 8–10 ms; typed stream in 12 ms. A later RANDOMKEY rerun selected the giant
  key and returned 413 in 13 ms; long-key SCAN returned 413 in 33 ms. Initialization/cache RSS is not attributed
  to oversized reply buffering; the process later fell to 194.5 MiB after collection.
- A separate production-heap run read a 10 MiB first element of a 20 MiB MGET, then rejected the aggregate.
  Eight repeated commands each returned 413 in 7–9 ms. RSS 150.0 → peak 195.4 MiB, **+45.4 MiB**, including allocator
  retention across commands. No full 20 MiB reply reached the application. Raw payload allocation and mid-bulk cap
  boundaries are additionally checked deterministically in parser/socket tests; RSS sampling alone is not a proof.
- All large values stayed on 6411 and were removed. The four small benchmark keys and its index on 6412 were
  removed. Cleanup iterates the full SCAN cursor. Remote-6390 was only read through the app; no connection to 6380,
  no port-4000 action, and no access to the owner's `redis-console/data`.

## Validation

- `pnpm -r typecheck`: passed across all workspace projects after the release merge.
- Merged web unit suite: **202 passed**, 18 files.
- Server with cluster/sentinel/mTLS topology: **675 passed, zero skipped**, 47 files (includes all 16 topology/TLS tests).
- Parser/socket tests: 43 + 7 = 50, included in the server total; r3 integration: 19 scenario tests.
- Focused operator stream E2E plus setup: **3 passed**. The first full run exposed a too-strict two-read guard
  (471 passed, one failed); `7851bfa` separates the two-scan limit from the four-read limit and adds a concurrency
  regression. The complete full run after merging `7a47aa0` passed under the machine-wide lock, including its truthful cancellation-summary tests.
- Full `pnpm test:e2e`: **479 passed, zero failed** (13.2 min), on the merged tree under `/tmp/rconsole-e2e.lock`.
- The topology uses only 6420–6428 and is removed by an EXIT trap. E2E uses its own 6431 container and 6430 read-only
  proxy, explicitly approved by the task owner, under `/tmp/rconsole-e2e.lock`. Only own processes are stopped by PID. Own API PID 90587 was stopped after final cleanup; both fixture prefixes were verified absent.

Machine-readable measurements: [v02-replycap-evidence.json](v02-replycap-evidence.json). Reproduction/adaptation
instructions: [replycap-qa](../../apps/server/scripts/replycap-qa/README.md). Contract changes:
[CONTRACT-CHANGES.md](../CONTRACT-CHANGES.md). Full transient logs remain in `/tmp/rc-replycap-*.log` (final merged suites: `server-merged`, `typecheck-merged`, `web-merged`, `e2e-merged`).
