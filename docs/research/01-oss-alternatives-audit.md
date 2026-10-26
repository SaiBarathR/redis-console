# 01: Open-source Redis GUI alternatives, survey and security audit

**Date:** 2026-10-22
**Scope:** Find an open-source, browser-based Redis GUI we could fork to replace Redis Insight. Security is the primary requirement.
**Target model (from the brief):** The browser never holds Redis credentials and never executes anything. Only the backend holds connection config (`rediss://`, configured server-side) and runs Redis commands. The UI is a "smart redis-cli with great UX" with feature coverage close to Redis Insight.

> **Method.** I pulled GitHub metadata through the GitHub API on 2026-10-22, searched the web for licenses and CVEs, and shallow-cloned the shortlisted repos into `repos/`. **The cloned code was only read**: nothing was installed, built or run. Every security finding below comes from reading the code. None was confirmed by exploiting it. Findings marked *(likely)* depend on runtime behaviour I could not observe.
>
> Cloned commits:
> - `valkey-admin@0161e2a` (2026-10-14)
> - `p3x-redis-ui@ffd81b2`, `p3x-redis-ui-server@b587f86`, `p3x-redis-ui-material@2bba5db` (2026-09-02)
> - `redis-commander@2a222de` (2025-09-11)
> - `redisinsight@43bd288` (2026-09-29; license and architecture check only)

---

## 1. Executive summary

- **No existing project meets our target model without changes.** Every web-capable candidate lets the browser supply the Redis host, port and password, which is an SSRF and credential-handling problem. Every one also exposes an unrestricted or near-unrestricted command console. None has built-in SSO or RBAC.
- **Redis Insight is SSPL-1.0** ([LICENSE](https://github.com/redis/RedisInsight/blob/main/LICENSE), README §License). Our own private changes for internal use are arguably allowed. But SSPL §13 obligations, the usual corporate bans on SSPL, and the fact that it is the tool we are replacing rule it out as a fork base.
- **Best fork or borrow base: Valkey Admin** (`valkey-io/valkey-admin`).
  - Apache-2.0, under the Valkey project (Linux Foundation).
  - Modern React 19 + TypeScript frontend with a small Node server (about 5k LOC).
  - Active (v1.2.0 on 2026-09-24), already security-aware: CSP via helmet, WebSocket Origin checks, HttpOnly SameSite=Strict session cookie, HMAC-authenticated internal control plane, CodeQL in CI, a SECURITY.md disclosure process.
  - Weaknesses:
    - The connection model is browser-supplied, so the server becomes an SSRF client (see §4.1, F-VA-1).
    - It relies on a command blocklist rather than an allowlist.
    - No authentication at all.
    - It targets Valkey: Redis-specific coverage (SLOWLOG, pub/sub, Sentinel, Redis 8 types, RediSearch) is missing.
- **P3X Redis UI** has the most features but is **disqualified on security and supply chain**:
  - Google Analytics/GTM is loaded into the page, with `unsafe-eval` in the CSP.
  - An **AI feature that is on by default** sends console input and Redis tool output (INFO, SLOWLOG, CLIENT LIST, key names) to the maintainer's server `network.corifeus.com`.
  - A critical credential-handling issue (details withheld pending coordinated disclosure, §4.2).
  - Wildcard CORS, auth off by default, binds `0.0.0.0`.
  - Effectively one maintainer, who publishes their own utility packages.
- **Redis Commander** is MIT and simple, and has a JWT-SSO hook and a read-only mode. But its UI is legacy jQuery/EJS, development is slow (last commit 2025-09-11, v0.9.1), it logs key values by default, and any user can add connections to arbitrary hosts. Its UX would not meet the brief.
- **Recommendation:** **Build our own backend (the security core) from scratch**, following the companion architecture doc. **Seed the frontend from Valkey Admin (Apache-2.0)** where its components fit, and borrow UX ideas from Redis Insight, Another Redis Desktop Manager and Tiny RDM (looking only, no code copying from SSPL/GPL sources).
  - A pure fork-and-harden of Valkey Admin is the only credible fork path (about 3–4.5 months to reach parity, about 6–10 eng-weeks of it security work; see §6). Its server would be rewritten anyway, so "fork" mostly means "reuse the React app".

---

## 2. Comparison table

Legend: ✅ supported · ◐ partial · ❌ missing · — not applicable

| | **Redis Insight** | **Valkey Admin** | **P3X Redis UI** | **Redis Commander** | **phpRedisAdmin** | **Tiny RDM** | **Another Redis Desktop Manager** |
|---|---|---|---|---|---|---|---|
| Repo | [redis/RedisInsight](https://github.com/redis/RedisInsight) | [valkey-io/valkey-admin](https://github.com/valkey-io/valkey-admin) | [patrikx3/redis-ui](https://github.com/patrikx3/redis-ui) (+ `-server`, `-material`) | [joeferner/redis-commander](https://github.com/joeferner/redis-commander) | [erikdubbelboer/phpRedisAdmin](https://github.com/erikdubbelboer/phpRedisAdmin) | [tiny-craft/tiny-rdm](https://github.com/tiny-craft/tiny-rdm) | [qishibo/AnotherRedisDesktopManager](https://github.com/qishibo/AnotherRedisDesktopManager) |
| License | **SSPL-1.0** (not OSI) | **Apache-2.0** | MIT | MIT | CC-BY-3.0 | **GPL-3.0** | MIT |
| Stack | NestJS API + React UI; Electron or Docker web | Node (express+ws, valkey-glide) + React 19/Redux/Tailwind; Electron or Docker/K8s web | Node (express 5, socket.io, ioredis) + Angular, React **and** Vue UIs; Electron or web | Node (express 4, ioredis) + jQuery/EJS | PHP (Predis) | Go + Vue 3 (Wails desktop) | Electron + Vue 2 + ioredis in renderer |
| Web/server mode | ✅ Docker (`:5540`) | ✅ Docker/K8s (`:8080`) | ✅ (`:7843`) | ✅ (`:8081`) | ✅ | ❌ desktop only | ❌ desktop only |
| Stars | 8.9k | 154 | 807 | 4.0k | 3.2k | 13.1k | 34.8k |
| Last commit (default branch) | 2026-09-29 | 2026-10-14 | 2026-09-02 | **2025-09-11** | 2026-10-19 | 2026-07-12 | 2026-08-20 |
| Latest release | 3.8.0 (2026-07-21) | v1.2.0 (2026-09-24) | v2026.10.100 (2026-09-02) | v0.9.1 (2025-07) | v1.27.0 (2026-10-19) | v1.2.7 (2026-03-30) | v1.7.4 (2026-08-18) |
| Bus factor (contributors; top committers) | 57; company-backed (Redis Ltd) | 19; top 3 ≈ 760 commits, Valkey/LF org | **5; `p3x-robot` 1292 of 1308 commits** | 83; `sseide` 418, `joeferner` 209 | 55; `erikdubbelboer` 164 of 238 | 15; `tiny-craft` 748 of 768 | 38; `qishibo` 835 of 885 |
| Credentials configured server-side only? | ◐ env `RI_REDIS_*` / pre-setup file + `RI_DATABASE_MANAGEMENT=false` | ◐ env `VALKEY_*` used only by the metrics collector; UI connections still sent from the browser | ◐ connection file on the server, but the browser can create and edit connections | ◐ config file / CLI, but `/login` lets any user add hosts | ✅ `config.inc.php` / env | — | — |
| App authentication | ❌ none in Docker | ❌ none ("use an auth proxy") | ◐ optional Basic → JWT, **off by default** | ◐ optional Basic → JWT; **JWT-SSO hook** | ✅ required by default (since recent versions) | — | — |
| RBAC / per-user policy | ❌ | ❌ | ❌ (global read-only flag only) | ❌ (global read-only flag) | ❌ | — | — |
| Key browser, all core types | ✅ | ✅ (String/Hash/List/Set/ZSet/Stream/JSON) | ✅ | ◐ (no JSON editor parity) | ◐ basic | ✅ | ✅ |
| RedisJSON / Search / TimeSeries / Bloom | ✅ | ◐ JSON only | ✅ | ❌ | ❌ | ◐ | ◐ |
| Streams (incl. consumer groups) | ✅ | ◐ | ✅ | ◐ | ❌ | ✅ | ✅ |
| Pub/Sub viewer | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ |
| CLI / Workbench | ✅ both | ✅ "Send Command" | ✅ console (+AI) | ✅ CLI | ❌ | ✅ | ✅ |
| Profiler (MONITOR) | ✅ | ✅ | ✅ | ❌ (blocked) | ❌ | ◐ | ✅ |
| Slowlog | ✅ | ◐ Valkey 8.1+ COMMANDLOG only | ✅ | via CLI | ❌ | ✅ | ✅ |
| Memory analysis / big keys | ✅ | ✅ hot keys / big keys | ✅ | ❌ | ❌ | ◐ | ◐ |
| Cluster | ✅ | ✅ (topology view) | ✅ | ✅ | ❌ | ✅ | ✅ |
| Sentinel | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ |
| TLS to Redis | ✅ incl. mTLS | ✅ TLS (no mTLS) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Third-party egress | Telemetry (opt-in), Redis Cloud, AI (`RI_AI_*`) | none found | **Google Analytics + AI proxy to `network.corifeus.com` (default on)** | none found | none found | — | — |
| Known CVEs / advisories | Only dependency/container CVEs in distro trackers ([Chainguard](https://images.chainguard.dev/directory/image/redisinsight/vulnerabilities)) | none published | none published | [GHSA-8c8c-4vfj-rrpc](https://github.com/advisories/GHSA-8c8c-4vfj-rrpc) reflected XSS (2020) | [CVE-2020-27163](https://nvd.nist.gov/vuln/detail/CVE-2020-27163) XSS, [CVE-2021-4259](https://nvd.nist.gov/vuln/detail/cve-2021-4259) auth bypass (9.8), [CVE-2021-4268](https://nvd.nist.gov/vuln/detail/cve-2021-4268) CSRF | none found | [CVE-2024-23998](https://osv.dev/vulnerability/CVE-2024-23998) XSS (public PoC) |
| npm packages in lockfile | 2,468 root + 1,199 api | 1,172 | ≈692 server + ≈1,605 UI + ≈1,005 Electron wrapper (yarn) | 633 | composer (small) | Go modules + npm | npm |
| Fork-able for us? | **No** (SSPL, and it is the thing being replaced) | **Yes** | Legally yes; **not advisable** | Legally yes; UX too dated | Too feature-poor | GPL-3.0; desktop-only; would need a new transport | Desktop-only, Vue 2 (EOL) |

Notes on the table:
- **Stars, commits and dates:** GitHub API, 2026-10-22.
- **Feature columns:** for Valkey Admin and Redis Commander these come from reading the code and READMEs. For P3X they come from its [features doc](https://github.com/patrikx3/redis-ui/blob/master/artifacts/readme/features.md) plus the code. For the desktop tools they come from READMEs and were not verified in depth.
- **Advisories:** The GitHub repository advisory endpoints returned no published advisories for any of the repos. The CVEs listed come from NVD, OSV and the GitHub Advisory DB.

### Other projects found and excluded

| Project | Why excluded |
|---|---|
| [libredb/libredb-studio](https://github.com/libredb/libredb-studio) (MIT, 1.3k★, created 2025-12, SSO + audit) | Generic multi-database SQL IDE; Redis is a minor plugin. Very young. Worth watching for its SSO and audit design. |
| [dromara/mayfly-go](https://github.com/dromara/mayfly-go) (Apache-2.0, 2.4k★, Go + Vue) | Broad ops platform (SSH terminals, SQL, Redis, Mongo, ES). Huge attack surface for a Redis-only need. Chinese-language-first. |
| [dbgate/dbgate](https://github.com/dbgate/dbgate) (GPL-3.0, 7.3k★) | Multi-database tool; Redis support is shallow; GPL. |
| [RobiNN1/phpCacheAdmin](https://github.com/RobiNN1/phpCacheAdmin) (MIT, 447★) | One maintainer, PHP, basic Redis features. |
| [quick123official/quick_redis_blog](https://github.com/quick123official/quick_redis_blog) | Desktop only, no release since 2022. |
| Terminal UIs (e.g. `huseyinbabal/tredis`) | Not browser-based. |

---

## 3. Licensing notes

- **Redis Insight: SSPL v1.**
  - The repo LICENSE is the MongoDB SSPL text. The README says "Redis Insight is licensed under SSPL". The LICENSE history shows a 2021 edit that was reverted on 2024-04-06.
  - SSPL §13 requires releasing the full "Service Source Code" if we "make the functionality of the Program or a modified version available to third parties as a service".
  - Purely internal use by employees is arguably not "third parties", but this is untested legal ground. Many corporate open-source policies (and OSI) do not treat SSPL as open source and ban it outright.
  - It also ships Redis-Cloud-coupled features: cloud OAuth IdPs (`RI_CLOUD_IDP_*`), an AI service (`RI_AI_*`) and analytics.
  - **Verdict: do not fork.** Use it as a UX reference only (no code copying).
  - Background: [Redis licensing](https://redis.io/legal/licenses/), [RSALv2/SSPL announcement](https://redis.io/blog/rsalv2-sspl-announcement/).
- **Valkey Admin, Apache-2.0:** permissive with a patent grant. Keep the NOTICE files. Best fit.
- **P3X, Redis Commander, ARDM, MIT:** permissive.
- **Tiny RDM, GPL-3.0:** internal use and modification are fine. Distributing a derivative outside the company would trigger copyleft. Borrow ideas only.
- **phpRedisAdmin, CC-BY-3.0:** an unusual license for code, but permissive with attribution.

---

## 4. Static security reviews (top candidates)

Severity reflects **our** threat model: an internal multi-user web app reachable from the corporate network, with production Redis behind it.

### 4.1 Valkey Admin: `repos/valkey-admin` (Apache-2.0)

**Architecture.**
- One Node process (`apps/server`) serves the SPA and a WebSocket (`ws`) action bus.
- It spawns per-node "metrics collector" child processes (`apps/metrics`) that call back over an HMAC-authenticated HTTP control plane (`/orchestrator/*`).
- The Redis client is `@valkey/valkey-glide`, a native Rust core over N-API. According to [GLIDE docs](https://glide.valkey.io/overview/), it officially supports Valkey 7.2+ and Redis OSS 6.2–7.2; **Redis 8.x is not in its stated matrix**.

**Strengths (keep these if forking):**
- CSP via helmet: `script-src 'self'`, `object-src 'none'`, no third-party origins (`apps/server/src/index.ts:116-131`).
- WebSocket upgrades refuse a missing or foreign `Origin`; same-origin by default, or an explicit allowlist (`apps/server/src/websocket-origin.ts:62-100`). This mitigates cross-site WebSocket hijacking.
- Session cookie is `HttpOnly; SameSite=Strict`, plus `Secure` behind HTTPS, with a 256-bit random ID (`apps/server/src/session.ts:60-83`). Each WebSocket action is checked against the connections that session owns (`index.ts:352-389`). Cached clients are reused only if the session already owns them, which prevents "credential-blind reuse" (`connection.ts:701-731`).
- Binds to loopback by default outside K8s (`index.ts:221-225`). Rate limits on UI and control-plane routes (`index.ts:75-113`).
- Collector control plane uses per-node HMAC keys (`metrics-orchestrator.ts:78-96`, `:282`, `:345`).
- The React frontend has **no** `dangerouslySetInnerHTML`, `innerHTML` or `eval` sinks (grep of `apps/frontend/src`), so React escaping covers key values. Binary values are escaped for display (`keys-browser.ts:300-318`). Value size is capped by `KEY_VALUE_SIZE_LIMIT_BYTES` (`keys-browser.ts:20`).
- Web mode never persists passwords in plaintext: they are dropped from `localStorage` unless the OS keystore can encrypt them, which is Electron-only (`apps/frontend/src/state/epics/valkeyEpics.ts:54-69`, `state/purgeUnencryptedPasswords.ts`).
- Lockfile: 1,172 packages. Only well-known packages have install scripts (`electron`, `esbuild`, `protobufjs`, `fsevents`, `electron-winstaller`). CodeQL, lint, unit and integration workflows exist in `.github/workflows/`.

**Findings:**

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| F-VA-1 | **Critical** (for our model) | **The browser supplies the connection target and credentials, which makes the server an SSRF client.** `connectPending` takes `connectionDetails` (host, port, credentials and TLS options) straight from the WebSocket payload. There is no host allowlist (grep found none). Any user can make the server open TCP/TLS connections to arbitrary internal hosts and ports. | `apps/server/src/actions/connection.ts:10-27, 36-85`; `connection.ts:176-215` |
| F-VA-2 | **High** | Details withheld until the maintainers have been told (coordinated disclosure). Static review only; not verified dynamically. | — |
| F-VA-3 | High | **No application authentication or authorization.** The docs say Web mode has "no authentication" and no RBAC, and recommend an auth proxy ([limitations](https://valkey-admin.valkey.io/reference/limitations/), [Docker guide](https://valkey-admin.valkey.io/deployment/docker/)). The session cookie only scopes connections to a browser and does not identify a user. | `apps/server/src/session.ts` |
| F-VA-4 | High | Details withheld until the maintainers have been told (coordinated disclosure). Static review only; not verified dynamically. | — |
| F-VA-5 | Medium | Details withheld until the maintainers have been told (coordinated disclosure). Static review only; not verified dynamically. | — |
| F-VA-6 | Medium | Details withheld until the maintainers have been told (coordinated disclosure). Static review only; not verified dynamically. | — |
| F-VA-7 | Low | Collectors receive `VALKEY_PASSWORD` through child-process env (`metrics-orchestrator.ts:557-573`) together with `...process.env`. This is acceptable on one host, but the env is readable by same-user processes. | as cited |
| F-VA-8 | Info | Electron path: per-launch WebSocket token plus loopback-origin check (`websocket-origin.ts:39-89`). Not relevant if we deploy web only; remove Electron from the fork. | |

**Feature gaps relative to our brief (Redis, not Valkey):**
- No Pub/Sub.
- No Sentinel (grep found no `sentinel`).
- Slowlog only through Valkey 8.1 `COMMANDLOG` (no `SLOWLOG` fallback).
- No RediSearch, TimeSeries, Bloom or VectorSet.
- No Workbench-style multi-command editor or results visualisation.
- The key browser samples about 1,000 keys and then relies on search.
- Redis 8 compatibility of GLIDE and of the feature gates is unverified.

### 4.2 P3X Redis UI: `repos/p3x-redis-ui-server` (backend), `repos/p3x-redis-ui-material` (frontend), `repos/p3x-redis-ui` (wrapper)

**Architecture.**
- Node server: express 5 + socket.io. Each request handler is dynamically imported from `request/<area>/<fn>.mjs` and checked against a discovered allowlist (`src/service/socket.io/socket.mjs:7-18, 78-92`).
- The server stores connections in a JSON file. The browser receives the list with secrets stripped (`shared.mjs:65-95`), but can create and edit connections.
- Three separate SPAs (Angular, React, Vue) are maintained in parallel.

**Findings:**

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| F-P3-1 | **Critical** | Details withheld until the maintainers have been told (coordinated disclosure). Static review only; not verified dynamically. | — |
| F-P3-2 | **Critical** | **Third-party data egress is on by default.** `aiEnabled: true` is the shipped default (`p3x-redis-ui/p3xrs.json:25`). The default path posts the conversation to `https://network.corifeus.com/public/ai/redis-query` (`redis-query.mjs:23, 84-99`); `useOwnKey` is false unless configured (`:259-261`). The AI agent runs local "tools" against the live Redis — `INFO`, `SLOWLOG GET` (contains command arguments, often values), `CLIENT LIST` (client IPs and names), `CONFIG GET`, `SCAN` (key names) — and sends their results along (`ai/tools.mjs:35-201`). The console also **auto-forwards failed commands that "look like natural language" to the AI**; auto-detect is on unless disabled (`p3x-redis-ui-material/src/react/pages/console/ConsoleComponent.tsx:47-49, 395-398`). This is exactly the data-leak class the company wants to eliminate. | as cited |
| F-P3-3 | **High** | **Google Analytics/GTM is loaded in the app**, with a CSP that permits `https://www.googletagmanager.com`, `'unsafe-inline'` and `'unsafe-eval'`, plus `connect-src` to google-analytics. A third-party script runs in a page that shows Redis data and keeps the auth JWT in `localStorage`. | `p3x-redis-ui-material/src/index.html:9-20`; `p3x-redis-ui-server/src/service/http/index.mjs:24`; `p3x-redis-ui-material/src/react/stores/auth.store.ts:3, 62` |
| F-P3-4 | High | **Insecure by default.** HTTP auth is `enabled: false` (`p3x-redis-ui/p3xrs.json:17-22`); the server binds `0.0.0.0` (`p3xrs.json:7`; `http/index.mjs:281`); `Access-Control-Allow-Origin: *` on `/api` (`http/index.mjs:39-43`); the socket.io auth middleware is a no-op when auth is disabled (`socket.io/index.mjs:17-30`); `maxHttpBufferSize` is 256 MB (`socket.io/index.mjs:14`), a denial-of-service risk. | as cited |
| F-P3-5 | High | **Unrestricted console.** Only `subscribe`, `monitor`, `quit` and `psubscribe` are blocked. `EVAL`, `FLUSHALL`, `CONFIG SET`, `MODULE LOAD`, `ACL` and so on go straight through `redis.call` (`request/redis/console.mjs:5, 34-45`). The only control is a global read-only flag. | as cited |
| F-P3-6 | Medium | Details withheld until the maintainers have been told (coordinated disclosure). Static review only; not verified dynamically. | — |
| F-P3-7 | Medium | Details withheld until the maintainers have been told (coordinated disclosure). Static review only; not verified dynamically. | — |
| F-P3-8 | Medium | Details withheld until the maintainers have been told (coordinated disclosure). Static review only; not verified dynamically. | — |
| F-P3-9 | Medium | Details withheld until the maintainers have been told (coordinated disclosure). Static review only; not verified dynamically. | — |
| F-P3-10 | High (supply chain) | **Single-maintainer publishing chain.** `p3x-robot` authored 1,292 of 1,308 commits. The server imports the maintainer's own `corifeus-utils` for side effects (`src/lib/boot.mjs:1`) and builds with `corifeus-builder`. The UI is a separate npm package, `p3x-redis-ui-material`. The README advises always running `:latest` with `imagePullPolicy: Always`. About 3,300 yarn lock entries across the three repos. | `p3x-redis-ui-server/package.json`; README |

### 4.3 Redis Commander: `repos/redis-commander` (MIT)

**Architecture.**
- Express 4 with a REST API (`/apiv1`, `/apiv2`), EJS views and jQuery/jsTree.
- Connections come from `config/*.json`, env or CLI. The server-side list is shared by every user.
- Optional HTTP auth issues an HS256 JWT. An **SSO entry point** accepts an externally signed JWT (`lib/app.js:82-100, 189-222`), so it can sit behind a corporate IdP through a small token-minting shim.

**Findings:**

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| F-RC-1 | **High** | **Any user can add connections, causing SSRF and config pollution.** `POST /login` builds a connection from the request body (hostname or Unix socket path, sentinel list, cluster list, TLS keys) and connects. On success it **persists** the connection to the config file unless `noSave` is set. There is no read-only or "lock connections" check. | `lib/routes/home.js:39-114, 116-175`; `lib/app.js:148-151` |
| F-RC-2 | High | **Insecure defaults.** `httpAuth` is empty, so auth is disabled; `address: "0.0.0.0"`; `noLogData: false`; `readOnly: false`. No helmet, CSP, X-Frame-Options or HSTS headers (grep found none). With auth off, the API accepts `application/x-www-form-urlencoded` (`lib/app.js:186`), so cross-site form POSTs to `/apiv2/exec/:id` work as CSRF. | `config/default.json`; `lib/app.js:159, 186-187` |
| F-RC-3 | High | **Unrestricted CLI in read-write mode.** `postExec` blocks only `multi` and `monitor` and passes everything else to `connection.call`. Read-only mode is a reasonable allowlist built from `COMMAND` flags (`isReadOnlyCommand`), but it is global. | `lib/routes/apiv1.js:326-380` |
| F-RC-4 | Medium | **Values logged by default:** `console.log('new value for key: ', value)` (`lib/routes/apiv1.js:1281, 1293`) unless `noLogData` is set. | as cited |
| F-RC-5 | Medium | Details withheld until the maintainers have been told (coordinated disclosure). Static review only; not verified dynamically. | — |
| F-RC-6 | Low | `jwtSecret` defaults to a random value per process (`lib/app.js:160`), which is safe but invalidates sessions on restart. `bcryptjs` 2.4.3 is pinned (old but fine). The `postinstall` script only echoes. 633 packages; install scripts only in `bcrypt` and `libxmljs2`. | |
| F-RC-7 | Info | **Maintenance.** Last commit 2025-09-11 and last release v0.9.1 (2025-07). No Pub/Sub, profiler, JSON/Search modules, memory analysis or modern UX. | GitHub API |

### 4.4 Redis Insight (architecture check only, not a fork candidate)

- Supports server-side pre-configured databases (`RI_REDIS_HOST`/`PORT`/`PASSWORD`/`TLS_*`, `RI_PRE_SETUP_DATABASES_PATH`). With `RI_DATABASE_MANAGEMENT=false`, `DatabaseManagementGuard` blocks add/edit/delete of databases (`redisinsight/api/src/common/guards/database-management.guard.ts`). This is the closest of any candidate to our "server-only credentials" model, and **a good pattern to copy**.
- **No user authentication in Docker mode.** The API is open on `:5540/api` (README §"Redis Insight API").
- Pulls in Redis Cloud OAuth (`RI_CLOUD_IDP_*`), an AI service (`RI_AI_*`) and analytics config. The lockfiles hold 2,468 + 1,199 packages.
- 3.6.0 added "Dev vs Production" database tagging with type-to-confirm for destructive actions on production ([release notes](https://redis.io/docs/latest/develop/tools/insight/release-notes/v.3.6.0/)). **Good UX idea to borrow.**
- No published GHSA. Container and dependency CVEs are tracked by distributions ([Chainguard](https://images.chainguard.dev/directory/image/redisinsight/vulnerabilities)).

---

## 5. Desktop-only tools (adaptability notes)

- **Tiny RDM (GPL-3.0, Go + Vue 3 via Wails).**
  - The Go backend is the natural place for credentials, but it is reached through Wails IPC bindings rather than HTTP.
  - Turning it into a client/server web app would mean replacing the bindings with an authenticated HTTP/WebSocket API, splitting per-user state, and removing local connection storage. That is a large refactor with GPL obligations if ever distributed.
  - Its value-format decoders (JSON, msgpack, gzip, etc.) and its UX are worth studying. (Not cloned or audited.)
- **Another Redis Desktop Manager (MIT, Electron + Vue 2).**
  - `ioredis` runs in the Electron renderer, so there is no client/server split.
  - Vue 2 and element-ui are end-of-life.
  - Has a CVE-2024-23998 XSS with a public PoC.
  - Useful idea: built-in viewers for **Java serialized objects**, msgpack, protobuf, pickle and PHP serialization (`java-object-serialization`, `protobufjs`, `pickleparser` and `php-serialize` in `package.json`). Spring applications often store Java-serialized values, so this is worth supporting.

---

## 6. Hardening effort estimates (to reach the brief's target model)

Assumes one senior full-stack engineer, with Redis Insight-class features as the bar. Rough estimates (±40%).

| Work item | Valkey Admin | P3X Redis UI | Redis Commander |
|---|---|---|---|
| Server-side connection catalog only (UI references a connection ID; delete UI connection creation and every browser-supplied connection field; per-user allowlist) | 1–1.5 wk | 2–3 wk (connection handling is spread across many handlers and SSH tunnels) | 1 wk |
| OIDC/SSO (or oauth2-proxy + trusted header) and per-user sessions | 1 wk | 1.5 wk (replace Basic/JWT) | 0.5–1 wk (reuse SSO-JWT hook) |
| RBAC plus a server-enforced command **allowlist** (per role; deny EVAL/FUNCTION/MODULE/CONFIG SET/ACL/DEBUG/MIGRATE…; confirm-gated writes; prod "type-to-confirm") | 1.5–2 wk | 2 wk | 1.5 wk |
| Audit log (who, which connection, which command, redacted args), log redaction | 1 wk | 1.5 wk | 1 wk |
| Remove third-party egress (GA, AI proxy, Groq) and Electron | 0.5 wk (Electron only) | 1.5–2 wk across 3 UIs | — |
| XSS/CSP cleanup | ~0 (already strict) | 2 wk (3 UIs) | 2–3 wk (jQuery) |
| Dependency pruning, SBOM, pinning, CI security gates | 0.5–1 wk | 1.5 wk | 0.5 wk |
| **Security subtotal** | **≈ 6–8 wk** | **≈ 12–14 wk** | **≈ 8–10 wk** |
| Feature parity with Redis Insight (Pub/Sub, Sentinel, SLOWLOG on Redis, Workbench, Search/TS/Bloom, Redis 8 types, value decoders) | 6–10 wk | 1–2 wk (already rich) | 12+ wk (and a full UI rewrite for acceptable UX) |
| Ongoing upstream merge cost | Medium. The upstream server design (browser-supplied connections) diverges from ours, so fork drift is quick. | High (1 maintainer, monthly churn, 3 frontends) | Low (dormant) |
| **Total to target** | **≈ 3–4.5 months** | **≈ 3.5–4 months, residual supply-chain risk** | **≈ 5+ months, poor result** |

For comparison, the companion architecture doc covers a **from-scratch build**. With a fresh backend designed around the security model from day one, and a frontend seeded from Valkey Admin's Apache-2.0 components (key browser, typed editors, command console, dashboards), effort is likely in the same 3–5 month range. It avoids carrying an upstream threat model that conflicts with ours.

---

## 7. Verdict and recommendation

1. **Do not fork Redis Insight** (SSPL, Redis-Cloud coupling, it is the incumbent being removed). **Do not fork P3X**: default third-party data egress (Google Analytics, AI proxy), a critical credential-handling issue, and one-maintainer supply-chain risk are disqualifying for a security-first program. **Do not fork Redis Commander**: dormant, and its UX is too dated.
2. **Recommended: build from scratch (backend) and borrow Valkey Admin (frontend).**
   - Write our own backend as the single trust boundary. Everything flows from the security model: a server-side connection catalog, OIDC, RBAC, a command allowlist and audit logging. Every candidate's server would need those parts rewritten anyway.
   - Start the UI from Valkey Admin's React 19/TypeScript/Tailwind code (Apache-2.0; keep NOTICE attribution). It already has a strict CSP, no HTML-injection sinks, and a typed key browser, console and dashboards.
   - Take *ideas only* from:
     - **Redis Insight:** Workbench, Profiler, Pub/Sub, memory analysis, Dev/Prod guardrails, and the `RI_DATABASE_MANAGEMENT=false` pattern.
     - **ARDM and Tiny RDM:** value decoders, especially Java serialization for Spring users.
3. **Acceptable alternative:** a **hard fork of Valkey Admin** if the team prefers a running start.
   - On day 1, replace UI-supplied connections with server-owned ones (F-VA-1), replace the blocklist with a server-side allowlist, and put it behind OIDC (F-VA-3) before any non-local deployment.
   - Expect the server to be largely rewritten, and plan for Redis-specific gaps (Pub/Sub, Sentinel, SLOWLOG, modules, Redis 8 compatibility of valkey-glide; consider swapping to `ioredis` or `node-redis`).
4. **Coordinated disclosure:** the findings marked as withheld come from static review only and were not verified
   dynamically. They are to be confirmed and reported privately to the maintainers (P3X: its maintainer; Valkey Admin:
   `security@lists.valkey.io` or a [GitHub security advisory](https://github.com/valkey-io/valkey-admin/security/advisories/new);
   Redis Commander: its maintainers) before any details are published.

---

## 8. Sources

- GitHub API metadata (stars, commits, releases, contributors), queried 2026-10-22, for: [redis/RedisInsight](https://github.com/redis/RedisInsight), [valkey-io/valkey-admin](https://github.com/valkey-io/valkey-admin), [patrikx3/redis-ui](https://github.com/patrikx3/redis-ui), [patrikx3/redis-ui-server](https://github.com/patrikx3/redis-ui-server), [patrikx3/redis-ui-material](https://github.com/patrikx3/redis-ui-material), [joeferner/redis-commander](https://github.com/joeferner/redis-commander), [erikdubbelboer/phpRedisAdmin](https://github.com/erikdubbelboer/phpRedisAdmin), [tiny-craft/tiny-rdm](https://github.com/tiny-craft/tiny-rdm), [qishibo/AnotherRedisDesktopManager](https://github.com/qishibo/AnotherRedisDesktopManager), [libredb/libredb-studio](https://github.com/libredb/libredb-studio), [dromara/mayfly-go](https://github.com/dromara/mayfly-go), [dbgate/dbgate](https://github.com/dbgate/dbgate), [RobiNN1/phpCacheAdmin](https://github.com/RobiNN1/phpCacheAdmin)
- Redis licensing: https://redis.io/legal/licenses/ ; https://redis.io/blog/rsalv2-sspl-announcement/
- Redis Insight release notes: https://redis.io/docs/latest/develop/tools/insight/release-notes/ (3.6.0, 3.8.0)
- Redis Insight dependency CVEs: https://images.chainguard.dev/directory/image/redisinsight/vulnerabilities ; https://osv.dev/vulnerability/CGA-g599-6c37-mmm7
- Valkey Admin docs: https://valkey-admin.valkey.io/reference/limitations/ ; https://valkey-admin.valkey.io/deployment/docker/
- Valkey GLIDE supported engines: https://glide.valkey.io/overview/
- Redis Commander advisory: https://github.com/advisories/GHSA-8c8c-4vfj-rrpc ; https://mend.io/vulnerability-database/WS-2018-0014/
- phpRedisAdmin CVEs: https://nvd.nist.gov/vuln/detail/CVE-2020-27163 ; https://nvd.nist.gov/vuln/detail/cve-2021-4259 ; https://nvd.nist.gov/vuln/detail/cve-2021-4268
- ARDM CVE: https://osv.dev/vulnerability/CVE-2024-23998 ; https://www.tenable.com/cve/CVE-2024-23998
- Market roundups used to discover candidates (vendor-written, treated as low-trust): https://www.dragonflydb.io/guides/top-open-source-redis-desktop-managers ; https://1bench.dev/alternatives/redisinsight
