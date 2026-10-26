# Redis Console v0.2 server review, round 4: measured transport (capped sockets)

Reviewer: Claude (Opus 5.5), independent of the author. Target: `release/v0.2` at `93a5720`, read-only checkout
`../redis-console-wt/review-s4`. Scope: `apps/server/src/redis/{resp,capped,manager}.ts` and their
callers (`routes/{cli,keys,modules,pubsub,databases,diagnostics}.ts`, `context.ts`, `app.ts`), against
`docs/qa/v02-replycap.md`.

Status: complete. All findings were reproduced live on :4600, on my own cluster/sentinel/mTLS topology (6420-6428, removed afterwards), or with in-process fakes. Repro scripts are in `/tmp/rc-review-s4-tests/`.

**Summary.** The RESP reader and the per-socket lifecycle are solid. I found no parser mis-framing, unbounded allocation, socket reuse in an unknown state, or cross-tier credential mix-up (see "Checked and correct"). The problems are in the *limits* around the transport, plus one routing gap:

| ID | Severity | Finding |
|---|---|---|
| H1 | High | 16 idle pub/sub streams (6 viewer accounts) make every capped command on **every** database return 429 for 15 min |
| M1 | Medium (regression) | No wait queue: ordinary concurrency gets 429 "pool is busy" (36/80 requests with two viewers inside their own limits) |
| M2 | Medium (regression) | Per-request cumulative budget covers SCAN loops: bulk delete of >~340k keys is impossible (413 at preview) |
| M3 | Medium (pre-existing leak, amplified) | Stream abandoned during the handshake lives 15 min, holding user and global slots |
| M4 | Medium (regression) | One command with a >64 KiB argument from any client kills the admin profiler |
| L1 | Low | MOVED/ASK followed to any host:port with tier credentials; slot map never refreshed (new connection per command after a reshard) |
| L2 | Low | Internal metadata reads use the configurable cap; node-redis paths unmeasured against hostile servers; indistinct 429/413 messages; global request slot has no per-user share |

## Findings

### H1 (High): 16 idle pub/sub streams lock every user out of every database for 15 minutes

**Where:** `apps/server/src/redis/capped.ts:215-221` (`CappedPool.dedicated` takes `this.#budget.acquire()` and releases it only when the socket closes). `apps/server/src/redis/manager.ts:398-400` (one `CommandBudget(maxInflightCommands = 16)` shared by every database and tier). `apps/server/src/http/sse.ts:7,25-29` (3 live streams per user). `apps/server/src/routes/pubsub.ts:26` (a pub/sub stream lives 15 min).

**Reproduction:** `/tmp/rc-review-s4-tests/t2-sse-starve.mjs`, run live on :4600 against `sandbox-e2e` with the default policy:
1. Six accounts (qa-viewer, qa-operator, qa-admin, qa-admin2, OIDC viewer1, OIDC operator1) each open 3 pub/sub SSE streams to an idle channel. That is the per-user maximum, and viewer is enough. 16 streams open; the 17th and 18th get 429 `Too many Redis commands are running`.
2. A seventh user (OIDC admin1) then gets:
   - `cli GET` → **429**, `cli PING` → **429**, `keys/scan` → **429**, `overview` → **429**.
   - `cli DBSIZE` / `GET` on a *different* database (`snapshot`) → **429**.
   - `GET /api/v1/databases` → every database (`sandbox-main`, `sandbox-e2e`, `snapshot`, `remote-6390`) shows `status: error`, "Too many Redis commands are running".
3. After the streams close, the same `GET` → 200 within 1.5 s.

**Observed vs expected:** Idle subscriptions hold the global measured-command budget, which every capped command needs. Once 16 are open, the console stops working for everyone on every database. Expected: a long-lived stream must not consume the short-command budget. At most it should affect its own user.

**Impact:** Six low-privilege accounts (viewers) can deny service to the whole deployment, admins included, for 15 minutes at a time, and renew it indefinitely. With a smaller `policy.maxInflightCommands`, fewer accounts are needed (`ceil(max/3)`). The streams use no Redis bandwidth, so rate limits never trigger. The data path itself stays bounded; the failure is availability only.

**Minimal fix:** Give dedicated streams their own budget, e.g. `new CommandBudget(maxStreams)` in `RedisManager`, passed separately to `CappedPool.dedicated`. Optionally add a global SSE cap. Short commands must never compete with sockets that live for 15 minutes. Add a regression: open `maxInflightCommands` streams, then assert that a CLI `GET` succeeds.

### M1 (Medium, regression): ordinary concurrency now fails with 429 "Redis command pool is busy"; the old wait queue is gone

**Where:** `apps/server/src/redis/capped.ts:177-182`. When all `db.poolSize` (default 4) sockets are busy, `CappedPool.send` throws `rate_limited` at once. Baseline `b9ea7e2` `manager.ts:154` used `createClientPool(..., { acquireTimeout: 5000 })`, a bounded wait queue, and node-redis pipelining. Cluster and sentinel also queued: cluster pipelined, sentinel used a FIFO `Semaphore`.

**Reproduction:** `/tmp/rc-review-s4-tests/t3-pool-burst.mjs`, live on :4600 / `sandbox-e2e`. Rounds are spaced 1.2 s apart to stay under the per-user rate limit.
- Two viewers (qa-viewer, OIDC viewer1) each send 4 concurrent `GET`, which is within the per-user CLI limit of 4. Over 10 rounds: **44 × 200, 36 × 429** `Redis command pool is busy; try again shortly.`
- One viewer sends `keys/scan` + 4 concurrent `PING`. Over 10 rounds: **40 × 200, 10 × 429**.

**Observed vs expected:** A single user acting within their own per-user limits can exhaust their tier's pool (per-user CLI limit 4 = default `poolSize` 4). Every other user of that (database, tier) then gets 429 for all capped work: CLI, key browser reads, overview `INFO`, metrics ticks and the database list. Expected: short commands wait briefly for a socket, as before. "No unbounded queue" does not require "no queue".

**Impact:** Multi-user deployments see intermittent 429s in normal use. Blocking commands make it worse: four users, each running one `BLPOP ... 5`, hold every viewer socket for 5 s. It also amplifies H1.

**Minimal fix:**
- Add a short, bounded FIFO wait per pool, e.g. at most `poolSize × 4` waiters and at most min(remaining deadline, 2 s), with abort removing the waiter.
- Or, at least, make the per-user CLI limit strictly smaller than `poolSize`, and reserve one socket for non-blocking commands.

### M2 (Medium, regression): bulk delete (and analysis) break on large keyspaces: the per-request cumulative reply budget covers whole SCAN loops

**Where:** `apps/server/src/context.ts:114-115` creates one `replyBudget = { remaining: maxReadReplyBytes }` per request. It is attached to every capped send in that request. `apps/server/src/routes/keys.ts:451-462` (`countMatches`, up to 1,000,000 keys / 5 s) and `:464-488` (`bulkDelete`, up to 1,000,000 keys / 60 s) loop `scanPage` through it. Same for `diagnostics.ts:analyze` (up to 100,000 sampled keys, so it breaks with long key names). `capped.ts:134` rejects once the budget is spent.

**Reproduction:** `/tmp/rc-review-s4-tests/t4-bulk.mjs`.
1. Create 450,000 keys `rc-r4:bulk:<32 digits>` (43-byte names, value `1`) on 6411.
2. As qa-operator, `POST /databases/sandbox-e2e/bulk-delete {"match":"rc-r4:bulk:*"}`.
3. Result: **413** after 404 ms, `{"code":"too_large","message":"reply exceeded 11699 bytes", ...}`. No confirmation token is issued, so the delete cannot run at all. The keys were removed afterwards with redis-cli (`rc-r4:*` count is 0).

**Observed vs expected:** About 16 MiB / (43 + 7 framing bytes) ≈ 340k keys is the most a bulk delete can now count. With 200-byte key names it is about 80k. Baseline counted up to 1M keys in 5 s and deleted them. The budget is meant to stop typed multi-reads from holding many replies at once. SCAN pages are consumed and dropped, so they do not need a cumulative cap.

**Impact:**
- Bulk delete, the bulk-impact preview and key analysis fail on exactly the large databases where they matter.
- The error message reports the leftover budget ("11699 bytes") instead of the configured cap, which misleads operators.

**Minimal fix:** Pass `capped: true`, or a fresh per-call budget, for SCAN loops whose replies are not retained: `scanPage` callers in `countMatches`, `bulkDelete` and `analyze`. Alternatively, give back the bytes of a page once it is consumed. Report `maxReadReplyBytes` in the 413 message, not the remaining budget.

### M3 (Medium; leak pre-exists, newly amplified): a stream abandoned during the Redis handshake stays open for 15 min and keeps its slots

**Where:** `apps/server/src/routes/pubsub.ts:130-143` (and the profiler route `:223-234`). The route awaits `scope.conn()` and `conn.dedicated()` (`capped.ts:215-221`, no abort signal) *before* `openSse` registers `req.raw.on('close')` (`http/sse.ts:87`). If the client has already gone, that listener never fires. Heartbeat writes to the destroyed response do not throw, so nothing closes the stream before `maxMs`. The window is unchanged from `b9ea7e2`. What is new is that each leaked stream now also holds a **global** `CommandBudget` slot (see H1).

**Reproduction:** `/tmp/rc-review-s4-tests/t8-sse-leak.mjs` with `/tmp/rc-review-s4-tests/slow-fake.mjs`. The fake Redis delays the HELLO of `-capped` sockets by 3 s; the scratch config adds database `slow-fake`.
1. qa-viewer creates 3 subscriptions on `slow-fake` and aborts each stream request after 300 ms.
2. 4.5 s later, opening a stream on the healthy `sandbox-e2e` → **429 "Too many open live streams (max 3)"**.
3. The server audited three `pubsub.start allowed`, with no `pubsub.stop`. The fake shows 3 dedicated sockets still open and subscribed.

**Observed vs expected:** The abandoned streams finish subscribing and live for the full 15 min, holding the user's 3 live-stream slots, 3 Redis sockets and 3 global command slots. Expected: a client that has gone away before the stream opens costs nothing once the handshake completes.

**Impact:**
- Real users on a remote or TLS database (handshake of tens to hundreds of ms) who navigate away during connect lose all stream slots for 15 min.
- An attacker no longer needs to hold connections open to reach H1. Firing and aborting stream requests is enough, with no ongoing cost to the attacker.
- The audit log shows streams as started for clients that never received them.

**Minimal fix:**
- Pass `req.redisSignal` into `dedicated()` and its `connect`.
- After the awaits, check `req.raw.destroyed || reply.raw.destroyed` (or the signal) before `openSse`, and destroy the client if so.
- In `openSse`, if the request is already closed, close at once rather than only registering a `'close'` listener.

### M4 (Medium, regression): any client command with a >64 KiB argument kills the admin profiler (MONITOR evasion)

**Where:** `apps/server/src/redis/resp.ts:82-84`, the 64 KiB ceiling for simple strings, applied in stream mode by `capped.ts:99-104,232-243`. Redis emits each MONITOR event as one simple-string line containing every argument in full (`sdscatrepr`). The route then shows only 64 chars per argument (`routes/pubsub.ts:41-84`), so the full line was never needed.

**Reproduction:** `/tmp/rc-review-s4-tests/t13-stream-caps.mjs`, live on :4600 / `sandbox-e2e` (6411):
1. qa-admin opens `/profiler/stream?seconds=10`.
2. From redis-cli (rc-operator, i.e. a client *outside* the console), run `SET rc-r4:mon-small v`, then `SET rc-r4:mon-big <70 KiB>`, then `SET rc-r4:mon-after v`.
3. Observed events: `ready`, …, `SET rc-r4:mon-small`, then `event: error {"code":"too_large","message":"Redis reply header exceeded the structural limit."}`, `event: end {"reason":"Redis stream closed"}`. `mon-after` is never shown.

**Observed vs expected:** One ordinary write with a large value terminates profiling. Expected: a large monitored command is shown truncated, as the parser already does, and profiling continues. Baseline node-redis had no line limit here.

**Impact:**
- The profiler is unusable on any database whose clients write values over ~64 KiB, which is common for cached blobs.
- Anyone who can send one command to the database can blind an admin who is watching the profiler, then act unobserved. Console users are still in the audit log; other clients are not.

**Minimal fix:** In stream mode, do not fail on long simple strings. Count every byte against the per-event cap (as now), but stop *retaining* bytes after N (e.g. 4 KiB) and mark the line truncated. Alternatively, allow simple strings up to the per-event `maxReadReplyBytes` for MONITOR sockets only. Keep the 64 KiB ceiling for command replies.

(For comparison, the pub/sub behaviour is as designed and verified: in the same test a 17 MiB `PUBLISH` closes the subscriber's stream with `too_large`, after a small message was delivered normally. Note that any publisher can end every subscriber's stream this way; this is worth a sentence in the user guide.)

### L1 (Low, defense in depth): cluster redirects are followed to any `host:port`, with credentials, and never refresh the slot map

**Where:** `apps/server/src/redis/capped.ts:24-29` (`redirect()` accepts any host). `:191-203`: the target gets a new `CommandSocket`, `HELLO 3 AUTH <tier user> <password>` (and the TLS client certificate, when configured), then the command is replayed. node-redis 5.12 (`cluster/index.js:240-270`) instead accepts ASK only for a known master (`getMasterByAddress`, after rediscovery) and treats MOVED as a signal to rediscover topology.

**Reproduction:**
- `/tmp/rc-review-s4-tests/t6-socket.mts` (pure function): `MOVED 1 169.254.169.254:80` and `MOVED 1 internal-admin.example.com:8080` are both accepted as redirect endpoints.
- `/tmp/rc-review-s4-tests/t7-redirect.mts`: node A replies `-MOVED 1 127.0.0.1:<B>`, where B is in no slot map. The pool connected to B, sent `HELLO`, then `INCR` executed there. ASK sends `HELLO ASKING INCR` to B. A second redirect is not followed, so there is no loop. The test used the passwordless `default` user, so no secret was transmitted.

**Observed vs expected:** The console follows redirects to endpoints that are not part of the cluster.
- A compromised or MITM'd cluster node (plaintext deployment) can make the console server connect to arbitrary internal `host:port`s and send RESP and credential bytes there. That is an SSRF pivot from the Redis network into the console's network.
- That node can also forward the tier credentials to a third host.

Separately, a legitimate MOVED never updates node-redis's slot map, and the redirected-from socket is dropped (`reusable` is false). After a reshard, every capped command for a moved slot costs a new TCP+HELLO to the old owner plus the redirect, until a node-redis command happens to hit MOVED. Confirmed live on the topology: slot 15381 (`rc-r4:a`) was migrated 6422 → 6421, then 2 × 10 viewer `GET rc-r4:a` were sent through the CLI (`t11-moved.mjs`). All were correct, but 6422's `total_connections_received` went 13 → 23 → 34: one new authenticated connection per command, with no recovery.

**Minimal fix:** Accept a redirect only if `endpoint` equals a current master in `cluster.masters` (after `await cluster.rediscover?.()`, or by triggering a node-redis command to refresh). Otherwise fail with `unavailable`. Return the redirected-from socket to the pool, since a MOVED reply leaves it in a clean state.

### L2 (Low): user-facing internal reads still use the configurable data cap; node-redis paths remain unmeasured against a hostile server

- `routes/cli.ts:331` (`COMMAND DOCS`, measured 449 KB on Redis 8.10.2 with modules) and `routes/databases.ts:82` (`INFO server modules`) use `policy.maxReadReplyBytes`. Its configured minimum is 1024 bytes (`config.ts:240`). A deployment that lowers the cap for safety (e.g. 256 KiB) silently loses console autocomplete (413), and with a very small cap every database shows `status: error` in the list. `COMMAND` itself already has a fixed 2 MiB cap (`commandTable.ts:43`). Fix: give these internal metadata reads the same fixed internal caps. Measured margins: `COMMAND` 156,253 bytes / 447 commands; `COMMAND DOCS` 448,985 bytes; both are under 100k values on 6411 and 6412 (`t12-command-size.mts`, `t12b-elements.mts`).
- `resp.ts:1` says "Never hands an unmeasured reply to node-redis". That holds for capped commands only. Against a hostile or MITM'd server, the node-redis paths are still unbounded: `fixedReply` commands (TYPE/TTL/MEMORY USAGE/DBSIZE… used by the key browser and analysis), the node-redis handshake, `CLUSTER SLOTS` discovery, and sentinel replies. Honest servers cannot produce large replies there, so this is a documentation and threat-model note rather than a user-reachable bug. State it in `docs/ARCHITECTURE.md`, or configure node-redis with a max-reply guard if one becomes available. Unconfirmed live (not needed: node-redis 5.12's decoder has no size limit).
- Every `CommandBudget`/pool 429 has the same text whether caused by the global budget, the per-tier pool or the per-request budget. The per-request message prints the *remaining* budget as if it were the cap (M2). Operators cannot tell which limit to raise.
- The new global `database-requests` slot (`app.ts:238-244`, also 16) has no per-user share. Routes without a per-user concurrency slot (bulk-delete previews of up to 5 s, rate-limited only to 1/s burst 3; overview; slowlog; clients) let two or three users hold it on a large keyspace. Unconfirmed live (needs a multi-million-key database); same fix family as H1: a per-user share of the global slot.

## Checked and correct

Each item was verified live on :4600 or with an in-process harness. Scripts are in `/tmp/rc-review-s4-tests/`.

**RESP parser (`resp.ts`)**
- (`t5-resp.mts`, `t5b-chunks.mts`) Correct for every RESP2/3 type: simple/blob/verbatim strings, simple and blob errors, integers (int64 bounds enforced; `:` above int64 is refused), big numbers, doubles (`inf`/`-inf`/`nan`/exponents), booleans, `_`/`$-1`/`*-1` nulls, arrays, maps, sets, pushes, attributes (top-level and nested; not exposed), and streamed `*?`/`%?` aggregates with `.`.
- The output was identical for every chunk size from 1 to the full length, plus 2,000 random split patterns.
- Hostile shapes all fail closed with the socket destroyed:
  - 600-digit headers, 70 KiB simple/error lines, `*10^11`, `%2^60`, `$999999999`, 33-deep nesting.
  - Odd streamed maps, `$?` streamed strings, stray `.`, bad bulk trailers, bare LF, CR inside a line, unknown prefixes, trailing bytes after a reply.
- No allocation depends on a declared aggregate length. Bulk allocation is bounded by the cumulative cap. The worst-case CPU for a hostile 16 MiB reply of simple strings is ~190 ms; a 16 MiB bulk takes 1.3 ms.
- Limits hold exactly: 99,999 values pass and 100,000 are refused; depth 31 passes and 33 is refused; byte caps trip at cap+1.
- Binary map keys survive: Buffer keys in `Map`, flat pairs for `PAIR_MAP_COMMANDS`, and RESP3 maps outside that list (e.g. streamed maps).

**Socket state (`capped.ts`, `t6-socket.mts`)**
- An error reply reuses the socket.
- These outcomes each destroy the socket, and the next command gets a fresh one: trailing bytes in the same chunk, data arriving on an idle socket, timeout, header over cap, cap trip mid-reply, unsolicited push, partial reply then timeout, server close, abort, HELLO/SELECT failure.
- Abort destroys only the aborted command's socket; a concurrent command on another socket completes.
- The `CommandBudget` is released on every failure path: after 10 concurrent failing commands, new commands run.
- Policy blocks every command that could leave a pooled socket in a changed state: SELECT, MULTI/EXEC/WATCH, HELLO, AUTH, RESET, QUIT, CLIENT REPLY/TRACKING/SETNAME, READONLY/READWRITE/ASKING (flag-classified as blocked), SUBSCRIBE*, MONITOR, WAIT.

**Credentials and isolation**
- `CLIENT INFO` through the CLI shows the right identity: `user=rc-viewer|rc-operator|rc-admin`, `name=rconsole-<tier>-capped`, `db=0`, `resp=3`. On `remote-6390` (maxRole viewer) every role is capped to viewer, read-only.
- Pools are per (database, tier) `Conn`, so sockets are never shared across tiers, databases or db indexes. SELECT runs for `db.db` ≠ 0, and SELECT itself is policy-blocked.
- Sentinel and mTLS capped sockets authenticate as the tier user (`t10-topo.mjs`). The mTLS node requires the client certificate, so the capped path presents it. The TLS options passed match `socketOpts` field by field: `rejectUnauthorized`, CA, cert, key, servername.
- ACL changes (`t14-acl.mjs`): `ACL SETUSER rc-viewer -get` applies at once to a pooled socket (NOPERM), and `+get` restores it. After a password rotation, the existing socket keeps working (normal Redis semantics) until its 30 s idle retirement. The new socket then fails `WRONGPASS` and is not pooled. Restoring the password recovers.

**Cluster and sentinel**
- Slot routing is correct for normal keys, `{tag}` keys and binary `{\xff\x00\x80}` tags (MGET in one slot works). Cross-slot MGET returns Redis CROSSSLOT.
- XREAD has no legacy key index; it is routed randomly and corrected by one MOVED.
- A second redirect is not followed. Only explicit MOVED/ASK are retried, never timeouts or network errors. ASKING and the command share one socket.
- Key-browser SCAN pagination returns 30/30 keys exactly once across 3 cluster primaries and on sentinel (`t15-scan-pages.mjs`).
- INFO/overview/key read work on cluster, sentinel and mTLS.

**Limits, cancellation, audit**
- Workbench cancel during `BLPOP ... 5` answers in 4 ms with `cancelled.inFlight: true`. Redis `blocked_clients` drops 1 → 0, the next line is not sent (`EXISTS` = 0), and the line is audited `error / unavailable (cancelled)`.
- CLI fetch abort mid-`BLPOP` unblocks Redis and releases the per-user blocking slot at once (`t9-identity-cancel.mjs`).
- 413s carry no data, and audit detail for cancellations and 413s carries codes and byte counts only. A grep of the server log for every test key, value, channel name and the large-integer canary found 0 hits.
- MONITOR output keeps Redis's `(redacted)` HELLO/AUTH arguments.

**Regressions that still work**
- Integer precision: `INCRBY` 9007199254740993 round-trips exactly.
- `OK` and other status replies, binary hash fields in HGETALL, HRANDFIELD WITHVALUES, `inf` scores.
- Blocking commands with capped timeouts: `BLPOP ... 1` returns nil after 1.06 s, and `0` is capped to 5 s.
- SCAN cursors, XREAD map replies, autocomplete (`/commands`, 665 entries).
- `COMMAND` is 156 KB / 447 commands, comfortably inside the fixed 2 MiB / 100k-value limits on Redis 8.10.2 with modules.
- Pub/sub: a 17 MiB message closes the subscriber's stream with `too_large` after earlier small messages are delivered (`t13-stream-caps.mjs`).
- The author's `resp`, `capped` and `hard-timeout` unit tests pass in this checkout (55/55).

## Not confirmed

- Sentinel failover was not exercised: the provided topology has one master and no replica. From the code: after node-redis learns the switch, capped sockets for the old master are no longer selected (they are keyed by endpoint). Until then, writes to the demoted master fail with READONLY rather than being replayed.
- L2's `database-requests` starvation through slow bulk-delete previews was not reproduced; it needs a multi-million-key database.
- Full `pnpm test:e2e` was not rerun; the author reports 479/479 under the lock. Only the server unit tests above were run.
