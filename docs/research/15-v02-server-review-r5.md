# Redis Console v0.2 — server review, round 5 (independent)

Snapshot: `release/v0.2` @ `2744f73` (read-only worktree `redis-console-wt/review-s5`). Live instance on :4500
(pnpm wrapper PID 24016 / node PID 24099), data dir `/tmp/rc-review-s5`, dev config, QA accounts from
`scripts/qa-accounts.mjs`. Scripts in `/tmp/rc-review-s5-tests/` (`lib.mjs` caches sessions so the sign-in limit is
not hit). Every finding below has a live reproduction unless marked otherwise.

Status: complete. **1 High, 1 Medium, 2 Low.** The High and the Medium are both in the new request-slot hook
(`app.ts:239-264`). The rest of the round 4 work (gates, stream budget, per-reply caps, abort-aware handshakes, event
truncation, redirect policy) checked out as sound, live and in code.

Tested with: Node 24.14.1, Redis 8 sandbox (6411/6412), the own 6420–6428 topology (cluster, sentinel, mTLS) plus a
temporary replica on 6429 for a sentinel failover. Extra database aliases `ro-e2e` (readOnly), `maxv-e2e`
(maxRole viewer) and `prod-e2e` (environment prod) all point at 6411 (`/tmp/rc-review-s5-tests/rconsole.s5.json`).

## Findings

### H1: request slots are held by the client's connection, not by the work; two accounts can stall every database route indefinitely

- **Where:** `apps/server/src/app.ts:244-264`. The request-slot hook runs in `onRequest` and releases on `reply.raw`
  `close`. Also `app.ts:115-116`: `requestTimeout: 0`, `connectionTimeout: 0`, so no server timeout ends a slow
  request.
- **Mechanism:** the per-user slot (max/2 = 8) and the global slot (16) are taken before Fastify reads the body, and
  given back only when the response stream closes. Either end of the connection can be slowed down to stretch that
  without limit:
  1. **Stalled body:** send the headers of a `POST /api/v1/databases/:db/…` with `Content-Length: 20`, then never
     send the body. `headersTimeout` does not apply because the headers are complete, and no other timeout is set.
  2. **Slow reader:** request a response larger than the socket buffers and read it slowly, for example a few hundred
     bytes every 20 s. `close` fires only after the whole body has been written. No stored data is needed: CLI
     `COMMAND DOCS` is allowed for viewers and returns about 800 KB of JSON. This variant also works when a
     reverse proxy buffers request bodies. `deploy/k8s/ingress.yaml` sets `proxy-buffering: "off"`, so nginx sends
     the response at the client's pace. Not run through nginx here; a reader that trickles bytes stays within
     nginx's `send_timeout`.
- **Repro, all on :4500, ordinary sessions with Origin and CSRF headers:**
  - `slowbody.mjs qa-admin 70000`: qa-viewer and qa-operator each open 8 sockets with stalled bodies.
    ```
    viewer PING with 8 stalled bodies: 429 2006ms "You have too many database requests running (limit 8)"
    qa-admin /api/v1/databases/snapshot/cli:       429 2004ms "Too many database requests are running on this server (limit 16)"
    qa-admin /api/v1/databases/sandbox-main/overview: 429 2003ms (same)
    viewer PING after 70000ms still holding: 429
    viewer PING after releasing: 200 5ms
    ```
  - `slowread5.py 100`: two accounts each run 8 clients with a 4 KiB receive window on a 1 MB `GET` reply. Every
    client reads 512 bytes every 20 s.
    ```
    qa-admin PING before: 200 11ms
    qa-admin PING with 16 slow readers: 429 "Too many database requests are running on this server (limit 16)" 2004ms
    qa-admin PING after 100s of trickle reads: 429 (same) 2004ms
    qa-admin PING after closing: 200 4ms
    ```
  - `slowread6.py`: data-independent. 8 slow readers of CLI `COMMAND DOCS` as qa-viewer, then the same viewer's
    `PING` → 429 "limit 8" after 2028 ms.
  - `idle.mjs 130000`: after 130 s the server had closed **none** of 10 bare TCP connections, 10 with
    partial headers, 10 authenticated stalled bodies and 10 unauthenticated stalled bodies on
    `/api/v1/auth/login`. It closed only the unread responses that had been fully handed to the kernel
    (keep-alive timeout).
- **Observed vs expected:** the half-of-slots rule (round 4 L2(d)) and the FIFO queue behave as written. The gate
  accounting is exact; see "Checked and sound". But a slot measures how long the client stays connected, not
  how long the server works. Expected: a slot covers handler time and a bounded amount of output, and a client
  cannot hold one past a short body or write timeout.
- **Impact:** any two accounts, of any role, can deny CLI, key browser, overview, slowlog, ops and every other
  database route to all users. They need no Redis work, no special data, a few bytes of traffic and 16 sockets.
  One account alone halves server capacity. A client on a poor mobile link, or a large download, triggers the same
  thing by accident. This is the availability property round 4 M1/L2 set out to establish.
- **Minimal fix:**
  - Acquire the slots in `preHandler`, after the body has been read and validated.
  - Release them once the handler has produced its payload (`onSend`/`onResponse`), not at `close`. For a slow
    reader, `finish` is delayed just as much as `close`. The memory the slot protects is what the handler
    retains (round 4's cumulative-read rationale), not the bytes waiting in a socket buffer.
  - For slow readers, also bound the output a client may leave unread: destroy the socket when
    `res.writableLength` stays above N for T seconds, or use `res.setTimeout`.
  - Set finite server timeouts outside the SSE routes: `requestTimeout` (for example 30 s), `headersTimeout`, and a
    socket idle timeout. Keep the stream routes' long timeouts.
  - Regression tests: (max/2 + 1) stalled bodies, and the same number of slow readers of `COMMAND DOCS`. Then
    another user's `PING` must get 200.

### M1: any database route bypasses the request slots by adding `?x=/stream`

- **Where:** `apps/server/src/app.ts:245`:
  `if (!req.url.startsWith('/api/v1/databases/') || /\/(?:stream|workbench\/cancel)(?:\?|$)/.test(req.url)) return;`
  `req.url` includes the query string. A query value that ends in `/stream` matches, and the CLI, key and
  diagnostics handlers ignore unknown query parameters. The sensitive-query-parameter filter blocks only names such
  as `key`/`match`, so `x` passes.
- **Repro:** `slowbody.mjs`, with qa-viewer's 8 per-user slots held:
  ```
  POST /api/v1/databases/sandbox-e2e/cli            → 429 after 2006 ms ("limit 8")
  POST /api/v1/databases/sandbox-e2e/cli?x=/stream  → 200 in 3–4 ms
  ```
  `bypass.mjs`, with all 16 global slots held by two accounts' stalled bodies (a third account, qa-admin, on
  snapshot):
  ```
  POST cli / GET overview / POST keys/scan                     → 429 after ~2004 ms ("limit 16")
  POST cli?x=/stream / GET overview?x=/stream / keys/scan?x=…  → 200 in 2–33 ms
  same with ?/workbench/cancel                                 → 200 in 1–3 ms
  ```
- **Impact:** the per-user half rule and the global request cap (round 4 M1/L2(d)) become optional for any client
  that wants to skip them. Without them, per-user fairness rests only on the per-route limits: 4 CLI commands, 4
  data reads, 2 scans, 1 analysis and 1 workbench. Routes without such a limit are bounded only by the 100/s
  per-IP limit and the global measured-command budget, which has no per-user share. These are `overview`,
  `slowlog`, `clients`, `streams/*`, `search/*`, `timeseries/*`, `commands`, `bulk-delete` and `ops`. The
  documented bound on ordinary requests retained through serialization does not hold for bypassed requests. I did
  not build a scenario where bypassed requests alone starve other users' command slots (it needs slow Redis work).
  The bypass itself is confirmed.
- **Minimal fix:** decide on the routed path, not the raw URL. Use `req.routeOptions.url` (for example
  `'/api/v1/databases/:db/pubsub/stream'`), or better a route-level `config: { requestSlot: false }` on the three
  SSE routes and on `workbench/cancel`. Add a test with `?x=/stream`.

### L1: the production `trustProxy` catch-all guard rejects only values Fastify already refuses

- **Where:** `apps/server/src/config.ts:369`. Production rejects `trustProxy` strings that contain a `/0` entry.
- **Repro:** `proxy.mjs` builds Fastify 5 (`@fastify/proxy-addr` 5.1.2) with each value:
  ```
  "0.0.0.0/0,::/0"                      -> Fastify refuses: invalid range on address: 0.0.0.0/0
  "0.0.0.0/00"                          -> Fastify refuses: invalid range
  "0.0.0.0/1,128.0.0.0/1,::/1,8000::/1" -> req.ip = 203.0.113.77 (attacker's X-Forwarded-For); prod check rejects: false
  ```
  `proxy-addr` throws on any prefix ≤ 0, so a `/0` config never starts anyway, with or without the check. The real
  catch-all is two `/1` halves per family. It passes the guard, and every client then chooses its own `req.ip`. That
  defeats the per-IP sign-in limit and the audit IP, which are what the r3 L5 guard was meant to protect.
- **Impact:** low. Only a configuration mistake or a deliberate choice by the operator gets here, but the guard
  claims a protection it does not give.
- **Minimal fix:** compile the list with `proxy-addr` and refuse it when it trusts a sample of public addresses
  (e.g. `1.1.1.1`, `8.8.8.8`, `2001:4860::1`). Or refuse any IPv4 prefix shorter than /8 and any IPv6 prefix
  shorter than /16.

### L2: no header, body or idle timeouts; unauthenticated slowloris connections live forever

- **Where:** `apps/server/src/app.ts:115-117` (`requestTimeout: 0`, `connectionTimeout: 0`). Node does not enforce
  `headersTimeout` here either: partial-header connections stayed open for more than 130 s.
- **Repro:** `idle.mjs 130000`. Of 10 bare TCP connections, 10 with partial headers, and 10 unauthenticated
  `POST /api/v1/auth/login` with stalled bodies, **0** were closed by the server.
- **Impact:** an anonymous client can hold any number of sockets (file descriptors and per-socket memory) with no
  request at all. The per-IP limit counts requests, not connections. The documented deployments put a reverse proxy
  in front, which usually has its own client timeouts, so this is Low on its own. It is also the root of H1's
  stalled-body variant.
- **Minimal fix:** as in H1: finite `requestTimeout` and `headersTimeout` and a connection idle timeout for
  non-stream routes. Optionally set `server.maxConnections`.

## Checked and sound

Each item was read in code and, where marked *live*, exercised on :4500.

**Wait queue and gates (`security/gate.ts`, `app.ts`, `capped.ts`).** FIFO hand-off without barging: a release
passes the slot straight to the oldest waiter and leaves the active count unchanged. Bounded by time (min(2 s,
timeout)) and by queue length (4 × slots). Abort removes the waiter and its timer. The per-user `KeyedGates` map
drops idle gates. The acquisition order is always request slots → pool slot → global command budget. No path
acquires in the reverse order, so no deadlock. Every error path releases: per-user slot after a global-slot
failure (`app.ts:256-259`); pool slot after a global-budget failure (`capped.ts:214`); a client gone while
queued (`app.ts:262`). *Live* (`gateleak.mjs`): five rounds that mixed 6 waiters aborting while queued, a queued
429 timeout, normal completions and dropped connections. Afterwards capacity was exactly 8: the 9th request
waited, then took the slot as soon as one finished, and 8 parallel PINGs passed. No leak and no double release.
The half-of-slots cap works as designed (`slowbody.mjs`: viewer limited at 8). Its problems are only H1/M1. SSE
and stream routes take no request slots or command slots: dedicated sockets use the separate `maxStreams`
budget through `take()` (never queued), and SSE has per-user and per-class server caps. The global SSE and
dedicated-socket budgets are both 64, so live SSE cannot leave dedicated sockets unaccounted for.

**Measured transport.** The RESP reader refuses trailing bytes after a complete command reply
(`resp.ts:78`): nothing can poison the next borrower. Event mode caps retained bytes, not wire bytes, as
documented. Socket state after every outcome:
- complete reply or complete error reply (MOVED/ASK included) → back to the idle pool;
- timeout, abort, overflow, push on a command socket, or a handshake failure → destroyed, never pooled;
- a budget exhausted before the write → dropped (safe).
`#all` never exceeds `poolSize`: each in-flight command holds at most one socket, and ASK returns the first socket
before taking the second. Idle sockets retire after 30 s and are removed from the pool on a remote close.
Connection-state commands that could leak between users of a pooled socket are blocked by policy: SELECT, MULTI,
WATCH, CLIENT * (fail-closed subcommands), RESET, HELLO, AUTH, READONLY/READWRITE/ASKING (no readonly/write flag).
*Live, per-tier identity* (`whoami.mjs`): `CLIENT INFO` shows `rconsole-{viewer,operator,admin}-capped` per effective
role on sandbox-e2e, ro-e2e and snapshot. maxRole=viewer forces `rconsole-viewer-capped` for operator and admin.
remote-6390 is capped to viewer (reads only).
*Live, cluster* (`cluster.mjs`): 30/30 SET/GET across slots. An empty slot was resharded to another primary, then
10 GETs → 10 × 200; capped sockets per node stayed 1/1/1 before and after (the redirected-from socket was reused,
no reconnect storm). Moving the slot back also worked. The repo's topology, r4 and capped tests (35) pass against
this topology. *Live, sentinel* (`sentinel.mjs`): each tier authenticates as its own ACL user. During
`SENTINEL FAILOVER` (6426 → 6429), writes gave 19 × 200 and one 503 in the switch window. The final value landed
on the new master. Old-master sockets idle out and are never reused for the new endpoint.

**Streams.** *Live* (`pubsub.mjs`): a 2 MiB `PUBLISH` arrived as a 64 KiB preview with `truncated` and
`totalBytes: 2097152`, and the next message followed on the same stream. In code: abort-aware handshakes for
pub/sub and profiler, `openSse` immediate close for a departed client, the stream-budget release on socket
`close`, and the metrics stream re-looking up the Conn on every tick.

**Authorization × role × database flags.** *Live* (`matrix.mjs`, `wbcheck.mjs`, `admin.mjs`): 18 write paths
(CLI SET/DEL/PUBLISH/FLUSHDB/CF.COMPACT/COPY DB/FT.CURSOR DEL/MEMORY PURGE/LATENCY RESET/XGROUP CREATECONSUMER,
workbench, ops ×3, bulk-delete, publish, slowlog reset, client kill) × 3 roles × {plain, readOnly, maxRole viewer,
prod}. Every result was as expected:
- viewer: 403 forbidden;
- readOnly: 403 read_only (including admin-class commands);
- maxRole viewer: 403 forbidden for every role;
- prod: 428 typed + reason (FLUSHDB blocked as nonProdOnly);
- COPY … DB and XGROUP CREATECONSUMER: blocked.

Workbench lines on readOnly/maxRole databases fail per line and the key was verified absent. CLIENT LIST stays
admin-only and works on readOnly (ADMIN_READS). The profiler needs admin and is refused under maxRole viewer.
Admin routes give 401 to anonymous users, 403 to viewer and operator, and 200 to admin.

**Sessions and `X-RC-Background`.** The header only *skips* `sessions.touch`. Idle and absolute expiry are still
checked on every request (`sessions.get`), and SSE heartbeats check `alive()` every 5 s. Marking a user-initiated
request as background can only shorten one's own session, so it cannot be used to dodge expiry. A client that
keeps polling without the header can keep a session alive until the absolute TTL. That was already possible and
is not a regression: idle expiry is a client-cooperative protection, and the absolute TTL is the server-side
bound. The web SSE client sends the header too (`apps/web/src/lib/sse.ts:28`), so an open metrics view does not
keep a session alive.

**Confirmations.** Single-use tokens bound to the session hash and to a canonical hash of route + database + body;
the spec issued with the token governs (it cannot be weakened on resubmission); typed name and reason for prod.

**Audit and log redaction.** *Live*: 366 audit lines and 7,080 log lines from this session. They contain no key
names, values, cookies or CSRF tokens. Keys appear as `key#<sha prefix>` and values as `<n bytes>`. 429s from the
request gate are not audited (consistent with other rate limits).

**Production config checks.** `secureCookies`, https `publicUrl`, no insecure OIDC issuer, TLS verification, TLS and
per-tier users for prod databases (with explicit `acceptRisks`), and https extra origins. The only gap is L1.

**Event loop.** `sanitizeRedisError` regexes on adversarial 2,000-character Redis error text: at most 4.4 ms per
call (`regex.mjs`). The MONITOR parser and the tokenizers are linear. Display trees are capped at 10k elements.

**Not covered:** a run through an actual nginx/ALB in front (H1's slow-reader variant is argued from
`proxy-buffering: off`, not measured through a proxy); OIDC flows (unchanged since round 4, not re-reviewed); a
pool-slot saturation repro with several operator accounts (round 4 M1 tests pass; the code was reviewed).


## Cleanup

- `rc-s5:*` keys on 6411 (including the 1 MB `rc-s5:big`) were deleted, and 0 remain on 6411 and 6412. Nothing was
  written to remote-6390, which was only read through the app (ACL WHOAMI, CLIENT INFO). There was no connection to
  6380, and port 4000 and the owner's `data/` were not touched.
- The own :4500 server was stopped by PID (24016/24099, 43941, 95892). The topology (6420–6428) was removed with
  `topology.sh down`, and the temporary replica `rcsrv-s5-replica` (6429) with `docker rm -f`. The worktree was
  removed. Scripts remain in `/tmp/rc-review-s5-tests/`; cached session cookies and the topology password were
  deleted. E2E was not run, so the lock was not taken.
