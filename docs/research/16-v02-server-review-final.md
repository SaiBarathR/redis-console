# Redis Console v0.2 — final backend release-readiness review

Reviewed 2026-10-23. Snapshot: **`b379a6b0e96317b38a238daccd67abcbd7bbbbf4`**, detached checkout `../redis-console-wt/review-s6`.

**Result: 2 High, 1 Medium, 1 Low reproduced findings.** The checked-write transaction prevents lost updates in the exercised cases, but request-body admission can exhaust the process, and authentication decisions survive a deliberately paused upload after the account has been revoked. The latter also permits a disabled administrator to promote another administrator.

## Scope, method and limits

- Read `AGENTS.md`, reports **07, 08, 11, 13, 15**, their verdicts in `docs/REVIEW-LOG.md`, and `docs/CONTRACT-CHANGES.md`, especially the Round 3 web/CAS design and Round 5 HTTP changes. Inspected the backend, shared schemas/policy and current regression tests. Prior findings were context, not assumed current failures.
- Ran the requested environment symlink and `pnpm install`. No tracked source edits or commits. Node **24.14.1**, Fastify **5.12.7**.
- Port **4500 was occupied at entry** by PID 20576. Left it running; started this review's server on **4600**, using the prescribed absolute config and `/tmp/rc-review-s6` data path. That data directory and QA accounts already existed; they are retained. Ran `scripts/qa-accounts.mjs http://localhost:4600` successfully. The additional adversarial reproductions use separate in-memory application databases and temporary directories, not the pre-existing instance's accounts.
- **Baseline:** `pnpm --filter @rconsole/server test`: **702 passed, 20 skipped, 0 failed**, 52 files passed and one skipped. Server typecheck passed. `pnpm audit --json`: **zero advisories**. Logs: `/tmp/rc-review-s6-tests.log`, `/tmp/rc-review-s6-audit.json`.
- All added Redis writes and cleanup used unique `rcsrv:s6*` fixture keys on **6411**. Existing tests used their own sandbox prefixes. No connection to 6380. Remote 6390 was only read through the app's existing tests; port 4000 and the main checkout's data directory were not used.
- **Topology limitation:** ports **6420–6428** and the named topology containers were already occupied at entry. Did not change, attach tests to, or remove someone else's topology. All **20 cluster/Sentinel/TLS tests skipped** because this run had no separately provisioned topology credentials. Cluster ownership changes, migration and Sentinel failover are therefore **not live-qualified by this review**. This is a coverage limitation, not a reproduced topology finding.
- No E2E suite was run; its lock was not acquired. This is a backend/API/socket review, not browser qualification.
- Standalone reproduction scripts and sanitized results are in **`/tmp/rc-review-s6-evidence/`**. They import the reviewed checkout; after the requested worktree removal, recreate that commit at the same path to rerun them. Source `.env` without printing it. No credentials are included in this report or the result files.

## High

### H1 — Work admission happens after unbounded concurrent body buffering and parsing; valid uploads can crash the process

**Locations:** `apps/server/src/app.ts:106` (12 MiB per-request body limit), `apps/server/src/app.ts:258` (work admission in `preHandler`), `apps/server/src/app.ts:265` (per-user admission after parsing). The ops rate limit at `apps/server/src/routes/keys.ts:382` is also after parsing.

**Reproduction:** `upload-memory.mjs`, `upload-memory-worker.mjs`; results `upload-memory-24-default.json`, `upload-memory-24-repeat.json`, `upload-memory-control.json` and the corresponding stderr files.

1. Run the real `buildApp` in a disposable Node process with `--max-old-space-size=256`, default `maxInflightCommands=16`, the normal HTTP/body deadlines, and only sandbox-e2e/6411 configured. Create one active operator session. No route or parser is replaced.
2. From that one session, concurrently POST **24** valid checked `string.set` bodies to `/api/v1/databases/sandbox-e2e/ops`. Each contains an **11 MiB value**, uses the **same unique fixture key**, and expects `{type:'none'}`. Every wire body is **11,534,470 bytes**, below the unchanged 12 MiB limit. The use of one key bounds stored Redis data; the parent removes it afterward.
3. The process aborts with **SIGABRT**, stderr **`FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`**, and **24 ECONNRESET responses**. Sampled RSS reaches **823,967,744 bytes**. Repeat: SIGABRT/OOM again, sampled RSS **777,879,552 bytes**, all 24 connections reset.
4. Control: **one identical upload** on the same 256 MiB heap returns **200**, exits normally, and has sampled peak RSS **256,393,216 bytes**.
5. Additional boundary check: lowering `maxInflightCommands` to **1** let this particular 24-request run survive, but sampled RSS still reached **653,344,768 bytes** before excess requests were refused. The work limit is not an ingress-memory bound.

Commands, after sourcing the checkout's `.env`:

```sh
node --disable-warning=ExperimentalWarning /tmp/rc-review-s6-evidence/upload-memory.mjs 1
node --disable-warning=ExperimentalWarning /tmp/rc-review-s6-evidence/upload-memory.mjs 24
```

**Observed vs expected:** both Fastify's body buffers and parsed JSON exist before the per-user/global work gates decide whether requests may proceed or wait. The finite queue bounds handlers, not incoming body bytes. Expected: accept a legitimate large import while refusing excess simultaneous ingress before its full payload is allocated.

**Impact:** one authenticated operator can terminate a realistically memory-constrained backend using individually valid uploads. The heap limit is explicit: this reproduces a crash at 256 MiB, **not a claim that 24 requests crash an unrestricted default-heap process**. The default process's precise exhaustion threshold was not tested. The 120-second receive deadline cannot protect against a fast local burst.

**Minimal fix:** retain work admission after parsing, but add a **separate bounded ingress budget before body consumption**: per-user and global concurrent body/byte limits, including chunked bodies, with prompt refusal on saturation. Release ingress reservations on success, parse failure, timeout and disconnect. Account for parsed requests waiting for work admission as well as raw buffers. Do not put stalled uploads back into the Redis work slots. Add a constrained-process regression using concurrent near-limit valid uploads, alongside the existing single-upload compatibility test.

### H2 — Revocation during a paused upload is bypassed; a disabled administrator can persist another administrator

**Locations:** `apps/server/src/app.ts:192` (session/role validation only before parsing), `apps/server/src/app.ts:258` (later admission has no session recheck), `apps/server/src/routes/keys.ts:380` / `:393` (checked edit uses the captured scope), `apps/server/src/routes/admin.ts:68` (PATCH revalidates its actor only when hashing a new password).

**Reproduction:** `probes.mjs`, entries `upload-revocation-disabled`, `upload-revocation-role`, `admin-upload-revocation` in `probes.json`. These use real HTTP requests and the public admin API. The only observation hook signals that headers passed authentication; it does not alter authorization, body parsing or handlers.

1. As operator A, start a valid checked `string.set` POST. Send its authenticated headers and all JSON bytes **except the final `}`**. The Redis key contains `opened`; the request expects its correct type and SHA-256.
2. As admin B, PATCH A with `{disabled:true}`. B gets **200**. A's fresh `/auth/me` returns **401**.
3. Finish the already-open body's last byte. The old request returns **200**, and direct Redis GET is **`written-after-revocation`**.
4. Repeat with B setting `{role:'viewer'}` instead: demotion **200**, fresh request **401**, delayed checked write **200** and the new bytes are stored.
5. Stronger administrative variant: as admin A, start PATCH `/api/v1/admin/users/<viewer-C-id>` with body `{"role":"admin"}`, holding its final byte. Admin B disables A and receives **200**; A's fresh `/admin/users` gets **401**. Finish A's PATCH: **200**, and C's persisted role is **admin**.

**Observed vs expected:** the session object captured before receiving the body remains usable after its SQLite session is destroyed and its account generation changes. A conditional Redis expectation protects data concurrency, not the actor's authority. Expected: reject the pending action with **401**, leaving both Redis data and C's role unchanged.

**Impact:** a revoked operator retains a controllable write window; a revoked administrator can leave a privileged account behind. This needs an initially authorized session, but no narrow scheduling race: the sender chooses when to finish the upload within the configured receive deadline. The previously fixed post-password-hash admin race does not cover a PATCH without `newPassword`.

**Minimal fix:** revalidate session liveness, account generation/restrictions and current role **after parsing and after work-slot waits**, before dispatch. Apply the actor check unconditionally to administrative PATCH mutations. Recheck before the checked transaction is committed when connection acquisition/transaction reads introduce further awaits. Preserve early authentication/CSRF rejection and audit the revocation denial. Add real-socket tests that revoke/demote while a body is incomplete, including the no-password admin PATCH.

## Medium

### M1 — A type change during the checked read returns 502 instead of the promised 409 conflict

**Locations:** `apps/server/src/redis/checked.ts:84`, `:105`, `:110`, `:181` and `:201`.

**Reproduction:** `probes.mjs`, `http-type-read-race` and `type-race-before-*` in `probes.json`.

1. Store string `opened` on a unique 6411 key. Send a checked string edit with its correct hash.
2. On the real exclusive WATCH socket, let `TYPE` return `string`. Immediately before the following `STRLEN`, have a **second real Redis connection** replace the key with hash `{f:'theirs'}`.
3. The HTTP edit returns **502**:

```json
{"error":{"code":"redis_error","message":"WRONGTYPE Operation against a key holding the wrong kind of value"}}
```

4. The same result occurs when the other writer changes the type just before GET. Changing it immediately before MULTI instead correctly produces **409 `conflict`**.
5. In all cases the other writer's hash survives unchanged. The affected socket is discarded.

The deterministic scheduling wrapper waits for the second client's actual write before forwarding the selected read; it does not fabricate a Redis response or an API error.

**Observed vs expected:** WATCH invalidates a later EXEC, but does not make TYPE plus subsequent reads a consistent snapshot. A WRONGTYPE during those reads escapes the retry/conflict path. Expected: a changed type produces a bounded retry and/or the normal **409 with current type**, so the editor can use its conflict UI.

**Impact:** ordinary concurrent type replacement is shown as an upstream failure, with no `error.conflict` recovery data, and is audited as an error rather than the documented denied conflict. **No lost update or unintended write was reproduced here.**

**Minimal fix:** handle read-phase WRONGTYPE as a possible concurrent change, reread state under WATCH with bounded retries, and produce `conflictOf` when the fresh type differs. Bound retries of unstable reads as well as nil EXECs. Keep genuine ACL/connection/command errors distinguishable; do not convert every Redis error into a conflict.

## Low

### L1 — Unsupported operations silently strip `expect` and execute unchecked instead of rejecting it

**Locations:** `packages/shared/src/api.ts:364` / `:382` (non-strict op schemas strip unknown fields), `apps/server/src/routes/keys.ts:170` (planChecked exits when parsed `expect` is absent).

**Reproduction:** `probes.mjs`, `unsupported-expect` in `probes.json`.

1. Store a unique string key with no expiry.
2. POST as operator:

```json
{
  "op":"key.expire",
  "key":{"enc":"utf8","data":"<fixture-key>"},
  "ttl":120,
  "expect":{"type":"hash","sha256":"<sha256-of-stale>"}
}
```

3. Response **200**, integer result **1**; Redis TTL becomes **120** despite the mismatching expectation.

**Observed vs expected:** the contract deliberately excludes TTL and element-removal operations from CAS; that exclusion is reasonable. It also says other operations **cannot carry** an expectation, and `planChecked` has a validation branch for unsupported operations. Schema stripping makes that branch unreachable for these requests. Expected: **400 validation**, not an accepted conditional-looking request with the condition ignored.

**Impact:** a stale or generic API client can believe an edit was conditional when it was not. This is a request-validation gap, **not a claim that TTL operations need a new CAS feature or that the current web UI sends this body**.

**Minimal fix:** reject a raw `expect` on unsupported op variants, or make the full per-operation request schemas strict while including their valid confirmation fields. Preserve compatibility for requests that omit `expect`; add unsupported-expect cases to the validation tests.

## Areas that look correct in the exercised scope

### Checked edits

- **All eight supported forms use their expectation:** `string.set`, `hash.set`, `list.set`, `zset.add`, `json.set`, `json.delete`, `key.rename`, `key.delete`. Independent real-HTTP tests got **409 for stale bytes and 200 for matching bytes** for every form, including confirmations for delete paths. Existing tests additionally cover absent fields, absent keys, binary values, list displacement, JSON array retargeting, invalid expectation shapes and TTL preservation.
- **Compare-and-write atomicity:** eight independent simultaneous HTTP writer pairs sharing one opening snapshot each produced exactly **one 200 and one 409**, with the winning bytes stored. Existing real-Redis race tests also force writes before MULTI: changed bytes conflict, rewriting equal bytes permits retry, and continuous WATCH invalidation stops after **three transactions**. No unconditional overwrite was reproduced on a supported checked path. M1 concerns conflict classification during reads, not successful commit atomicity.
- **Connection disposal:** independently captured exclusive Redis client IDs for success, conflict, queue error, error returned inside EXEC, and deadline expiry. **Five different IDs; none remained in CLIENT LIST afterward.** Ten further conflicts caused no retained-connection increase. `CappedPool.exclusive` drops the socket in `finally` and releases both capacity reservations in the outer `finally`.
- **Role ACLs and missing transactions:** existing checked-edit live test creates a disposable prefix-limited Redis user lacking `+@transaction`; the edit returns **403 with the grant hint**, original data remains, and unchecked operations still work. Actual tier-identity tests pass. Console users remain unable to issue WATCH/MULTI/EXEC directly.
- **Policy and confirmation:** independently verified checked writes are refused for viewer, readOnly and maxRole=viewer (**403**); prod first returns **428**, and a properly confirmed matching edit returns **200**. Existing confirmation tests verify exact-body binding, expectation changes invalidating the old challenge and single use. These admission-time controls do not close H2's revocation window.
- **Audit for valid supported requests:** passing live tests verify one normal checked-write event with `detail: checked`, denied conflicts with a data-free conflict message, hashed keys and no value canaries. Redis errors retain only their error code in audit/log paths. M1's read race is currently recorded as an error, as described above.
- **Cluster/Sentinel source assessment only:** key-slot primary selection, first-WATCH MOVED restart, known-primary redirect restrictions, ASK refusal, same-slot rename behavior and current Sentinel-master lookup are present. The exclusive socket is dropped on either attempt. **Live reshard/migration/failover behavior remains unverified here**; do not treat the historical 722-test result as this run's result.

### Request handling and quick regressions

- **Long-lived SSE:** on the real :4600 server, metrics, quiet pub/sub and profiler each returned **200**, stayed open beyond **36 seconds** (past the default 30-second socket idle interval), and each emitted **seven heartbeat comments**. A publish after that point was received; profiler remained alive. The existing shortened-idle compatibility test also passes. `live-compat.json` records the results.
- **Large legitimate upload:** a paced request of **exactly 12,582,912 wire bytes** took **19,046 ms** and returned **200**; the stored value was **12,582,788 bytes**. This crosses the 15-second header deadline without incorrectly limiting the completed-header body upload. The fixture was removed. H1 is about concurrent admission, not rejection of a single valid large upload.
- **Exact route exemptions:** current socket tests pass for the literal query values `?x=/stream`, `?/workbench/cancel`, encoded `/stream`, and no suffix. They all hit the ordinary global gate and receive **429** while it is full. The three exact SSE route patterns and Workbench cancellation remain exempt; query contents do not determine admission.
- **Slot lifetime/fairness:** passing real-socket tests demonstrate stalled bodies cannot occupy work slots, slow response readers cannot hold them after serialization, disconnect/handshake failures release capacity, and requests recover after saturation. Per-user request shares and bounded FIFO waits are exercised; a single account cannot hold every default work slot. These controls cover admitted work, not H1's pre-admission body memory.
- **Deadlines and proxy config:** bare sockets, incomplete/dripping headers/bodies, unread responses and keep-alive sockets close in the shortened-deadline tests. Config tests reject production catch-alls including split IPv4/IPv6 ranges and broad mapped-IPv4 ranges, while accepting explicit hop counts and permitted narrow ranges/aliases. Production HTTPS, TLS verification and reachable per-tier-credential risk checks pass.
- **Sign-in and role rules:** QA provisioning performed Keycloak SSO; separate real-HTTP local viewer/operator/admin sign-in, including admin TOTP, succeeded. Existing auth/session/TOTP, administrative gates, CLI class/role/readOnly/maxRole matrix, typed operations, module reads and diagnostic route tests pass. Fresh requests after revocation are correctly refused; delayed requests are H2.
- **Command/reply/redaction regressions:** the suite passes unknown/dangerous command refusal, transaction/script restrictions, binary argument handling, blocking command limits, Workbench cancellation/revocation, measured reply caps for search/JSON/collection reads, redacted Redis error logging, audit redaction and sensitive-data URL refusal. Large-reply caps act while receiving data. No new reply-amplification or credential-disclosure finding was reproduced by this review.

## Cleanup

Final verification: no `rcsrv:s6*` fixture keys remain on 6411. Review server PID 47088 was stopped by PID; the disposable memory-probe processes exited and their fixture keys were removed by the parent. The seven specifically identified extra-app/memory-probe data directories were empty and removed with `rmdir`. The requested `git worktree remove --force` completed for `review-s6`; its final tracked status was clean at b379a6b. Pre-existing :4500/PID 20576, topology containers and `/tmp/rc-review-s6` are intentionally retained. Evidence scripts/results remain under `/tmp/rc-review-s6-evidence/`. No containers were created by this review.

**Release recommendation: DO NOT RELEASE until H1 and H2 are fixed and regression-tested; fix the checked-read conflict path and reject unsupported expectations, then complete isolated cluster/Sentinel qualification.**
