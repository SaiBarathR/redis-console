# Architecture

How Redis Console is built, and the guarantees each part keeps. Why it is built this way is in
[DECISIONS.md](DECISIONS.md); the threat model and how each control is tested are in [SECURITY.md](SECURITY.md);
configuration is in [OPERATIONS.md](OPERATIONS.md#2-configuration-reference).

- [1. Trust boundary](#1-trust-boundary)
- [2. Components](#2-components)
- [3. Request lifecycle](#3-request-lifecycle)
- [4. Policy engine](#4-policy-engine)
- [5. Redis connections: per-role ACL users and pools](#5-redis-connections-per-role-acl-users-and-pools)
- [6. Measured transport and reply caps](#6-measured-transport-and-reply-caps)
- [7. Availability guards](#7-availability-guards)
- [8. Jobs](#8-jobs)
- [9. Sessions and authentication](#9-sessions-and-authentication)
- [10. Audit and redaction](#10-audit-and-redaction)
- [11. Web app](#11-web-app)
- [12. Data-flow guarantees](#12-data-flow-guarantees)
- [13. Supply chain and deployment](#13-supply-chain-and-deployment)

## 1. Trust boundary

`apps/server` is the only component that holds secrets or talks to Redis. The browser is untrusted, and so is
everything Redis returns: key names and values can contain hostile content. The browser names a database by its
configured `id`; it can never choose a host, port, TLS setting, credential or logical database.

## 2. Components

```
Browser: React 19 SPA (strict CSP + Trusted Types, no secrets, Redis data in tab memory only)
   │  HTTPS, one origin. Cookie __Host-rc_session (HttpOnly, Secure, SameSite=Strict)
   │  + X-CSRF-Token and an exact Origin on every state-changing request. JSON bodies only.
   ▼
Reverse proxy (TLS termination, no buffering for Server-Sent Events)
   ▼
apps/server: Node 24 + Fastify 5, TypeScript run by Node's type stripping
   ├─ http hooks      security headers + CSP nonce, per-address limit, no-data-in-URL guard,
   │                  session/CSRF/role gate, request-body budget, request slots     (app.ts)
   ├─ auth            OIDC (openid-client: code + PKCE + state + nonce), local accounts
   │                  (argon2id, TOTP with encrypted seeds), sessions                (auth/, routes/auth.ts, store/)
   ├─ policy          classify → authorize → caps → confirmation preview            (policy/, packages/shared/commands.ts)
   ├─ routes          databases, keys, cli/workbench, diagnostics, search, pub/sub,
   │                  analysis, import, bulk delete, admin, health, static SPA        (routes/)
   ├─ redis manager   per (database, role tier): node-redis topology client + pools of
   │                  exclusive measured command sockets, each authenticated as that tier's ACL user  (redis/)
   ├─ store           node:sqlite: users, sessions, OIDC flows, append-only audit    (store/, audit.ts)
   └─ static          apps/web/dist, index.html with the per-request nonce           (routes/static.ts)
   ▼
Redis: standalone, Cluster or Sentinel; TLS in real deployments; one ACL user per role
       enforces the same limits a second time.
```

`packages/shared` is the contract both apps import: request and response types and zod schemas (`api.ts`), the
command rules (`commands.ts`), roles (`roles.ts`), binary-safe values (`bin.ts`, `Bin`), digests for
compare-and-set (`digest.ts`) and the search and analysis helpers (`insight.ts`). The web app uses the command rules
only to show hints; the server is the only enforcement point.

## 3. Request lifecycle

Every request passes these steps in order. A failure at any step ends the request with a JSON error
(`{ code, message, hint? }`) and, for denials on database routes, an audit event.

| # | Step | Where | What happens |
|---|---|---|---|
| 1 | Headers | `onRequest` | Fresh 18-byte CSP nonce; CSP, COOP, CORP, `nosniff`, `no-referrer`, `Permissions-Policy` (everything off), `X-Frame-Options: DENY`, HSTS when secure, `Cache-Control: no-store` on the API. An abort signal tracks the client connection. |
| 2 | Address limit | `onRequest` | 100 requests/s (burst 300) per client network (IPv6 per /64), using the address `trustProxy` allows. |
| 3 | No data in URLs | `onRequest` | Query parameters such as `k`, `key`, `match`, `pattern`, `channel`, `group`, `query` are refused with 400 on every path, so no route can accept Redis data in a URL. |
| 4 | Authentication and CSRF | `onRequest` | Session looked up by the SHA-256 of the cookie. Non-GET requests need `Origin` in the allowed set (`publicUrl` plus `extraAllowedOrigins`); authenticated ones also need the session's `X-CSRF-Token` (constant-time compare). Local accounts are re-read: disabled, changed role or auth generation → session destroyed, 401. Forced password change or TOTP enrollment → 403 except on the routes that do them. The route's minimum role is checked. |
| 5 | Body budget | `onRequest` | Before any body byte is read: a declared size over the route limit → 413; otherwise a slot in the per-user and server-wide body budgets (`maxBodiesInFlight`, `maxBodyBytesInFlight`) or an immediate 429. Held until the response is done. |
| 6 | Parse | Fastify | JSON only (`text/plain` parser removed, prototype poisoning refused), then strict zod schemas: unknown fields are errors. |
| 7 | Re-check after the body | `preValidation` | The client chose when to finish its body: session alive and account unchanged again, else 401 audited as `auth.revoked`. |
| 8 | Request slot | `preHandler` | Database routes take a per-user slot (half of `maxInflightCommands`) and a global one, waiting at most 2 s in a bounded FIFO, then 429 naming the limit. Streams and workbench cancel are exempt. Re-check after the wait. |
| 9 | Database scope | `dbScope` | Unknown id → 404. Effective role = min(user role, `maxRole`); below the route's minimum → 403. |
| 10 | Policy | `policy/` | Typed operations use fixed, server-built commands; the console and workbench classify user argv (section 4). Role, `readOnly`, prod-only rules, then caps on the argv. |
| 11 | Confirmation | `policy/confirm.ts` | When the action needs one: 428 with a server-built preview of the exact commands (and the impact for bulk deletes) and a single-use token bound to the session and a hash of route + database + body, valid 2 minutes. Typed confirmations need the database name; prod writes also need a reason. The retry carries the token. |
| 12 | Dispatch and actor re-check | `redis/manager.ts`, `redis/capped.ts` | Wait for a pool socket and a global command slot. **Right before the bytes are written**, in the same synchronous step, the actor is checked again (session alive, account unchanged). Refused → nothing is sent, 401, audited `auth.revoked`. Repeated on every MOVED/ASK re-dispatch. |
| 13 | Measured transport | `redis/resp.ts` | The reply is counted byte by byte before decoding and capped (section 6). Overflow, timeout or client disconnect destroys only that socket. |
| 14 | Shape the response | routes, `policy/redactReply.ts` | Display truncation (`maxReplyBytes`, 10k elements, value previews), binary-safe `Bin` encoding, network addresses hidden from non-admins. |
| 15 | Audit | `audit.ts` | One event per command or read: action, database, command name, redacted argv, key count, outcome, reason. |
| 16 | Release | `onSend` | Request slots are released once the payload is serialized, before Node writes it, so slow readers never hold work slots. |

## 4. Policy engine

Source: `packages/shared/src/commands.ts` (rules) and `apps/server/src/policy/` (enforcement).

**Classes.** `read` (viewer and up), `write` (operator and up, refused on `readOnly`), `admin` (admin only),
`dedicated` (only through its feature: SUBSCRIBE family → Pub/Sub page, MONITOR → profiler) and `blocked` (never).

**Classify** (`policy.ts` `classify`), for console, workbench and import lines:

1. The name must be printable ASCII; it is upper-cased ASCII-only (so `ſ` can't become `S`).
2. A static rule wins: `argumentRule` (argument-dependent, e.g. `FT.DROPINDEX … DD` is blocked) or `lookupRule`
   (command or command + subcommand). The rules block KEYS, Lua and Functions, MODULE, DEBUG, SHUTDOWN, replication,
   persistence control, FLUSHALL, SWAPDB, MOVE, SELECT, MIGRATE, RESTORE, AUTH, HELLO, MULTI/EXEC/WATCH, CLIENT
   SETNAME and similar; classify reviewed module commands (`FT._LIST`, `FT.INFO` as reads, `FT.DROPINDEX` as admin +
   typed); and attach confirmations (DEL, UNLINK, RENAME, LTRIM, XTRIM, ZREMRANGE* → `confirm`; FLUSHDB → admin,
   `typed`, never on prod).
3. Otherwise the database's own `COMMAND INFO` decides (`policy/commandTable.ts`): `admin` flag or `@admin`/`@dangerous`
   → blocked; `pubsub` → blocked (use the page); `write` → write; `readonly` **and** `@read` without `@write` → read.
   A command with unknown subcommands, an unknown command, or anything unclassifiable → **blocked** (fail closed).
   Blocking commands not in the reviewed list are blocked.

**Authorize** (`authorize`): class vs effective role; `nonProdOnly` rules on prod; `readOnly` refuses anything
mutating (admin reads such as `CONFIG GET`, `CLIENT LIST` stay allowed).

**Caps** (`applyCaps`): blocking timeouts at most 5 s (0 = "forever" becomes 5 s); `SCAN`-family `COUNT` at most
1000; at most 8 `*` wildcards in a glob (old Redis versions match them in exponential time); `COPY … DB` blocked (the
logical database is fixed by configuration).

**Typed operations** (key browser, inspector, guided forms, stream and search tools) never take raw argv. Each is a
zod-validated operation (`string.set`, `hash.set`, `key.rename`, `stream.group.create`, …) that the server turns into
fixed commands with a fixed class and confirmation level. Creates never overwrite (`SET … NX`, `RENAMENX`); edits that
replace data use compare-and-set (below).

**Confirmations** (`confirmationFor`): every mutating action on a prod database (with `prodRequiresReason`) → typed
database name + reason; otherwise the rule's level. The preview (`policy/preview.ts`) is built from the same argv that
will run: command and key names in full, other arguments as a short prefix and size, bounded to 64 KiB. Previews go to
the requesting user only, never to the audit log.

**Compare-and-set** (`redis/checked.ts`): operations that replace data (`string.set`, `hash.set`, `list.set`,
`zset.add`, `json.set`/`json.delete`, `key.rename`, `key.delete`, multi-entry adds) carry `expect`: the Redis type and
the SHA-256 of the bytes the client read. On one exclusive measured socket of the caller's tier the server runs
`WATCH`, `TYPE`, the element read, then `MULTI` / command / `EXEC`, at most 3 attempts, never Lua. A mismatch answers
409 `conflict` with the current value and writes nothing. Operations that can't carry an expectation refuse one (400).
In cluster mode the exchange stays on the key's primary. The operator ACL user therefore needs `+@transaction`; the
console still refuses user-typed MULTI/EXEC/WATCH.

## 5. Redis connections: per-role ACL users and pools

`redis/manager.ts` keeps, per **(database, tier)**, where the tier is the caller's effective role:

- a node-redis client for topology (cluster slot map, Sentinel master) and for a few fixed-size reads without an
  actor check;
- a `CappedPool` of exclusive measured sockets (`redis/capped.ts`), at most `poolSize` per tier, retired after 30 s
  idle. Each socket authenticates with `HELLO 3` (AUTH as the tier's user, SETNAME), `SELECT`s the configured logical
  database, uses the same TLS settings, and carries one command at a time;
- dedicated sockets for Pub/Sub and MONITOR, outside the pools, with their own budget (`maxStreams`).

Credentials: `credentials[tier]`, else `credentials.default`, else **503**. A role never borrows a higher or lower
tier's user, so Redis enforces each role's limits independently of the application. In production, prod databases
need a distinct user for every reachable tier.

Cluster: commands route by key slot through node-redis's primary slot map; keyless commands go to a random primary.
At most one MOVED/ASK retry, and only to a primary of the known topology (a disagreeing MOVED first refreshes the map);
anything else is refused (503), so a node can't point the server, and the tier's credentials, at another host.
Ambiguous failures are never replayed. Sentinel commands use the current master. Per-key cluster deletes run on four
workers in slot order.

## 6. Measured transport and reply caps

The server does not predict reply sizes; it measures them (`redis/resp.ts`). A streaming RESP2/RESP3 reader counts
wire bytes before decoding and enforces:

- `maxReadReplyBytes` per reply (16 MiB default) and, for typed reads whose results go into one response, the same
  amount cumulatively across that request's Redis calls;
- at most 100,000 values and depth 32 per reply; 64 KiB for simple strings and errors; 512 bytes for headers;
- fixed caps for server metadata the console reads itself (COMMAND 2 MiB, INFO and COMMAND DOCS 4 MiB), so a small
  data cap can't break the UI;
- for stream sockets: 64 KiB kept per string and 256 KiB per event (a larger Pub/Sub message or MONITOR line is
  delivered cut, with its full size, and the stream continues).

Overflow, timeout or abort **destroys that socket only**, returns 413 (naming the cap), 504 or nothing (client gone),
and releases the slots. What is displayed is then bounded again: `maxReplyBytes` and 10,000 elements for console
trees, value previews of 64 KiB (`maxValueBytes` with "Load full value").

Which path a command takes:

| Path | Used for |
|---|---|
| Measured socket, actor-checked | Every write and admin command (console, workbench, imports, typed ops, publish, bulk delete, slow log reset, client kill), Pub/Sub and MONITOR handshakes. |
| Measured socket, read-only (no actor check) | Console and workbench reads, key names, key and value reads, analysis, stream and time-series reads, search, INFO, COMMAND DOCS, slow log, clients. |
| Measured pipeline | The key browser's metadata batch: `TYPE`, `PTTL` and `MEMORY USAGE … SAMPLES n` for up to 500 keys, written at once per node and read back reply by reply, each with a small fixed cap plus the request budget; the actor is checked once, with the write. |
| node-redis | Topology (handshake, `CLUSTER SLOTS`, Sentinel) and proven fixed-size, unchecked reads (the v0.2 `keys/scan` list's metadata, still used by Guided mode and the bulk-delete preview). |

node-redis writes a queued command on a later event-loop turn, so a check before queueing could pass for an actor
revoked before the bytes leave; that is why every actor-checked command uses the measured sockets, where check and
write are one synchronous step. The replies node-redis reads itself are not measured: an honest Redis keeps them
small, but node-redis has no reply limit, so use verified TLS for any Redis outside a trusted network.

Closing a socket bounds the server's memory; it does not undo a mutation or stop work Redis already started.

## 7. Availability guards

- **Global:** `maxInflightCommands` (16) bounds measured commands and database requests through serialization; one
  user holds at most half. Busy work waits in a short FIFO (at most 2 s or its own timeout, at most 4 waiters per
  slot, abortable), then gets 429 naming the limit. Streams never take these slots. Every 429 carries `Retry-After`
  (1 s; sign-in limits ask for the time one more attempt takes to refill).
- **Bodies:** `maxBodiesInFlight` (256; a user an eighth) and `maxBodyBytesInFlight` (48 MiB for bodies over 64 KiB; a
  user half, at least 12 MiB), reserved before reading. Body limits: 12 MiB default, 1 MiB workbench, 64 KiB small
  POSTs, 16 KiB auth and admin.
- **Server timeouts:** request 120 s, headers 15 s, idle connection 30 s, keep-alive 5 s.
- **Per user:** CLI 20/s; ops 20/s; workbench 2/s, one script at a time (16 server-wide), whose results share 4 ×
  `maxReplyBytes`; at most 4 console commands in flight and 1 blocking command; 4 typed data reads at once; key names
  10/s (burst 20) and key metadata 10/s (burst 30), two of each at once; legacy scans 10/s; one pattern-delete job
  (four per server); one memory analysis (four server-wide), analysis jobs 1/s with five held per account; imports
  (operator and up) two per account; 20 pending confirmations per session; 10 outstanding Pub/Sub subscription ids;
  admin user creation and password resets (each an argon2id hash) 2/s, burst 10.
- **Commands:** `commandTimeoutMs` 5 s (blocking: block time + 2 s); workbench script budget 30 s; SCAN time budget
  per key-browser page (`scanBudgetMs`, 300 ms) and a slot threshold per names request (`keyScanThresholdMax`); memory
  analysis sample and time caps.
- **Streams (Server-Sent Events):** 3 live and 5 metrics streams per user, `maxStreams` per class server-wide, checked
  before any Redis connection opens; Pub/Sub 15 minutes, profiler at most 60 s and 200 events/s; events dropped when
  the client is 1 MiB behind and the stream closed at 8 MiB; a stream whose client leaves during the Redis handshake is
  torn down at once.
- **Sign-in:** 10 per minute per client address (IPv6 per /48), plus a global limit and per-account lockout.
- Rate limiters keep at most 100k buckets, dropping idle ones first. All of these are in memory, per instance.

## 8. Jobs

Long operations run as server-side jobs the browser polls. Jobs live in memory (a restart ends them), belong to one
account, and every Redis command they send goes through the same execute path as an interactive request.

| Job | Start | Bounds | Notes |
|---|---|---|---|
| Memory analysis (`routes/analysis.ts`) | Any role | One running per user, four server-wide; `analysisMaxMs`; five held per account, 64 server-wide, finished reports capped at 32 MiB in total | SCAN pages are sampled and dropped (each reply capped alone); what the report keeps shares one budget. Recommendations state their basis ("n of m sampled keys"); none claims a database-wide fact. Cancellable with a partial report. |
| Import of a command file (`routes/import.ts`) | Operator and up | Two per account, four running server-wide; 10,000 commands, 4 MiB; 15 minutes; plans expire after 10 minutes | Planned line by line with the workbench policy, in chunks that yield to the event loop; nothing runs at planning. One confirmation covers the run (prod: typed name + reason; stronger rules such as FLUSHDB's still apply). Each line is re-tokenized and re-checked at run time, runs through `execute` (measured transport, role ACL user, actor check), and is audited as `import.exec`. Blocking commands share the workbench time budget. The script stays in memory only while planned or running. |
| Delete by pattern (`routes/bulkDelete.ts`) | Operator and up | One per user, four per server; 1,000,000 keys visited | Same confirmation as the synchronous bulk delete: impact count and sample, typed name, prod reason. SCAN + `UNLINK` in batches, each command actor-checked; Stop ends it between batches. The report says what was deleted, scanned and failed, and why it ended. |

## 9. Sessions and authentication

- **OIDC** (`auth/oidc.ts`, openid-client): authorization code + PKCE (S256) + state + nonce. The flow state is stored
  hashed and bound to the browser with a 10-minute, single-use `rc_oidc` cookie (SameSite=Lax). Tokens are never sent
  to the browser and the ID token is not kept. The role comes from `groupsClaim` (ID token, then userinfo) through
  `roleMapping`; the highest wins; no match → refused. Groups are read at sign-in only; `auth.oidc.sessionTtlMinutes`
  bounds how long a removed user keeps the role.
- **Local accounts** (`store/users.ts`, `security/`): argon2id (`node:crypto`); unknown usernames take the same time;
  generic errors; per-account lockout updated atomically in SQL and re-read after hashing; TOTP (RFC 6238, ±1 step,
  replay-protected by the last used step) required for `requireTotpForRoles`. Seeds are AES-256-GCM encrypted (HKDF
  key from `totpEncryptionKey`, random IV, user id as AAD); clear-text seeds from older versions are encrypted at
  startup, and **startup is refused if any seed can't be decrypted** (see DECISIONS D07).
- **Sessions** (`store/sessions.ts`): 256-bit random IDs; only the SHA-256 is stored; a per-session CSRF token; rotated
  on sign-in, TOTP completion and password change; idle and absolute expiry; background polling
  (`X-RC-Background: 1`) does not extend the idle timer. Cookie `__Host-rc_session` (or `rc_session` without
  `secureCookies`).
- **Revocation:** each local user has an **auth generation**, bumped on role, password, TOTP and disabled changes. A
  session carries the generation it was issued under; the gate refuses older ones. Revocation is checked when headers
  arrive, after the body, after a slot wait, and right before every non-read Redis command (step 12). Long multi-command
  work (workbench, bulk delete, imports) re-checks between commands and stops. Admin user changes re-check the acting
  admin after the password hash.
- **Bootstrap:** with no local users, `bootstrapAdmin` is created with a forced password change; TOTP enrollment
  follows when the role requires it.

## 10. Audit and redaction

- SQLite table `audit`, append-only (triggers abort UPDATE and DELETE), and one JSON line per event on stdout with
  `"audit": true` for the SIEM. The single exception is retention (`store/auditRetention.ts`, `audit.retentionDays`,
  365 days by default): at startup and daily, batches of rows older than the cutoff are deleted, each in a transaction
  that holds a grant row the delete trigger checks (rows older than the grant's cutoff, never younger than 30 days);
  the grant never outlives the transaction. Pruning is audited as `system.audit.prune` with counts; stdout is untouched.
- Recorded: authentication events, every console/workbench/import command, typed operation and data read (one event
  per request, counts only), confirmations and their reasons, jobs, stream start and stop, admin actions, and every
  `auth.revoked` refusal.
- Redaction (`redactArgv`): known command and subcommand names verbatim; keys as `key#` + 12 hex characters of
  SHA-256 (correlation without the name, which may hold PII); every other argument as `<n bytes>`; unknown command
  names as `<unknown command>`; Redis errors by code only; unknown sign-in usernames as `unknown` + a hash.
- The request logger drops cookies, authorization and CSRF headers, bodies and query strings; resolved secrets
  serialize as `<secret …>`.

## 11. Web app

`apps/web` is a React 19 + Vite SPA, built to static files that the server serves from the same origin.

- **Content Security Policy** (every response, `http/headers.ts`): `default-src 'none'; script-src 'self';
  style-src 'self' 'nonce-<per request>'; img-src 'self' data:; font-src 'self'; connect-src 'self';
  frame-ancestors 'none'; base-uri 'none'; form-action 'self'; require-trusted-types-for 'script'`. The server injects
  the nonce into `index.html` as `<meta name="csp-nonce">` (`routes/static.ts`); libraries that add `<style>` tags get
  it (CodeMirror). React `style` props go through the CSSOM and are allowed. There is no Trusted Types policy: no code
  path turns a string into HTML or script.
- **Boot** (`main.tsx`): `lib/csp.ts` puts zod in jitless mode before any shared schema exists (its `new Function`
  probe would violate Trusted Types), the theme is applied before first paint, then `App.tsx` is loaded.
- **Shell** (`App.tsx`): sign-in and forced-change screens; the database landing (`/`); per-database routes under
  `/db/:databaseId/` (overview, keys, console, workbench, guided, diagnostics/:tool); preferences, account and admin
  pages. A rail, a context bar (database switcher, environment, `db N`, role, read-only) and a status bar (connection,
  version, keys, server CPU/ops/memory/clients with freshness). Staging and prod colour the whole frame; read-only
  adds a hatched edge. Pages are lazy-loaded.
- **Tools drawer** (`components/drawer/`): on every database page; Console (same component and memory as the Console
  page), Command helper (from `COMMAND DOCS` with the policy verdict) and, for admins on allowed environments, the
  Profiler; tabbed or side by side; open state, tab and height are presentation preferences.
- **Live sessions** (`lib/live.tsx`): Pub/Sub and profiler streams are owned by the database layout, so they keep
  running while you move between that database's pages, and end on database switch, sign-out or reload. Events are
  bounded in memory (200 messages, 300 profiler events).
- **Key browser scan model** (`lib/keyscan.ts`, `lib/keytree.ts`, `lib/keymeta.ts`): `keys/names` returns **names
  only** (SCAN `COUNT` 2000 per call up to "Keys to scan", 10,000 by default, each request bounded by `scanBudgetMs`);
  the client builds the whole namespace tree with counts and shares. **Metadata is lazy:** `keys/meta` reads type, TTL
  and size only for rows on screen, in debounced batches, cached per key in tab memory; hidden columns aren't read.
  Sizes use `MEMORY USAGE … SAMPLES 5` (constant cost per key; collection sizes are estimates). Sorting by metadata or
  "No TTL" loads it for every listed key, with progress and Stop. The list patches its own writes and otherwise says
  "Rescan to update"; it never claims more coverage than it scanned.
- **Console and keyboard** (`pages/Console.tsx`, `components/Editor.tsx`, `lib/console/`, `lib/keyboard/`): CodeMirror 6
  with the CSP nonce (`EditorView.cspNonce` from `<meta name="csp-nonce">`); redis-cli tokenization (shared with the
  server); completion, signatures and argument highlighting from `COMMAND DOCS` and key specs; a live policy badge
  (a hint: the server decides). One shortcut registry (`lib/keyboard/registry.ts`) drives dispatch, platform labels,
  visible hints and the `?` overlay; shortcuts never fire while typing in unrelated inputs.
- **Requests** (`lib/api.ts`): same-origin `fetch` with the CSRF token from `/auth/me`; Redis data only in POST bodies;
  a 428 opens the confirmation dialog with the server's preview, and a confirmed retry carries the token once; 401
  returns to sign-in with the reason; 409 opens the conflict view (Reload or Overwrite anyway, which is checked again).
  A 429 on a read (GETs and the read-only POST routes) is retried up to four times with exponential backoff and full
  jitter (250 ms base, 4 s cap), never sooner than the server's `Retry-After`, and not at all when that is longer than
  10 s; writes are never retried.
- **Rendering:** Redis data is text, always. No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, or navigation built
  from data. Key names render as typed segments (`components/anatomy.tsx`) with invisible and bidi characters made
  visible. Formatters (`lib/format.ts`, `msgpack.ts`, `javaser.ts`, `phpser.ts`) parse bytes into inert, bounded trees;
  Java and PHP payloads are never deserialized; gzip/deflate inflate locally up to 4 MiB. Charts are uPlot canvases;
  rich console results (search tables, time-series charts, query plans, geo maps) are built-in text renderers. The
  geo map is an SVG over a bundled public-domain land outline (`assets/world-110m.ts`, loaded on first use), at most
  2,000 points, with no tiles or other fetches.
- **Byte-exact data:** values travel as `Bin` (UTF-8 text or base64 bytes), so display, copy, download, re-run and
  write-back keep the stored bytes, including big integers, CRLF, BOM and invalid UTF-8.
- **Storage:** Redis data, console history, drafts and scan state live in React memory scoped to the signed-in session
  (`lib/memory.tsx`) and disappear on sign-out or reload. `localStorage` holds presentation preferences only (theme,
  last database id, "Keys to scan", enumerated preference values).

### v0.4 graph results and execution

Graph command rules live in the `v0.4 graph` block of `commands.ts`; `graphPolicy.ts` guards Cypher host I/O and
user code before authorization. `policy.ts` normalizes the reviewed graph option grammar and adds TIMEOUT <=1000 ms
before building the exact-command confirmation preview. Every graph reply uses measured transport and existing
byte/element/depth/time limits. Graph writes use the caller's actor-checked ACL tier and are never replayed after an
ambiguous failure. The separate FalkorDB sandbox config supplies engine time, row and queue caps (D21).

`graphReply.ts` recognizes verbose results and indentation plans. `GraphView.tsx` draws at most 200 unique nodes and
400 edges in a stable offline SVG layout; absent endpoints are labelled placeholders, omissions are counted, and
incomplete server replies explicitly limit what those counts mean. The result table uses the common 1000-row,
40-column cap. Plans use 1000 lines/40 levels. IDs remain decimal strings, including values beyond JS integer
precision. All properties, labels and stats render as text. The graph view loads no external assets and uses no tiles, workers or physics loops. `graphdata` key reads give a Workbench/GRAPH.RO_QUERY hint rather than attempting a collection read.

## 12. Data-flow guarantees

| Never reaches the browser | Redis passwords, connection URLs, hosts and ports, TLS material, the OIDC client secret and tokens, session IDs in readable form (HttpOnly cookie only), TOTP seeds after enrollment, other users' password hashes. Non-admins also don't see network addresses inside replies (`CLIENT LIST`, `INFO` listeners, `SLOWLOG` clients, `CLUSTER NODES`). |
|---|---|
| Never in a URL | Key names, patterns, channels, group names, queries. Pub/Sub streams use a single-use subscription id bound to the session and database. |
| Never in logs or the audit | Redis values, passwords, tokens, cookies, session IDs, request bodies, Redis error text (code only), confirmation previews. |
| Never on the device | Redis data in `localStorage`/`sessionStorage`/IndexedDB; history is per tab and lost on reload. Exports happen only when the user downloads a value or the profiler lines. |
| Never leaves the server's network path | Nothing besides Redis and the OIDC issuer: no telemetry, no AI service, no runtime fetches, self-hosted fonts. |
| Never executed | Redis data (no HTML, no deserialization, no URLs), Lua or Functions, user-supplied MULTI, unknown commands. |

## 13. Supply chain and deployment

- Few dependencies, exact versions (`save-exact`), a frozen lockfile, and no install scripts outside
  `onlyBuiltDependencies` (esbuild). Node built-ins are preferred (`node:sqlite`, `crypto.argon2`, `fetch`).
- TypeScript is erasable-only (no enums, namespaces or parameter properties) so Node runs the server sources directly.
- CI (`.github/workflows/ci.yml`, GitHub-hosted runners, no external data): frozen install, typecheck, unit and
  integration tests against the sandbox plus the cluster, Sentinel and mutual-TLS topology, `pnpm audit`, a CycloneDX
  SBOM, the image build with smoke tests (non-root, refuses to start without config, no package managers, `/healthz`
  and the SPA with a read-only root filesystem), and the end-to-end suite.
- Image: multi-stage, `node:24-slim`, no npm/corepack/yarn, uid 1000, read-only root filesystem, only `/data` writable.
  Deployment examples in `deploy/` (Compose, Kubernetes with restricted Pod Security and a NetworkPolicy). See
  [INSTALL.md](INSTALL.md).
