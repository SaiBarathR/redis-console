# Redis Console v0.2 — N1 scalar-dispatch follow-up verification

Reviewed 2026-10-24, supplied read-only worktree `review-n1c`, detached at **`881c1818276a70659983d8afa6482c82843b1e21`** (`release/v0.2`). Scope: report 19, section 2, and the routing regressions requested. No source edits or commits.

**Verdict: PASS for this focused N1 follow-up. The deferred scalar-write race is closed for the live EXPIRE, HSET and bulk-delete UNLINK probes. No new issue was reproduced. Live cluster/Sentinel failover remains unqualified in this run.**

## 1. Race reproduction

Adapted the fixer's copy of the original `enqueue-race.mjs` to this checkout and evidence directory; extended the same trigger to a confirmed three-key bulk delete. Ran twice over real HTTP and Redis sockets against 6411. The wrapper preserves the actual actor predicate, schedules release of the held real admin PATCH in a microtask, and forwards every observed socket write unchanged. No Redis send is held.

All four cases in both runs — typed EXPIRE, unchecked HSET, bulk-delete UNLINK and CLI HSET control — record:

```text
actor-check: true
Redis socket-write: account disabled = false
revoke-server-response: 200
revoke-client-response: 200
fresh /auth/me: 401
```

The typed operations return 200: TTL becomes 100, HSET stores `after-disabled`, and bulk delete reports exactly three deletions with zero keys remaining. These successes are legitimate because bytes leave while the account is enabled; the original failing order (revocation before socket write) no longer occurs.

The complementary existing integration tests exercise revocation **before dispatch**, immediately or in a microtask after hand-off to `Conn.send`. All six EXPIRE/HSET/bulk-delete cases pass: HTTP 401, TTL remains -1, hash remains `opened`, all three bulk keys remain, fresh auth is 401, and one `auth.revoked` denial is recorded. Thus the successful original trigger is supported by genuine refusal tests, not treated alone as proof.

## 2. Source check: no actor-checked command uses node-redis's deferred queue

- `apps/server/src/redis/manager.ts:185`: `measured` selects the measured path whenever `stillAllowed !== undefined`, independently of fixed-size replies or `readonly`.
- The selector is used by standalone `send` (`:215`), cluster `send` (`:323`), cluster per-primary targets (`:339`) and Sentinel `send` (`:424`). These dominate all four application-source `sendCommand` sites; none receives an actor-checked command.
- `apps/server/src/context.ts:122` attaches the actual predicate to scoped writes and wraps primary targets; `:130` carries it into exclusive checked edits. Dedicated streams also carry it.
- `apps/server/src/redis/capped.ts:166` checks the actor after pool/budget/connection waits; `:175` invokes the socket writer synchronously. The writer corks, writes and uncorks in the same turn (`:133`). Redirected attempts and exclusive exchanges check again. There is no await, microtask or deferred node-redis queue between that check and command submission to the socket.
- Node-redis remains for fixed-size commands without actor checks, including server probes and internal read metadata. HELLO/AUTH/SELECT and ASKING are connection setup; the subsequent application command is separately guarded.

Cluster deletion source review: `keys.ts:492` limits workers to four; `:501` sorts by hash slot and assigns work through a shared cursor. Both typed split deletes (`:525`) and bulk deletes (`:574`) use it. Counts are added after awaits (`:579`); actor refusal is propagated (`:576`) and stops bulk deletion with 401. The source matches the intended bounded fan-out. No live cluster writes were attempted under the 6411-only rule.

## 3. Regression and latency

`pnpm install` completed; server typecheck passed. Focused tests: **49 passed, zero failed/skipped**, across `review-v02-n1` integration (12), `review-n1` unit (6), checked edits (8), Workbench (16), and capped transport (7). This includes reply parity for 36 fixed-size commands under three mappings, checked-edit conflicts, pool/handshake revocation, stream admission, MOVED/ASK rechecks, cancellation, and no retry after an ambiguous network failure or timeout. The latter is a local protocol-fixture test, not a Sentinel failover test.

Prescribed dev-config server on **4500**, isolated `/tmp/rc-review-n1c`, fresh QA accounts: **25/25 live checks passed**. Coverage: CLI PING/SET/GET; typed expire/persist/hash/set/list/zset/stream operations; expected list error; confirmed hash/key deletion; successful checked string/hash edits and stale-edit 409; key-browser scan with dbSize and hash read. Confirmed bulk deletion removed exactly **1,200 keys**, left none, and took **10.2 ms** including confirmation requests. Remote-6390 viewer PING/DBSIZE/scan/overview succeeded through the app only.

Paced real-HTTP latency, 10 warmups then 60 successful samples per operation (p50 / p95, ms): CLI PING **2.37 / 5.41**; EXPIRE **3.68 / 5.50**; PERSIST **2.49 / 3.96**; HSET **4.67 / 5.74**; string.set **2.30 / 4.64**; key read **4.94 / 7.77**; key scan **5.97 / 9.63**. Reasonable locally, with no failures. This is a current-build sanity check, not an independent A/B benchmark or cluster throughput qualification.

## 4. Sentinel behaviour

**Acceptable:** an in-flight write should fail rather than be automatically replayed onto a newly discovered master after an ambiguous failure. Sentinel dispatch captures the known master and uses the measured pool without a redirect policy (`manager.ts:425`); the pool retries only explicit permitted cluster redirects, never network failures (`capped.ts:239`). A later independent request can use the newly discovered master.

A closed connection produces `unavailable`/503 (`capped.ts:118`); the error reaches typed callers through `exec.ts:9`. A 503 is not proof the original write never executed: its reply may have been lost. Do not automatically retry a non-idempotent mutation. Also, “failover gives 503” is not universal: a Redis READONLY reply maps to 502 and a timeout to 504 (`exec.ts:11–19`). These are qualifications of the documented behaviour, not new reproduced defects. No actual Sentinel failover was performed; topology writes would exceed this run's allowed data port.

## Evidence and cleanup

Runnable adapted scripts, race results from both runs, live results, latency, tests, typecheck and cleanup evidence are retained under `/tmp/rc-review-n1c-evidence/`. The three script fixture prefixes have zero remaining keys; cleanup removed zero because script finalizers had already removed them. Integration tests also clean their unique fixtures. No full-suite, browser UI/E2E or live topology rerun is claimed.

Cleanup verified: stopped only this review's server **PID 62555**; its pnpm parent **62529** exited. Both PIDs are gone and port 4500 has no listener. Tracked status was clean before the requested `git -C <repo> worktree remove --force ../redis-console-wt/review-n1c`, which succeeded; the path is gone and worktree registration is removed. Review data and evidence remain under `/tmp`. Redis writes used **6411 only**; no connection to 6380, no direct connection or write to remote-6390, and ports 4000/4400 and `<repo>/data` were left alone.

**Release recommendation: RELEASE with respect to this N1 residual; no reproduced blocker remains in this focused check, with live cluster/Sentinel failover explicitly outside its qualification.**
