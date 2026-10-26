# Redis Console v0.2 — focused N1 verification

Reviewed 2026-10-24, supplied read-only worktree `review-n1`, commit **`fe01d0f2e3ad3ab513e67f261e1fe34bff18ebdf`**. No source edits or commits.

**Verdict: the original CLI, Workbench and publish reproductions are fixed. N1's strict revoke-before-bytes guarantee remains incomplete for node-redis scalar writes: a narrower, deterministically reproduced race is described below.**

## 1. Original reproductions

Reran both original scripts with only checkout/evidence paths adapted. Evidence and runnable scripts: `/tmp/rc-review-n1-evidence/`.

| Probe | Observed after revocation | Redis / delivery |
|---|---|---|
| `pool-revocation.mjs`: CLI SET behind four real operator BLPOPs | Pending before revocation; admin PATCH 200; fresh actor request 401; queued SET **401 unauthenticated** | Original `opened` survives |
| Same pool: Workbench SET | HTTP 200 with **unauthenticated line error** | `opened` survives |
| Same pool: checked string.set control | **401** | `opened` survives |
| `late-revocation.mjs`: held real connection acquisition, CLI | **401** | `opened` survives |
| Same barrier: Workbench table/execution windows | **unauthenticated line error** in both | `opened` survives |
| Same barrier: publish with real subscriber | **401** | **No message received** |
| Same barrier: unchecked/checked ops, confirmed bulk delete, admin creation | **401** | No edit/delete/account creation |

The original pool script's client-count filter also counts idle sockets whose last command was BLPOP (it printed five). The executed N1 integration tests use the actual blocked-client flag and verify **exactly four blocked sockets**, a two-line Workbench stopping before its second write, subsequent pool recovery, and two real TCP-relay publish-handshake windows. All passed. The original pool script still observed the pending requests and unchanged data; its printed count alone is not evidence of five blocked clients.

## 2. New reproduced residual — Medium: scalar write check precedes node-redis's deferred socket flush

**Locations:**

- `apps/server/src/redis/manager.ts:122–123`: `guarded` checks the actor, then queues `sendCommand`.
- `apps/server/src/redis/manager.ts:213–219`: fixed-reply standalone writes use that path, including EXPIRE and HSET.
- `apps/server/src/routes/keys.ts:497`: unchecked typed ops dispatch through it.
- Installed `@redis/client` 5.12.1, `dist/lib/client/index.js:847–854`: `#scheduleWrite` performs the socket write in **setImmediate**, after the check's synchronous turn.

**Reproduction:** `/tmp/rc-review-n1-evidence/enqueue-race.mjs`; results `enqueue-race-repeat1.json` and `enqueue-race-repeat2.json`. Both final runs reproduced both writes.

1. Build the real application with only sandbox-e2e/6411 and disposable local accounts. Warm the operator scalar pool so there is no connection delay.
2. Start a real HTTP admin PATCH `{disabled:true}` for the operator. A test-only `preHandler` barrier holds this concurrent admin request immediately before its handler.
3. POST an ordinary typed `key.expire`, or unchecked `hash.set`, over real HTTP. Wrap the request's real `stillAllowed` predicate only to record its actual result and schedule release of the admin barrier in a microtask. Return the original result unchanged. No Redis send is held or delayed by the harness.
4. The real predicate returns **true**. The manager queues the scalar command. Before node-redis's setImmediate flush, the released public admin handler disables the user, revokes sessions and finishes its **200** server response.
5. Observe the real outbound `net.Socket.write` to **6411**, forwarding it unchanged: the account is already disabled. The typed request nevertheless returns **200**; EXPIRE sets TTL to **100**, and HSET stores **`after-disabled`**. A fresh actor `/auth/me` returns **401**.

Recorded order for both typed writes:

```text
actor-check: true
revoke-server-response: 200
Redis socket-write: account disabled = true
revoke-client-response: 200
typed response: 200; data changed
```

**Control:** the same scheduling instrumentation around CLI HSET records the Redis write while the account is **still enabled**, followed by revocation. Its success is valid: the measured transport checks and writes synchronously. This distinguishes the scalar enqueue gap from a command already sent before revocation.

**Expected:** a command whose first Redis bytes have not been written must fail once the actor is revoked. **Observed:** the scalar path treats enqueueing as the authorization boundary, leaving the queued write with stale authority until the next event-loop turn.

**Impact and limits:** this is a substantially smaller window than the original pool/handshake issue. The deterministic test synchronizes a concurrent admin request; it does **not** establish an uninstrumented exploit frequency or a client-controlled long wait. The server finishes the revoke response before the Redis write; the review client's fetch receives that response afterward. EXPIRE and HSET are live reproductions. Other fixed-reply writes, including bulk UNLINK, share the same enqueue boundary by source inspection; they were not separately race-reproduced at this boundary. Cluster/Sentinel equivalents at `manager.ts:327`, `:338`, `:430` share this pattern but were not live topology-qualified here. This is not a failure of the original measured CLI/Workbench/publish fixes.

**Minimal fix:** send actor-guarded commands through the measured transport, including fixed-reply writes and per-primary dispatches (for example, select that path whenever `o.stillAllowed` is present). It already checks immediately before `socket.write`, after connection and admission waits. Alternatively add a genuine pre-flush authorization hook to the scalar queue. Another check immediately before `sendCommand` leaves this race. Add the microtask/admin-barrier regression above, requiring no mutation and a refusal, alongside the existing pool tests.

## 3. Write-path and readonly review

- **Central wiring:** `context.ts:118–130` attaches the predicate to scoped sends, every primary, dedicated streams and exclusive exchanges. `sessionStillValid` checks session liveness, enabled account, unchanged role and auth generation. No completely omitted application-data write callback was found; the residual is its timing on scalar dispatch.
- **Typed ops:** all plans are authorized as writes, and neither `execPlan` nor its cluster per-key delete split marks them readonly. Checked edits inherit the predicate on every WATCH/read/MULTI/queued command/EXEC and retain the explicit pre-MULTI check. Unchecked fixed-reply writes have the residual above.
- **Bulk delete:** retains batch checks; SCAN/UNLINK use scoped targets. The original held-connection probe refuses with zero deletions. Scalar UNLINK's later enqueue window is source-confirmed as shared, not independently reproduced.
- **Slowlog reset and client kill:** use scoped primaries and measured sends. Independent held-connection probes with real confirmations return **401**, each records one `auth.revoked`, and the intended victim client remains connected. Normal confirmed slowlog reset succeeds.
- **Admin routes:** these mutate SQLite, not Redis. Creation rechecks after password hashing; PATCH rechecks unconditionally before its synchronous changes (`admin.ts:47`, `:68`). Original late-creation probe and all four admin-race tests pass.
- **Other dispatches:** raw manager calls outside the scope are command-table/database-summary/metrics metadata reads. HELLO/AUTH/SELECT and ASKING are infrastructure/connection-state commands; target writes are separately guarded. Streams guard SUBSCRIBE/PSUBSCRIBE/MONITOR. No additional unguarded user-data write was found.
- **Readonly skip:** the marker comes from server code, not a client-selected send option. CLI/Workbench set it only for policy class `read`; fixed key, stream, time-series and analysis callers build read commands. Enumerated the live 6411 command table: **447 top-level commands, 218 read-class commands/subcommands, zero read classifications conflicting with `write` flags or `@write` metadata**. GETEX, GETDEL, GEORADIUS STORE, XREADGROUP, CF.COMPACT and FT.CURSOR DEL classify as writes; SORT STORE and EVAL_RO are blocked. Unknown subcommands fail closed. No logical-data mutation bypass via `readonly:true` was reproduced. Metadata agreement is supporting evidence, not a proof of every module's implementation or internal cache behavior.

## 4. Regression and qualification

- **38 tests passed, zero failed/skipped**, across `review-v02-n1` unit/integration, `checked-edits`, `workbench`, and `admin-races`. This covers eight checked-edit operation forms, conflicts, Workbench sequencing/revocation/cancellation, pool recovery, connection-handshake revocation, measured MOVED/ASK rechecks, exclusive exchanges and stream admission. The scalar test starts with `stillAllowed:false`; it does not cover revocation between enqueue and flush, which explains its passing result alongside the new reproduction.
- Server **typecheck passed**. `pnpm install` completed without tracked changes.
- Prescribed dev-config server on **4500**, `/tmp/rc-review-n1`, QA accounts provisioned: **18/18 live checks passed**. Normal CLI PING/SET/GET; checked string.set; scalar EXPIRE; key read/scan; four-line Workbench; publish delivered; confirmed slowlog reset; admin client list. Metrics, pub/sub and profiler SSE return 200, stay open beyond 12 seconds, each emit two heartbeats; pub/sub receives a subsequent message and profiler emits ready.
- Remote-6390: viewer PING, DBSIZE, ten-key scan and overview all return 200 **through the app only**.
- This was a focused backend check: no full-suite, browser/E2E, Docker or live cluster/Sentinel rerun. The fixer's broader results were not counted as this review's evidence.

## Evidence and cleanup

Sanitized scripts/results/logs are under `/tmp/rc-review-n1-evidence/`: `pool-revocation`, `late-revocation`, `extra-paths`, `enqueue-race`, `live-check`, `targeted-tests.log`, `typecheck.log`, `qa.log`. Scripts import the supplied checkout path; to rerun after cleanup, recreate this commit there and install dependencies. QA credentials are not copied into the evidence.

Cleanup verified: all six retained evidence prefixes have **zero remaining keys** on 6411 (`cleanup.json`); the probe scripts also removed their fixtures in `finally`. Stopped only this review's server **PID 23281**; its pnpm parent **23258** exited. Neither PID remains, and :4500 is no longer listening. Tracked worktree status was clean before removal. The requested `git -C <repo> worktree remove --force ../redis-console-wt/review-n1` succeeded; its path is gone and the main worktree list no longer includes it. `/tmp/rc-review-n1` and sanitized evidence remain. Writes used **6411 only**. No connection to 6380, no use of 4400, and port 4000/main-checkout data were left alone.

**Release recommendation: DO NOT RELEASE under the stated revoke-before-dispatch requirement until the reproduced scalar enqueue race is closed; original CLI, Workbench and publish N1 probes now pass.**
