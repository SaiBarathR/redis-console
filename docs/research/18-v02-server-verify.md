# Redis Console v0.2 — targeted server fix verification

Reviewed **2026-10-24**, commit **`62a5c04fa0af68cb47eeef8ee6710236f6ff55e1`**, supplied read-only checkout `redis-console-wt/review-final2`.

**All four original reproductions now pass, but H2 is incomplete across write paths: one High residual authorization issue is reproduced below.** No source edits or commits were made.

## Original findings

| Finding | Verdict | Current evidence |
|---|---|---|
| H1 — concurrent body buffering can exhaust the process | **Fixed** | Original `upload-memory.mjs 24`, real application, default limits, 256 MiB V8 heap, 24 simultaneous valid 11,534,470-byte checked bodies: **22 × 429, 1 × 200, 1 × 409**, exit 0, no resets/OOM; sampled peak heap **67,480,072 bytes**, RSS **404,701,184 bytes**. Single-upload control: 200, exit 0. The new integration test also passed its one-user and three-user constrained-heap bursts. |
| H2 — authorization survives revocation during a paused upload | **Not fixed completely**; original upload cases fixed | Original operator disable/demotion cases: revocation 200, fresh request 401, delayed checked edit **401**, Redis retains `opened`. Disabled admin's delayed no-password PATCH: **401**, target remains viewer. Independent paused-body checks also reject every named write route. However, writes waiting inside the Redis pool can still execute after revocation: **N1** below. |
| M1 — checked-read type change returns 502 | **Fixed** | Original real-Redis mutations before `STRLEN`, before `GET`, and before `MULTI`: **409 conflict** in all three; HTTP read race also **409**, `reason: type`, current type `hash`; the other writer's `f=theirs` survives. New bounded-retry and non-WRONGTYPE error controls pass. |
| L1 — unsupported operations silently discard `expect` | **Fixed** | Original `key.expire` with mismatching expectation: **400 validation**, TTL stays **-1**. New integration cases cover stale and null expectations on expiry, persist, hash delete, set add and list push, and compatibility without `expect`. |

Evidence: `/tmp/rc-review-final2-evidence/{probes.json,upload-memory-control.json,upload-memory-24.json,server-tests.log}`. Scripts were copied from `r6-evidence/`, with checkout/evidence paths adapted; original files were unchanged.

## New reproduced issue

### N1 — High: queued CLI/Workbench writes and delayed publish retain revoked authority

**Locations at reviewed commit:**

- `apps/server/src/routes/cli.ts:88–103`: connection acquisition and command send have no late account/session check.
- `apps/server/src/routes/cli.ts:281`, `:296`: Workbench checks before `execute`, whose subsequent connection/pool waits can outlive that decision.
- `apps/server/src/redis/capped.ts:214–227`: pool/global admission and socket readiness await, then send without checking the actor again.
- `apps/server/src/routes/pubsub.ts:216–217`: publish awaits its connection and sends without re-checking.

**Primary reproduction — real HTTP and Redis, no timing wrappers or mocked authorization:** `pool-revocation.mjs`, results `pool-revocation.json`.

1. Build the actual application with the normal dev policy and only `sandbox-e2e`/6411 configured; use disposable local accounts and an in-memory application store. The Redis pool keeps its **default size of four**.
2. Create four operator accounts. From each, POST one CLI `BLPOP <unique-empty-fixture-key> 1.5`. This respects the one-blocking-command-per-user limit. Observe four real `rconsole-operator` sockets running `blpop` in Redis CLIENT LIST.
3. As the first operator, POST CLI `SET <unique-target-key> after-disabled`. It passes the HTTP work gate, then waits inside the full Redis pool. After 100 ms it is still pending.
4. A separate admin PATCHes that operator with `{disabled:true}`: **200**. The operator's fresh `/auth/me` returns **401**.
5. Release the four BLPOPs by pushing to their disposable fixture keys. Only then can the queued SET acquire its Redis socket.
6. Queued CLI request returns **200**, typed reply **OK**, and direct GET confirms **`after-disabled`**. Repeat using a one-line Workbench script: **200**, successful line, same stored bytes. Control using checked `string.set`: **401**, original `opened` survives.

**Additional publish reproduction:** `late-revocation.mjs` holds the return from a *real* `ctx.redis.conn` acquisition using a deterministic barrier, disables the actor through the public admin API, then releases the barrier. No Redis reply or authorization result is fabricated. Publish returns **200**, `receivers: 1`; a separate real subscriber receives `after-disabled`. The same barrier reproduces CLI and Workbench gaps; unchecked/checked ops reject, and confirmed bulk delete rejects with zero deletions. This publish case uses an instrumented connection delay; the pool reproduction above does not.

**Expected:** a write still waiting for a connection/socket must be refused if its actor was revoked before it is sent. Workbench should produce an unauthenticated line result; single routes should return 401. Already-sent commands are outside this claim.

**Impact:** an account whose revocation has completed can still issue a previously admitted write. The pool example's window is bounded by the existing short pool wait (up to 2 s), rather than the old client-controlled upload window. Arbitrary policy-permitted CLI/Workbench writes remain affected; publish has an additional connection-establishment window. This is a residual H2 gap, not evidence that the paused-body fix failed.

**Minimal fix:** carry a synchronous actor-validity predicate to the actual Redis dispatch boundary. Check it **after pool/global admission and socket connection, immediately before writing the command**, including the scalar transport used by publish, and retain the checked-edit pre-MULTI check. Check again on permitted redirect dispatches. Return/audit unauthenticated denials and release reservations on refusal. A check solely before `conn.send()` leaves its internal pool wait exposed. Add the real four-BLPOP regression above for CLI and Workbench and a connection-delay publish test.

## New paths and compatibility

- **Budget lifecycle:** `app.ts:290–310` reserves after early authentication and before parsing; chunked requests reserve the route limit, known lengths reserve their declared size. The idempotent release is attached to response `close`, with an already-closed check. The executed real-socket regression observes zero reserved bodies/bytes after success, malformed JSON, receive timeout and disconnect, plus immediate 413 for an over-limit length. Parsed requests waiting for work retain their reservations. **No stranded reservation was reproduced.** This is tested behavior plus source inspection, not proof of every possible shutdown interleaving.
- **Other users:** default per-user count is 32 of 256, and large-body share is 24 of 48 MiB; small bodies up to 64 KiB consume count only. Passing socket tests exercise per-user and aggregate saturation, chunked uploads and small requests while large-body capacity is full. Independently, CLI PING succeeded for viewer/operator/admin while 20 incomplete key-read bodies were held. **No cross-user starvation from the new body budget was reproduced at defaults.** Existing per-IP throttles and ordinary shared Redis contention still apply.
- **12 MiB upload:** on the prescribed **:4500** server, exactly **12,582,912 wire bytes**, paced over **19,033 ms**, returned **200** and stored **12,582,788 bytes**. Fixture removed.
- **SSE:** metrics, quiet pub/sub and profiler each returned **200**, remained open after **36 s**, and emitted **seven heartbeats** each. A later publish was received; profiler remained open. Evidence: `live-compat.json`.
- **Named write routes:** independent real-socket paused-body revocations returned **401** for unchecked ops, CLI, Workbench, publish, bulk delete, admin creation and admin PATCH; no fixture changed, no admin was created, and the PATCH target stayed viewer (`route-body-revocation.json`). Middleware rechecks run after body reception and after the HTTP work-slot wait; the new slot-wait regression passes. Admin creation rechecks after password hashing (`admin.ts:47`), and PATCH rechecks unconditionally (`:68`); existing hash-race tests pass. Bulk delete checks before each scan/delete batch. Checked ops additionally check before MULTI. **Later awaits are not uniformly protected: N1.** Diagnostic writes have the middleware checks, but were not independently race-qualified at their final Redis send.

## Previously correct areas — quick regression confirmation

- Original independent probes still pass all eight supported checked op forms: stale bytes **409**, matching bytes **200**. Eight simultaneous writer pairs each yield exactly one 200 and one 409.
- Exclusive-socket disposal: five distinct sockets for success, conflict, queue error, EXEC error and timeout; **none retained**. Ten more conflicts leave the connection count unchanged.
- Viewer, readOnly and maxRole=viewer checked writes remain **403**; prod requires **428**, then matching confirmed edit succeeds. Independent live matrix: **57 checks passed**, covering both write roles, validation, CLI reads, blocked WATCH/MULTI/EVAL/COPY DB, read-only app-mediated remote PING and stalled-body compatibility.
- Full server suite: **733 passed, 20 skipped, zero failed**, 55 files passed and one skipped. This includes auth/session/TOTP, admin hash races, ACL identity/transaction grants, confirmation binding, binary values, reply caps, redaction/audit, sensitive URL refusal, cancellation, deadlines and route exemptions. Server typecheck passed; dependency audit has **zero advisories**.
- The **20 cluster/Sentinel/mTLS topology tests were skipped** in this environment. No topology was provisioned because allowed Redis writes were restricted to 6411/6412. No browser/E2E or Docker rerun was performed for this targeted backend verification; the fixer's recorded results were not treated as this run's evidence.

## Setup, evidence and cleanup

`pnpm install` completed; `.env` was sourced without printing secrets. Started the prescribed config on :4500 using `/tmp/rc-review-final2`, and provisioned QA accounts successfully. Initial account provisioning exhausted the normal sign-in burst; live compatibility/matrix checks were rerun successfully after refill. The extra applications used ephemeral HTTP ports and in-memory SQLite, with only 6411 configured. Custom probes used random `rcsrv:s6:*` / `rcsrv:s6-memory:*` / `rcsrv:s6-live:*` fixtures and the original matrix script's `rc-review-s6:matrix:*` fixtures on **6411**. Existing integration fixtures also write to 6411. Remote 6390 was read through the app only; no connection to 6380, no use of 4400, and port 4000/main-checkout data were untouched. No containers were started or stopped.

Sanitized scripts/results and test logs remain under `/tmp/rc-review-final2-evidence/`; they import the removed checkout path, so recreate `62a5c04` there and install dependencies to rerun them. No account credentials are in these evidence results.

Cleanup verified: no `rcsrv:s6*` or `rc-review-s6:matrix:*` fixture keys remained on 6411. Stopped only this review's server **PID 13599**; disposable probe processes exited. Final tracked worktree status was clean. The requested `git -C <repo> worktree remove --force ../redis-console-wt/review-final2` succeeded; checkout is gone and :4500 is no longer listening. `/tmp/rc-review-final2` is retained with this review's local QA database; evidence/logs remain in `/tmp`.

**Release recommendation: DO NOT RELEASE until N1 closes the remaining revocation gap; H1, M1, L1 and the original paused-upload H2 reproductions are fixed.**
