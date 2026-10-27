# Security

Redis Console exists because desktop and third-party Redis GUIs hold production credentials on laptops, talk to Redis directly and can leak data. Security is the product. This document summarizes the threat model, lists every control, and says **how each control is tested**. The design is in [ARCHITECTURE.md](ARCHITECTURE.md), the reasons in [DECISIONS.md](DECISIONS.md), deployment hardening in [INSTALL.md](INSTALL.md#13-hardening-checklist).

## Reporting a vulnerability

Do **not** open a public issue. Report it privately through the repository's GitHub security advisories (**Security → Report a vulnerability**); if that isn't available to you, contact the maintainers privately and ask for a channel. Include:

- the affected version or commit, and your configuration (redact secrets)
- the steps to reproduce, and the impact you observed
- whether you have shared the issue with anyone else

We aim to acknowledge reports within 2 business days. Please allow 90 days (or until a fix ships, if that is sooner) before disclosure. Never test against databases you don't own: use the local sandbox (`scripts/dev-setup.sh`).

## Threat model (summary)

**Assets:** Redis data, including PII held in keys and values; Redis credentials; the OIDC client secret; user sessions; the audit trail; and Redis availability.

**Trust boundary:** the server (`apps/server`) is the only component that holds secrets or talks to Redis. The browser is untrusted, and so is everything Redis returns (keys and values can contain attacker-controlled content).

| # | Threat | Actor | Main controls |
|---|---|---|---|
| T1 | Credential theft from a client device (the risk that comes with desktop GUIs) | Malware or a lost laptop | Credentials exist only on the server. The browser gets a session cookie and a CSRF token, nothing else. |
| T2 | Credentials, connection URLs or Redis data leaking through the API, the UI, URLs, logs or errors | Any user, log readers | Secret references only; URLs can't contain credentials; databases are exposed by ID only; no Redis data in URLs; log and audit redaction; Redis error text reduced to its code in logs; an automated leak scan of every response and of the server log. |
| T3 | Privilege escalation (a viewer writing, an operator administering, anyone running Lua, CONFIG SET or MODULE LOAD) | Malicious or curious user | The server command policy (fail-closed), effective role = min(user, db.maxRole), `readOnly`, **and** a per-tier Redis ACL user underneath. |
| T4 | Accidental destruction (FLUSHDB, mass DEL, prod writes) | Well-meaning user | Two-step confirmations bound to the session and request, typed database name, a mandatory reason on prod, impact preview for bulk delete, FLUSHALL blocked, FLUSHDB refused on prod. |
| T5 | XSS through hostile keys and values | Anyone who can write to Redis | Data is never rendered as HTML, React escaping, strict CSP (`script-src 'self'`, nonce-only styles, `require-trusted-types-for 'script'`), no URL navigation built from data. |
| T6 | CSRF, clickjacking, cross-origin reads | A malicious website | SameSite=Strict cookie, a per-session `X-CSRF-Token`, an exact `Origin` check, JSON-only bodies, no CORS, `frame-ancestors 'none'`, COOP and CORP same-origin. |
| T7 | SSRF or pivoting through the console | Malicious user | The browser can't choose host, port or TLS. MIGRATE, REPLICAOF, MODULE and similar commands are blocked. The NetworkPolicy example restricts egress. |
| T8 | Account takeover | External attacker | OIDC (code + PKCE + state + nonce), argon2id, per-user lockout plus a global login rate limit, TOTP (replay-protected) required for privileged local roles, single-use recovery codes stored as argon2id hashes (same lockout and rate limits), TOTP seeds encrypted under a rotatable key ring that fails closed, session rotation, idle and absolute timeouts, generic login errors. |
| T8b | Stale authority: a revoked, disabled or demoted user keeps acting through requests already in flight or queued | Insider, compromised account | Auth generation per account; session and account re-checked when headers arrive, after the body, after any wait, and synchronously with the write of every non-read Redis command (including MOVED/ASK re-dispatch); long jobs re-check between commands. |
| T9 | Denial of service on Redis or the console | Malicious or careless user | KEYS blocked, SCAN COUNT and time budget, command timeout, blocking commands capped, replies measured and capped on the wire (no size prediction), global and per-user command budgets with bounded wait queues, request-body budgets reserved before reading, per-user rate limits, stream count and duration limits, bounded jobs, `MEMORY USAGE … SAMPLES 5` for key sizes. |
| T10 | Repudiation and insider misuse | Insider | Append-only audit of every command and auth event, with redacted argv (no values), reasons for prod writes, and JSON lines for the SIEM. SQLite keeps `audit.retentionDays` (365 by default); only an audited retention job may delete older rows, never rows younger than 30 days. |
| T11 | Supply chain | Compromised dependency | Few dependencies, pinned exactly, lockfile, `onlyBuiltDependencies` allowlist, `pnpm audit` and a CycloneDX SBOM in CI, no runtime fetches, a minimal non-root image without package managers. |

Out of scope: a compromised server host or Redis host, and malicious administrators of the IdP.

## Controls and how they are tested

The end-to-end suite (`tests/e2e`, Playwright) runs against the real server with the built SPA, in the production-style single-origin setup. It uses real Redis 8 instances with per-tier ACL users and a real Keycloak. Spec paths below are relative to `tests/e2e/specs/`.

### Secrets never reach the browser (T1, T2)

| Control | Test |
|---|---|
| Config accepts secrets only as `{env}`/`{file}` references. Redis URLs with credentials are rejected at startup. | Server unit tests (`apps/server`). |
| With `NODE_ENV=production`, prod databases must use TLS (`rediss://`) and per-tier ACL users, unless `acceptRisks` lists a reviewed exception. The `deploy/` examples comply and use `trustProxy` as a hop count. | Server unit tests, and `api/deploy-config.spec.ts`, which validates the shipped examples with the real config loader. |
| `GET /databases` exposes ID, name, environment and role only, never the URL, host, port or credentials. | `api/role-matrix.spec.ts` › *database list exposes no connection details* |
| **Leak scan:** every JSON, HTML and SSE response received during the whole e2e run (API client, browser pages and `EventSource` messages) is checked against every value in `.env` (Redis passwords, OIDC client secret, session secret, Keycloak passwords, bootstrap password) plus every password and TOTP secret created during the run, and against `redis://` / `rediss://` URLs. A hit fails the test that made the request. | `lib/leak.ts`, `lib/api.ts`, `lib/test.ts`, and `final/summary.spec.ts` › *no finding across every collected response* |
| No Redis data in URLs, where proxies, load balancers and APM agents log it. Key names, patterns, channels and groups travel in POST bodies. Query parameters such as `k`, `match` or `channel` are refused with 400 before authentication. Pub/sub streams use single-use subscription IDs bound to the session and the database. The SPA's own requests are checked too. | `api/no-data-in-urls.spec.ts`, `api/features.spec.ts` › *subscription ids are single-use…* |
| Logs never contain secrets, session IDs, CSRF tokens or Redis values. | `final/summary.spec.ts` › *server log contains no secrets…*, which scans the captured stdout and stderr of the server under test, including audit lines, for `.env` values, fixture values, XSS payloads, cookies and URLs with credentials. |

### Authorization and command policy (T3, T7)

| Control | Test |
|---|---|
| Every route × {anonymous, viewer, operator, admin} returns the expected status. A guard test fails if a route is added to `ROUTES` without a matrix row. | `api/role-matrix.spec.ts` |
| Effective role = min(user role, `maxRole`). | `api/role-matrix.spec.ts` (the read-only `remote-6390` test target caps every role at viewer) |
| Blocked commands (EVAL, EVALSHA, FUNCTION, SCRIPT, KEYS, CONFIG SET, FLUSHALL, MODULE LOAD, MULTI, SELECT, MIGRATE, DEBUG, SHUTDOWN, ACL SETUSER, CLIENT SETNAME, …) are refused **for admin** in upper, lower and mixed case, through `line`, `argv` and binary `argvBin`, and per line in the workbench. | `api/blocked-commands.spec.ts`, `ui/console.spec.ts` |
| Tokenizer tricks (quotes, `\x46LUSHALL` escapes, full-width letters, zero-width characters, NUL, CRLF injection) don't bypass the policy. | `api/blocked-commands.spec.ts` › *tokenizer tricks*, *newline injection* |
| Unknown commands fail closed. | `api/blocked-commands.spec.ts` (`FOOBARNOTACOMMAND`) |
| Blocked attempts are audited as `denied`. | `api/blocked-commands.spec.ts` › *audited as denied* |
| `readOnly` databases reject every write path (typed ops, CLI, workbench, bulk delete, publish, slowlog reset, client kill) for every role including admin, and never offer a confirmation challenge. A confirmation token from another database can't unlock them. | `api/readonly-prod.spec.ts`, `ui/readonly.spec.ts` |
| **Only read commands reach the read-only target.** In the e2e setup, `remote-6390` is reached through a RESP proxy (`lib/readonly-proxy.ts`). It forwards only commands Redis flags `readonly`, plus a short allowlist of connection and introspection commands. Anything else is dropped and recorded. The upstream is a disposable seeded Redis, or an external read-only dataset when `RC_E2E_REMOTE_HOST`/`RC_E2E_REMOTE_PORT` are set. | `api/readonly-prod.spec.ts` and the read-only proxy assertion in `final/summary.spec.ts` |
| Every write and admin command is re-checked against the actor right before it is sent; a revoked user's queued command is never sent. | Server `test/integration/review-v02-n1.test.ts`, `test/unit/review-n1.test.ts`, `test/integration/topology.test.ts` (cluster and Sentinel re-dispatch) |
| Redis ACL users per tier (defense in depth). | The sandbox and CI run with `infra/redis/users.acl.template`; production config refuses prod databases without per-tier users (`test/unit/config.test.ts`). |

### Destructive operations (T4)

| Control | Test |
|---|---|
| A 428 challenge is returned first. The token is single-use, bound to the session and the exact request, and forged or malformed tokens are rejected. | `api/confirmation.spec.ts` |
| Prod writes require the typed database name **and** a reason. The reason is written to the audit log. | `api/confirmation.spec.ts` › *prod write*, `ui/confirmation.spec.ts` |
| FLUSHDB requires typing the database name, and is refused on prod. | `api/confirmation.spec.ts` |
| Bulk delete always shows the impact (count and sample) first, honors the type filter and deletes exactly the matching keys. | `api/confirmation.spec.ts` › *bulk delete*, `ui/bulk-delete.spec.ts` |
| The confirmation preview lists the exact commands that will run, built from the same argv. | Server `test/unit/preview.test.ts`, `test/integration/confirm-preview.test.ts` |
| Edits that replace data are compare-and-set: a concurrent change gives 409 and nothing is written. | Server `test/integration/checked-edits.test.ts` |

### Browser hardening (T5, T6)

| Control | Test |
|---|---|
| CSP exactly per ARCHITECTURE.md, with a fresh nonce on each request that matches `<meta name="csp-nonce">`, no `unsafe-*` sources and no inline scripts. | `api/headers.spec.ts` |
| **No CSP or Trusted Types violations on any page.** Every UI test records `securitypolicyviolation` events, console errors and page errors, and fails on any of them. | `lib/test.ts` (applies to every `ui/*.spec.ts`) |
| `X-Content-Type-Options`, `Referrer-Policy`, COOP, CORP, `Permissions-Policy`, `Cache-Control: no-store` on the API, no version banner, no published source maps, and no dotfile or config exposure. | `api/headers.spec.ts` |
| Clickjacking: the app refuses to render in an iframe. | `api/headers.spec.ts` › *frame-ancestors none blocks framing* |
| Cookie: HttpOnly, SameSite=Strict, Path=/, 256-bit value. | `api/headers.spec.ts` › *session cookie flags* |
| CSRF: a missing, empty, wrong or other user's token is rejected; foreign, `null`, prefix-trick or missing `Origin` is rejected; `text/plain` and form bodies are rejected; there is no permissive CORS; state changes are impossible via GET. Login CSRF is covered too. | `api/csrf.spec.ts` |
| XSS: fixtures with hostile keys and values (`<img onerror>`, `<script>`, `<svg onload>`, `javascript:` URLs, iframes `srcdoc`, template injection, CSS `@import`) are rendered in the key list, every value viewer, the console, the workbench, streams, pub/sub and search. No dialog opens, `window.__xss` stays unset, and no injected elements appear in the DOM. | `ui/xss.spec.ts` |

### Authentication and sessions (T8)

| Control | Test |
|---|---|
| Bootstrap admin: forced password change, then forced TOTP enrollment. Every other API returns 403 until both are done. | `setup/bootstrap.setup.ts`, `ui/auth.spec.ts` |
| TOTP seeds are encrypted at rest (AES-256-GCM, user id bound); clear-text seeds are migrated; startup is refused if a seed doesn't decrypt. | Server `test/unit/totp-at-rest.test.ts` |
| TOTP: a wrong code is refused, a replayed code is refused, and a session with TOTP pending can't use the API. Codes are computed in the test (RFC 6238). | `api/auth.spec.ts`, `ui/auth.spec.ts` |
| Recovery codes: shown once at enrollment (copy, local download), a code signs in once, regenerating revokes the old set, the count and a low-count warning show in Account, `auth.recovery` is audited without codes, and the codes never appear in later responses or the server log. | `ui/recovery-codes.spec.ts`, `final/summary.spec.ts` |
| Lockout after repeated failures (the correct password is refused while locked), and the lockout is audited. | `api/auth.spec.ts`, `ui/auth.spec.ts` |
| Generic login errors (no user enumeration). | `api/auth.spec.ts` |
| Session rotation on login (no fixation), and revocation on logout, password change, disable and role change. | `api/auth.spec.ts`, `api/features.spec.ts` › *user management* |
| Idle and absolute session expiry (simulated by aging the server-side session row). | `api/auth.spec.ts` |
| OIDC via Keycloak: viewer, operator and admin each get the mapped role. A user without a mapped group is refused. | `ui/oidc.spec.ts` |
| Login rate limit (global). | `api/rate-limit.spec.ts` |

### Availability (T9)

| Control | Test |
|---|---|
| Per-user rate limits (CLI, scan) return 429 `rate_limited` and recover; another user is not affected. | `api/rate-limit.spec.ts` |
| Large values are truncated at `maxValueBytes` and report the total size; large hashes and lists are paged. | `api/keys.spec.ts`, `ui/keys.spec.ts` › *large value* |
| Replies are measured on the wire and capped; overflow closes only that socket (413). Budgets and queues are bounded. | Server `test/unit/resp.test.ts`, `test/unit/capped.test.ts`, `test/integration/replycap.test.ts`, `test/unit/review-r4.test.ts`–`review-r6.test.ts` |
| A 12 MB JSON body limit. | `api/keys.spec.ts` |
| Blocking-command timeout cap, SCAN COUNT cap, analysis sample cap, pub/sub channel limit, and profiler duration and environment limits. | `api/blocked-commands.spec.ts`, `api/features.spec.ts` |

### Audit (T10)

| Control | Test |
|---|---|
| Entries exist for auth, commands, confirmations, the profiler and admin actions. | `api/features.spec.ts` › *audit log* |
| argv is redacted: a canary value written through the CLI and through typed ops never appears in the audit API, the UI or the server log; key names are hashed; values become `<n bytes>`. | `api/features.spec.ts`, `ui/admin.spec.ts`, `final/summary.spec.ts` |
| Audit JSON lines (`"audit": true`) are written to stdout for the SIEM. | `final/summary.spec.ts` |

### Supply chain and deployment (T11)

| Control | Where |
|---|---|
| Frozen lockfile, typecheck, unit and integration tests (including cluster, Sentinel and mutual TLS), `pnpm audit`, a CycloneDX SBOM, an image build and the e2e suite, on GitHub-hosted runners without external data. | `.github/workflows/ci.yml` |
| The image is non-root, has no package managers, is friendly to a read-only root filesystem, and won't start without a valid config. | `Dockerfile`; smoke test in CI (`image` job) |
| Kubernetes: restricted Pod Security, a securityContext, NetworkPolicy default-deny, and secrets as files. | `deploy/k8s/` |

### v0.4 FalkorDB graph boundary

- GRAPH commands are explicitly classified; future commands fail closed. QUERY/PROFILE require an operator and
  confirmation on every call; GRAPH.DELETE requires admin and typed confirmation (operators can still remove graph data
  with DEL, RENAME or Cypher, confirmed like other deletes). Read-only/maxRole/prod restrictions,
  exact-request confirmation binding, measured transport and late actor checks apply normally.
- Cypher LOAD (server file/URL loaders), unreviewed CALL procedures and namespaced/quoted function calls (including
  preloaded JS UDFs) are refused server-side for QUERY, RO_QUERY, EXPLAIN and PROFILE. UDF, binary BULK/RESTORE,
  internal commands and CONFIG SET are disabled. INFO exposes only ObjectPool; GRAPH.SLOWLOG and config reads require
  admin. The core slow log (console `SLOWLOG GET` and Diagnostics) shows non-admins command names and keys only, other
  arguments as their size, so other users' Cypher and values stay with admins (review v0.4 r2 graph M2).
- The app adds TIMEOUT <=1000 ms and the sandbox sets TIMEOUT_DEFAULT/MAX 1000, RESULTSET_SIZE 10000 and
  MAX_QUEUED_QUERIES 25, but FalkorDB checks the timeout **between steps**: one expression (a `reduce` over a long
  `range`) ran 13–16 s, and closing the socket does not stop it (review v0.4 r2 graph H2). The console therefore holds a
  graph query's slots until the engine answers: the console starts at most one graph query per user and two per database entry at a time (fewer on a small connection pool), counted until the engine answers or for at most 15 minutes; it does not count other database entries for the same engine, other console instances or other clients (review v0.4 r3 graph L1). One query's CPU and memory
  are bounded only by the deployment:
  `QUERY_MEM_CAPACITY` does not count list building in 6.0.3 (a 40,000,000-element `range` passed a 256 MiB cap), so
  give the graph server a container memory limit, and where viewers are not trusted with engine time, withhold
  `+graph.ro_query` from the viewer ACL or cap the database with `maxRole`. A timeout is not a rollback guarantee. Raw
  replies still have measured byte, element and depth limits.
- `IMPORT_FOLDER` points at a directory that does not exist, so LOAD CSV reads nothing even if a query got past the
  guard; the guard ends comments where FalkorDB does (a lone CR in a `//` comment hid code from it before review v0.4 r2
  graph H1) and a differential test compares its verdicts with what the engine plans.
- The SVG diagram and result/plan tables render data as text, with fixed node/edge/row/depth bounds, keyboard
  selection and no network access. Unknown/compact reply shapes fall back to the generic view.

Tests: shared `graphPolicy.test.ts`, server unit `graph-policy.test.ts`, server integration `graph.test.ts`, web
`graph.test.tsx`, e2e `ui/graph.spec.ts`, and `qa/graph-live.browser.spec.ts` (local and Keycloak roles). Evidence and
cleanup: [v04-graph.md](qa/v04-graph.md). The lexical guard's deliberate conservative restrictions are in D21;
it does not attempt to parse arbitrary Cypher or infer whether a query writes.

## Known limitations

- With only a `default` Redis credential for a database, the server policy is the only enforcement layer. Use per-tier ACL users.
- SQLite state means a single replica. High availability is "restart quickly" plus backups. Rate limits, confirmation tokens and jobs are in memory, per instance.
- OIDC roles are read at sign-in. Removing someone from an IdP group takes effect at their next sign-in (bound it with `auth.oidc.sessionTtlMinutes`); there is no back-channel logout.
- Closing a socket bounds the console's memory but doesn't stop work Redis already started or undo a mutation that was sent. Replies the client library reads itself (handshake, `CLUSTER SLOTS`, Sentinel) are not size-measured; use verified TLS outside trusted networks.
- A `server.trustProxy` hop count trusts whatever connects to the app port, so a client that can reach the port without the proxy can choose the address the audit log and the per-address limits see. Use a hop count only when the port is reachable through the proxy chain alone (the `deploy/` examples ensure that); otherwise set the proxy's address or a narrow CIDR, which ignores `X-Forwarded-For` from anyone else. See [INSTALL.md](INSTALL.md#setting-trustproxy).
- If the TOTP encryption key is lost or changed, the server refuses to start until the key is restored or the seeds are cleared (deliberate; see DECISIONS D07).
- The console blocks MULTI/EXEC and Lua by design. Workflows that need atomic scripts belong in application code, not in an admin UI. The server itself uses WATCH/MULTI/EXEC (never Lua) only for its own compare-and-set edits, with a fixed command it builds, on the caller's tier (which therefore needs `+@transaction`).
- Compare-and-set compares bytes. A list element is identified by its index and bytes, so an LPUSH/LPOP pair that leaves equal bytes at that index is not detected; renames and deletes of collections compare the type only. Ops without compare-and-set (TTL, element removals, adds) refuse an `expect` field with 400 rather than ignoring it.
- Review findings and their verdicts are in [REVIEW-LOG.md](REVIEW-LOG.md); e2e findings in [E2E-FINDINGS.md](E2E-FINDINGS.md).
