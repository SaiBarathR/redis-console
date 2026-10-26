# 05 — Independent review of the Redis Console web frontend

- **Scope:** `apps/web` on branch `feat/web` at HEAD `2b5ae37` (worktree `../redis-console-wt/web`).
- **Method:**
  - I read every source file in `apps/web/src`, the built bundle in `dist/assets`, the shared contract, `ARCHITECTURE.md` and `CONTRACT-CHANGES.md`.
  - I drove the live instance on `:4300` with Playwright Chromium as Keycloak users `viewer1`, `operator1` and `admin1`.
  - A route guard aborted any non-GET request to a database other than `sandbox-e2e`. It never triggered.
  - Hostile data was seeded only into `sandbox-e2e` under `rcreview:*`, then removed with a typed-confirmed bulk delete (58 keys).
  - I started no server. I wrote nothing to 6390 and made no connection to 6380.
- **Screenshots:** `review-web/` (filenames are referenced below).

## Summary

The frontend is in good security shape. I found **no Critical and no High issues**.

What I verified holds:
- **No HTML sinks.** There are no HTML-injection sinks in app code, and there is no URL navigation built from data. The only `innerHTML` uses in the bundle are React's own `__html` and `<script>` handling, and the app never uses them.
- **XSS payloads stay inert.** Payloads in keys, values, hash fields, stream fields, JSON, MessagePack and pub/sub messages all rendered as plain text, and no dialog fired.
- **Bidi and zero-width characters are made visible** as `\u202e` / `\u200b`.
- **CSP and Trusted Types are honoured.** The page ran under the real server CSP (`require-trusted-types-for 'script'`, `style-src` with a nonce) with zero violations and zero page errors.
- **No storage leaks.** localStorage holds only `rconsole.theme`. sessionStorage, IndexedDB and Cache Storage are all empty. `document.title` is static. Keys are never put in the browser URL. The app never logs to the console.
- **CSRF and confirmation hold.** Every non-GET request carries `X-CSRF-Token`, and the server rejects a missing or wrong token (403 `csrf`). The 428 dialog cannot be auto-confirmed. Typed text must match exactly; a trailing space keeps the button disabled, and pressing Enter does not submit.
- **Role gating is cosmetic only.** As a viewer, a direct `POST /cli SET` and `POST /ops key.delete` both returned 403 from the server. `/admin/*` and `/profiler/stream` also returned 403.
- **Decoders are safe.**
  - A 64 MiB gzip bomb stops at the 4 MiB cap.
  - Java and PHP serialized values are detected and displayed only; they are never deserialized.
  - MessagePack decoding has length caps, and its errors are caught.
- **No open redirect.** The OIDC `?error=` value only selects one of a fixed set of messages. There is no post-login `returnTo`. The logout redirect URL comes only from the server.
- **Dependencies:** `pnpm audit --prod` reports no known vulnerabilities, and all versions are pinned exactly.

The remaining issues are mostly about **what the user is shown when confirming**, metadata leaking through **URLs** (to proxy logs, not browser history), a few **functional bugs**, and a lot of **UX polish** that matters for the "redis-cli for people who don't know redis-cli" goal.

---

## Findings

### Medium

**M1. Confirmation dialogs don't say what will be destroyed.**
- **Where:** `components/Confirmation.tsx:72-75` (renders only `challenge.summary`). The summary text is built on the server in `apps/server/src/policy/policy.ts:165-170` and `routes/cli.ts:99`.
- **Repro:**
  - Console: run `DEL rcreview:list`. The dialog says only "DEL on E2E scratch", with no key name (`07-confirm-del-console.png`).
  - Workbench: run a script with two `DEL`s. The dialog says "Run a workbench script with 2 destructive command(s)" and doesn't list which ones (`61-admin-workbench-confirm.png`).
  - Key browser delete: the dialog says "Delete 1 key(s) on E2E scratch" (`25-…`).
  - None of these dialogs shows the environment badge.
- **Why it matters:** on prod, the user types the database name and a reason while confirming something the dialog doesn't show. That turns the typed confirmation into a ritual rather than an informed decision. Only bulk delete shows an impact sample.
- **Fix:**
  - Contract: add `challenge.commands?: string[]` to `ConfirmationChallenge`. The server should fill it with display-safe argv (command, subcommand and key names truncated; values shown as `<n bytes>`).
  - Client: render that list with `displayBin` and `visibleText`, plus an environment and read/write badge, and the role in use.
  - For single-key ops, put the key in `impact.sample`.

**M2. Key names, scan patterns and channel names travel in GET query strings.**
- **Where:**
  - `Keys.tsx:387-395` (`/key?k=`), `Keys.tsx:671-679` (`/keys?match=`)
  - `Guided.tsx:157-167`
  - `Diagnostics.tsx` streams, timeseries and pub/sub SSE (`?channel=`)
- **Context:** the server's own logger strips the query string (`apps/server/src/app.ts:68`), which is good. But any reverse proxy, load balancer, WAF or APM in front of it (nginx, ALB, Cloudflare, Datadog RUM) logs full URLs by default.
- **Why it matters:** `ARCHITECTURE.md` says keys "may contain PII" (e.g. `session:<email>`). This is a silent leak channel at exactly the kind of company this product is for.
- **Fix:** move key-addressed reads to `POST` with a JSON body (`/key/read`, `/keys/scan`). Alternatively, put the key in an `X-RC-Key` header that the proxy config is told not to log. At minimum, document the "don't log query strings" requirement in the deployment guide. EventSource can't send a body, so for SSE add a short-lived opaque subscription ID: `POST /pubsub/sessions` returns `{id}`, then the client opens `GET /pubsub/stream?id=`.

**M3. The JSON tree can never show values over ~100 KB, even after "Load full value".**
- **Where:** `components/ValueViewer.tsx:24-31` parses the output of `formatValue(…,"tree")`. That output is the pretty-printed text already cut at `DISPLAY_LIMIT` (`lib/format.ts:105-111`).
- **Repro:** a 117 KiB JSON string fails with "Unterminated string in JSON at position 65536". After **Load full value**, it fails again at position 100000 (`18b-…`, `18c-json-big-full-tree.png`).
- **Fix:** for `tree`, parse the bytes directly (`JSON.parse(TextDecoder.decode(bytes))` under the existing 4 MiB cap) and hand the object to `JsonTree`. Truncate only the text views.

**M4. Landing auto-opens the first configured database, which could be prod, and starts live telemetry on it.**
- **Where:** `App.tsx:261-265` (`databases.data?.[0]`) and the `path="*"` redirect at `App.tsx:552-555`. The Dashboard starts its SSE stream immediately (`Dashboard.tsx:32`).
- **Repro:** after login the URL is `/db/sandbox-main/overview` (`02-landing-default-db.png`). With a prod database listed first, every login lands on prod and runs `INFO` once a second.
- **Fix:** add a `/` route that shows a "choose a database" list with environment, role and read-only status, and only open a database on an explicit click. Remembering the last database in sessionStorage is acceptable; only the ID would be stored.

**M5. Console and Workbench state is lost on every navigation.**
- **Where:** results and history live in component state (`Console.tsx:70-79`).
- **Repro:** run 5 commands, open Key browser, come back: 0 results, history gone.
- **Why it matters:** this is the single most noticeable regression versus redis-cli and Redis Insight. Bouncing between Keys and Console is the core loop.
- **Fix:** keep history and results in a per-database in-memory store at Session scope (React context or a module-level Map keyed by db ID), cleared on logout and session expiry. This still satisfies "not persisted to the device".

**M6. Destructive buttons have no intent step, and some are styled as primary actions.**
- **Where:**
  - Client **Kill** (`Diagnostics.tsx` Clients): a blue primary button on every row, including the console's own `rconsole-*` connections (`62-admin-clients.png`).
  - Stream **Destroy** group.
  - **Reset slow log**.
  - Per-element trash icons in the hash, list, set, zset and stream tables (`Keys.tsx:158-172`).
- **Context:** they all rely on the server sending a 428. Wherever the server's rule is `none`, one click irrevocably deletes or kills.
- **Fix:**
  - Style these with `danger`.
  - Disable Kill on rows whose name starts with `rconsole-` (the server should refuse it too).
  - Use the same `KeyOp` path through `keyOperation()` so that Redis error replies surface. `KeyContent.remove` uses raw `post` and swallows `{t:'err'}` (`Keys.tsx:142`).

### Low

**L1. Two `csp-nonce` meta tags are served.**
- **Where:** `index.html` ships `<meta name="csp-nonce" content="">`, and the server prepends a second one carrying the real nonce. `Editor.tsx:61-64` takes the first match.
- **Risk:** if the injection point ever moves below the template tag, CodeMirror silently gets an empty nonce and its styles are CSP-blocked.
- **Fix:** remove the placeholder from `index.html`, or have the server replace it rather than prepend. In the editor, select `meta[name="csp-nonce"]:not([content=""])`.

**L2. The logout redirect accepts `http:`.**
- **Where:** `App.tsx:165-171`.
- **Context:** the URL is server-controlled, so this is not an open redirect. But in production it should be `https:` only, or ideally the configured issuer's origin.
- **Fix:** reject `http:` unless `location.protocol === "http:"`, or compare against an `issuerOrigin` exposed by `/auth/providers`.

**L3. Format detection gives false positives.**
- **Where:** `lib/format.ts:43-52`.
- **Examples:**
  - `"x^2 + y^2"` is labelled **deflate** and offers Inflate (`17c-…`).
  - `"s:hello this is plain text"` is labelled **PHP serialization** (`17b-…`).
- **Fix:**
  - deflate: also require byte 2 to be a valid block header, and only label it after a trial inflate of the first 1 KiB succeeds.
  - PHP: require a full-token match, e.g. `/^(?:[aOC]:\d+:|s:\d+:"|i:-?\d+;|b:[01];|d:[^;]+;|N;)/`.
- **Suggestion:** for Java, show the top-level class name safely (`0xACED0005 0x73 0x72 <u16 len><utf8 name>`). Spring Session and Spring Cache with JDK serialization are the most common binary values a Spring developer will meet. This is display-only parsing; never instantiate anything.

**L4. MessagePack on a truncated preview fails with an opaque error.**
- **Repro:** a 195 KiB value shows "Offset is outside the bounds of the DataView" (`15b-…`).
- **Fix:** when `value.truncated`, disable the msgpack, JSON and tree formats with "Load the full value to decode". Map decoder `RangeError` to "Not valid MessagePack (or truncated)".

**L5. The `qrcode@1.5.4` dependency drags in 28 transitive packages.**
- **What:** `yargs@15` with its CLI tree (`y18n`, `cliui`, `find-up`, …), plus `pngjs` and `dijkstrajs`. None of this reaches the browser bundle, but all of it sits in the install and SBOM surface. Upstream has had little maintenance.
- **Fix:** replace it with a zero-dependency encoder and keep the canvas rendering (do not use an SVG string with `innerHTML`). `qrcode-generator` has no dependencies, or vendor ~300 lines. Alternatively, render the QR server-side as a PNG data URL; `img-src data:` is already allowed.

**L6. The bulk delete dialog is misleading.**
- **Where:** `Keys.tsx:933-944`.
- **Problems:**
  - The button reads **"Preview impact"**, but it actually issues the delete; the server's typed 428 is what provides the preview.
  - The pattern is prefilled with the current scan filter, which defaults to `*` (`27-…`).
  - The type filter applied is the browser's `filter.type`, not something chosen in the dialog.
- **Fix:**
  - Rename the button to "Review & delete…".
  - Start with an empty pattern and refuse a pure wildcard client-side as well.
  - Show the type filter as an editable field.
  - After confirmation, report "Deleted N of M scanned".

**L7. The Profiler's environment gate is hard-coded.**
- **Where:** `Diagnostics.tsx` Profiler checks `db.environment === "prod"`, while the server uses `policy.profilerAllowedEnvironments`. Staging gets the UI even when the server forbids it, and the reverse.
- **Fix:** expose `features.profiler` on `DatabaseSummary`.
- **Also:** the profiler shows the console's own `MEMORY USAGE` / `TTL` / `TYPE` traffic (`63-admin-profiler.png`). Add a "hide Redis Console connections" toggle, filtering by client name.

**L8. Copy actions give developer-hostile output.**
- **Where:** "Copy result" copies the internal reply tree JSON (`{t:"str",v:{enc,data}}`) (`Console.tsx:285-288`). The binary key header shows the whole key as base64 (`[binary / base64] cmNyZXZpZXc6YmluYXJ5/wA=`, `21-key-binary.png`), where redis-cli would print `rcreview:binary\xff\x00`.
- **Fix:** render binary as redis-cli-style escaped text (reuse `cliBin`'s escaping, but only for non-printable bytes). Make "Copy" yield redis-cli-formatted text, and keep "Copy JSON" as a secondary option.

**L9. The policy badge is misleading in two cases.**
- **Empty console:** it shows **read** before anything is typed (`06-…`). Show a neutral badge.
- **`FLUSHDB` for an admin:** it shows the generic "Changes data" hint. Destructive rules (`FLUSHDB`, `DEL`, `UNLINK`, `XTRIM`, `FT.DROPINDEX`) should show a red "destructive · confirmation required" badge with the rule's hint.

**L10. Guided "Inspect a value" doesn't teach and misreports what runs.**
- **Where:** `Guided.tsx:95-96` and `Guided.tsx:162-168`.
- **Problems:**
  - The "Command you'll run" box says `TYPE "key"`, but the form actually calls `GET /key`, which runs TYPE, TTL, OBJECT ENCODING, MEMORY USAGE and a type-specific read.
  - The result is the raw API object (`key.enc`, `key.data`, `value.entries` …) (`30-guided-inspect.png`).
  - The publish result is also raw JSON (`receivers 1`).
- **Fix:**
  - Preview the real sequence (`TYPE`, `TTL`, `HSCAN … 0 COUNT 100`).
  - Render the result with `KeyContent`.
  - Phrase the publish result as "Delivered to 1 subscriber".

**L11. Smaller polish items.**
- The "Keys" stat sums every logical DB (318) while the configured database is db0 (316).
- Average TTL is shown as raw seconds ("2822234s").
- uPlot's x-axis shows ":41.250"-style fractional-second ticks.
- A sixth Overview tab just says "Live stream unavailable" without the 429 reason (`70-…`).
- The sixth tab also gets a console "Autofocus processing was blocked" warning from stacked dialogs.
- Key rows are 54 px tall, so only about 8 keys are visible on a 900 px screen (`09-keys-tree.png`). Redis Insight shows 20 or more.
- `ErrorState` renders server messages without `visibleText` (`components/ui.tsx:15`). Redis error text can echo user data.

---

## UX review: the "super-intelligent redis-cli" goal

**What already works:**
- The visual system is clean and consistent in light and dark themes.
- Production is clearly marked with a red badge, a banner and READ ONLY in the switcher (`54-…`).
- The command palette and keyboard shortcuts are good.
- Autocomplete shows class, summary, arguments and complexity (`04-…`).
- Blocked-command hints are excellent ("KEYS blocks the server… use SCAN", "FLUSHALL disabled, admins can use FLUSHDB on non-prod").
- The bulk delete impact preview is good (`28-…`).

**Gaps against the goal:**
1. **Results don't look or feel like redis-cli.**
   - There's no `(integer)` / `(nil)` / quoted-string distinction: the SCAN cursor `490` looks the same as a key.
   - Results are newest-first cards rather than a scrolling transcript.
   - Offer a "terminal" view with redis-cli formatting, and an "explain this reply" line, e.g. "SCAN returned cursor 490: run again with 490 to continue".
2. **No argument-level help while typing.** Only the command name autocompletes. Add:
   - argument signature hints at the cursor (the next expected arg, highlighted)
   - key-name completion from recently scanned keys, held in memory
   - subcommand completion (`CLIENT |`, `XINFO |`)
3. **No bridge from Console to Key browser.** Clicking a key in a reply should open it in the browser. "Open in console" from a key should prefill the read command; Copy CLI exists, but there's no direct jump.
4. **Delete needs two dialogs.** The app's "Delete this key?" is followed by the server's "Confirm this action" (`24-…`, `25-…`). Fold them into one by sending immediately and showing only the server challenge, now carrying the key (see M1).
5. **Editing is add-only.** Hash, list and zset rows can't be edited inline. "Edit" on a hash opens an add-one-field form. Developers expect to click a value, change it and save (`HSET`, `LSET`, `ZADD XX`).
6. **Missing states:**
   - No "scan budget exhausted, 0 found so far, continue?" explanation when a page returns empty.
   - No relative TTL countdown.
   - No refresh-interval control on the key detail panel.
   - No visible session-expiry warning before the idle timeout logs the user out mid-edit.
7. **The Diagnostics grid hides Clients and Profiler from non-admins** without saying they exist. A greyed-out card reading "requires admin" teaches the permission model better.

## Feature parity gaps vs Redis Insight (everyday Spring/Node use)

| Gap | Why a Spring/Node developer wants it | Suggestion |
|---|---|---|
| Java serialization class name (display-only) | Spring Session and Spring Cache values with the default JDK serializer are opaque hex today | Parse the `TC_CLASSDESC` name and serialVersionUID without deserializing (L3) |
| Timestamp formatter | Epoch ms in values, hash fields and zset scores (BullMQ, rate limiters) | "Interpret as epoch ms/s" toggle on numbers |
| Inline edit of collection elements | Fixing one hash field or list item is the most common write | `HSET`/`LSET`/`ZADD XX` inline, with truncated elements excluded |
| Field-level TTL (`HEXPIRE`/`HTTL`, Redis 7.4+) | Server is 8.10 | Show and set per-field TTL |
| ReJSON path editing | Edit a sub-path instead of the whole document | `JSON.SET key $.path` editor with a path picker from the tree |
| Persistent per-DB console transcript (in-memory) and saved workbench snippets | Daily repetitive queries | Session-memory transcript (M5); optional server-side saved snippets with ACLs, never values |
| Sort and filter the key list by TTL, size, type | Find the leaking or largest keys quickly | Client-side sort of the loaded page and a "no TTL only" filter |
| Bulk actions on selected keys (set TTL, delete) | Cleanup after tests | Multi-select, then a server op with a single confirmation listing the keys |
| Export/import of a key or value (download as file) | Reproduce bugs locally | Download via a `Blob` + `a[download]` built from bytes (no navigation from data); gate on role and audit server-side |
| Queue-aware views (BullMQ `bull:*`, Spring `spring:session:*`, Socket.IO adapter channels) | Most common Node and Spring Redis use cases | Namespace "recipes" that label known key families and suggest the right read command |
| RediSearch index creation and `FT.AGGREGATE`, query profiler | Present in Redis Insight | Index list and query exist; add `FT.EXPLAIN`/`FT.PROFILE` output and a schema view |
| Cluster/sentinel node view, slot map, per-node INFO | Production topologies | The topology shows only "standalone" today |
| Logical DB index switching (`SELECT`) | Many dev setups use db1, db2… | The keyspace shows db1 with 2 keys, but it can't be browsed; expose per-db config or a DB picker for non-prod |
| "Copy as code" (Spring Data `RedisTemplate`, ioredis, node-redis) | Bridges the GUI to the developer's own code | Generate from the argv the UI already builds |

## Notes on verification

- Seeded hostile data included:
  - `<img onerror>` / `<script>` / `javascript:` keys and values
  - RTL-override and zero-width text
  - binary keys with `\xff\x00`
  - a 64 MiB gzip bomb
  - nested and deep MessagePack (200k nesting)
  - a Java stream header and PHP serialized payloads
  - a 117 KiB JSON document
  - hash, list, set, zset and stream values carrying XSS payloads
- The pub/sub round trip worked (`33-pubsub.png`).
- The dashboard SSE was live, and a sixth concurrent tab was refused by the server's stream cap.
- After logout, pressing Back shows the login page with no cached data (`40-…`).
- Confirmation tokens can be fetched and replayed programmatically by the signed-in user (I did this for cleanup). That is expected: it's a UX safeguard, not a boundary. It is one more reason M1 matters, because it is the only thing standing between a hurried click and a destructive command.
