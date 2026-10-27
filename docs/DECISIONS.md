# Decisions

Why Redis Console is built the way it is. The design itself is in [ARCHITECTURE.md](ARCHITECTURE.md); the evidence
behind most entries is in [research/](research/README.md) and [REVIEW-LOG.md](REVIEW-LOG.md).

## Intent

Developers needed a Redis GUI for shared and production databases. The tool they had, Redis Insight, and the other
desktop or self-hosted GUIs put Redis credentials on laptops or in the browser, let the user choose any host,
expose an unrestricted command line, and have no single sign-on, roles or audit trail. Some send data to third parties.

Redis Console replaces that with a web console where **security is the product**:

- credentials and connections exist only on the server;
- every command passes a server policy **and** runs as a Redis ACL user for the caller's role;
- destructive and production actions are confirmed against a preview the server builds;
- everything is audited without storing values;
- nothing leaves the deployment: no telemetry, no AI, no external fetches.

Within those limits it aims to be at least as pleasant as Redis Insight for daily work: find a key fast, understand
it, change it safely, on the right database.

Each entry below: context, decision, alternatives considered, consequences, and where the evidence is. Status is
"accepted" unless stated otherwise.

- [D01. Replace Redis Insight, and build rather than adopt or fork](#d01-replace-redis-insight-and-build-rather-than-adopt-or-fork)
- [D02. A Node/Fastify server plus a static React SPA, not Next.js](#d02-a-nodefastify-server-plus-a-static-react-spa-not-nextjs)
- [D03. Credentials and connections live on the server only](#d03-credentials-and-connections-live-on-the-server-only)
- [D04. Per-role Redis ACL users as a second enforcement layer](#d04-per-role-redis-acl-users-as-a-second-enforcement-layer)
- [D05. A fail-closed command policy](#d05-a-fail-closed-command-policy)
- [D06. Confirmations with server-built previews; reasons on production](#d06-confirmations-with-server-built-previews-reasons-on-production)
- [D07. OIDC plus local accounts with TOTP; seeds encrypted at rest](#d07-oidc-plus-local-accounts-with-totp-seeds-encrypted-at-rest)
- [D08. SQLite for sessions, users and audit](#d08-sqlite-for-sessions-users-and-audit)
- [D09. No AI, no telemetry, no external calls](#d09-no-ai-no-telemetry-no-external-calls)
- [D10. Measure replies instead of predicting their size](#d10-measure-replies-instead-of-predicting-their-size)
- [D11. Re-check the actor when a command is dispatched](#d11-re-check-the-actor-when-a-command-is-dispatched)
- [D12. Compare-and-set for edits that replace data](#d12-compare-and-set-for-edits-that-replace-data)
- [D13. Names-only key scanning with lazy metadata; `MEMORY USAGE … SAMPLES 5`](#d13-names-only-key-scanning-with-lazy-metadata-memory-usage--samples-5)
- [D14. Strict CSP with a nonce and Trusted Types; byte-exact display](#d14-strict-csp-with-a-nonce-and-trusted-types-byte-exact-display)
- [D15. No Redis data in URLs, logs or browser storage](#d15-no-redis-data-in-urls-logs-or-browser-storage)
- [D16. Cross-model review loops and mandatory live testing](#d16-cross-model-review-loops-and-mandatory-live-testing)
- [D17. Redis Insight parity: what we kept, matched and left out](#d17-redis-insight-parity-what-we-kept-matched-and-left-out)
- [D18. Client addresses behind proxies: a hop count or the proxy's address](#d18-client-addresses-behind-proxies-a-hop-count-or-the-proxys-address)
- [D19. Audit retention in SQLite: a bounded, audited exception to append-only](#d19-audit-retention-in-sqlite-a-bounded-audited-exception-to-append-only)

---

## D01. Replace Redis Insight, and build rather than adopt or fork

**Context.** Redis Insight is a desktop or self-hosted app where each user adds connections with credentials; its
license is SSPL-1.0. The requirement: no Redis credentials or direct connections in the browser or on laptops, SSO
with roles, a governed command line, and an audit trail, with UX close to Redis Insight.

**Decision.** Build a new server (the security core) and a new web app. Borrow ideas by looking only; copy no code
from SSPL or GPL projects.

**Alternatives.**
- *Adopt an open-source GUI* (P3X Redis UI, Redis Commander, phpRedisAdmin, Tiny RDM, Another Redis Desktop Manager,
  RedisWebManager). Ruled out: browser-supplied hosts and passwords (SSRF and credential exposure), unrestricted or
  bypassable command blocklists, no SSO or RBAC; P3X sends console input and Redis output to its maintainer's server;
  Redis Commander logs values; Tiny RDM and ARDM are desktop-only.
- *Fork Valkey Admin* (Apache-2.0, React 19 + a small Node server): the most credible fork, but browser-chosen
  connections that make the server an SSRF client, no authentication, and Valkey-only coverage. Its server
  would have been rewritten anyway. The web app was written from scratch too.
- *A multi-database platform* (LibreDB Studio, CloudBeaver, DbGate, Bytebase) or *an access gateway* (Teleport,
  Boundary, Infisical, Vault): either not Redis-focused, open-core for the needed controls, or a network/credential
  layer without a governed Redis console.
- *Fork Redis Insight*: SSPL obligations and corporate bans on SSPL, and it is the tool being replaced.

**Consequences.** We own every line, including the security bugs; hence the review loops (D16) and the test gates.
Feature parity had to be earned (D17).

**Evidence.** [01](research/01-oss-alternatives-audit.md), [02](research/02-secure-architecture.md),
[03a](research/03a-web-guis.md), [03b](research/03b-platforms.md), [03c](research/03c-gateways.md),
[03d](research/03d-adaptable-and-ideas.md), [04](research/04-shortlist.md).

## D02. A Node/Fastify server plus a static React SPA, not Next.js

**Context.** The process that holds production Redis authority should have as little server-side surface as possible.
Research 02 recommended a static SPA on the same origin as a small backend, and listed Go (default), Node/Fastify
(for a Node team) and Spring. Next.js's server features (RSC, Server Actions, middleware, image optimisation) had a
string of critical advisories in 2025–2026 and add nothing to an internal console.

**Decision.** Node 24 + Fastify 5 + node-redis, with TypeScript run directly by Node's type stripping (no build step,
erasable syntax only). React 19 + Vite, built to static files served by the same server. One shared TypeScript package
for the API contract and the command rules.

**Alternatives.** Go (smaller runtime, but a second language for one team and no shared contract with the UI); Spring
(heavier, a platform we don't run); Next.js full-stack (more server surface; rejected); a separate static host (a
second origin means CORS and cookie complexity).

**Consequences.** One origin: no CORS, `SameSite=Strict` cookies, a simple CSP. The npm dependency graph needs
discipline: exact versions, a frozen lockfile, install scripts only for an allowlist, `pnpm audit` and an SBOM in CI,
Node built-ins preferred (`node:sqlite`, `crypto.argon2`, `fetch`). Event-loop blocking must be avoided in parsers and
jobs (imports plan in chunks that yield).

**Evidence.** [02 § 4](research/02-secure-architecture.md#4-architecture-and-stack-decision).

## D03. Credentials and connections live on the server only

**Context.** Credentials on laptops (desktop GUIs) and browser-chosen hosts (web GUIs) were the core problem; a
host field in a web app is an SSRF primitive that can reach cloud metadata services and internal systems.

**Decision.** Databases are defined only in the server configuration: hosts, ports, TLS, logical database,
environment, read-only flag, maximum role and per-tier credentials. Credentials are `{env}` or `{file}` references,
never inline; URLs may not contain credentials, paths or queries. The browser refers to a database by id. Cluster
redirects are followed only to known primaries.

**Alternatives.** User-added connections with server-side storage (still lets users choose targets); per-user
credentials (no SSO mapping, credentials still handled by people).

**Consequences.** Adding a database is a configuration change and a restart, done by operators. `SELECT`, `MOVE`,
`SWAPDB` and `COPY … DB` are blocked because the logical database is configuration too. The config refuses unsafe
production setups (plaintext prod databases, shared or default ACL users) unless a reviewed `acceptRisks` entry says
otherwise.

**Evidence.** [01 § 1](research/01-oss-alternatives-audit.md), [02 § 1, § 6](research/02-secure-architecture.md),
REVIEW-LOG "Round 1 – server" M4.

## D04. Per-role Redis ACL users as a second enforcement layer

**Context.** An application policy is one bug away from failing. Redis has ACLs that can enforce most of the same
rules independently.

**Decision.** Every database has one ACL user per role tier (viewer, operator, admin). Each request connects as the
user of the caller's *effective* role (min(user role, `maxRole`)). A missing tier never falls back to another tier's
user; it gets 503. Production databases must have a distinct user for each reachable tier.

**Alternatives.** One shared service user (simpler, but the app becomes the only control); short-lived ACL users per
session through Vault's Redis secrets engine (stronger, but adds Vault as a dependency; a possible future option).

**Consequences.** Operators create three ACL users per database (the exact lines are in INSTALL.md). Some features need
explicit grants (`+@transaction` for compare-and-set; `+ft.create` for operators to create indexes). The UI shows
Redis's `NOPERM` instead of hiding it, so a stricter ACL simply narrows what works.

**Evidence.** [02 § 1 invariant 4, § 5](research/02-secure-architecture.md), `infra/redis/users.acl.template`,
CONTRACT-REQUESTS-web "app policy versus Redis ACL capability".

## D05. A fail-closed command policy

**Context.** GUIs we audited used blocklists, which miss new commands, aliases, module commands and tokenizer tricks.

**Decision.** Classify every command as read, write, admin, dedicated or blocked: reviewed static rules first, then
the database's own `COMMAND INFO` flags and categories. Anything unknown or unclassifiable is blocked. Lua, Functions,
MULTI/EXEC, MODULE, KEYS, FLUSHALL, CONFIG SET, replication and persistence control are blocked for everyone. Caps
are applied to argv (blocking timeouts, SCAN COUNT, glob wildcards). The same classification runs for the console,
the workbench and imports.

**Alternatives.** A blocklist (bypassable); an allowlist of a few hundred commands only (breaks module and newer
commands, needs constant updates); allowing Lua with review (a script bypasses every per-command rule).

**Consequences.** New Redis commands work as soon as Redis reports them as read or write. Some useful admin commands
are unavailable in the console by design. Atomic scripts belong in application code.

**Evidence.** [01 § 4](research/01-oss-alternatives-audit.md), `tests/e2e/specs/api/blocked-commands.spec.ts`
(case variants, escapes, full-width letters, zero-width characters, NUL, CRLF), REVIEW-LOG rounds 1–5.

## D06. Confirmations with server-built previews; reasons on production

**Context.** Most incidents with admin tools are accidents. A client-side "are you sure?" can be skipped by any
caller and can show something different from what runs.

**Decision.** The server decides when a confirmation is needed and answers 428 with a preview of the exact commands it
will run (built from the same argv), the impact for bulk deletes (count and sample), and a single-use token bound to
the session and a hash of the request, valid two minutes. Typed confirmations require the database name. **Every write
on a production database** requires the typed name and a reason, which is audited. FLUSHALL is blocked; FLUSHDB is
admin-only, typed, and refused on production.

**Alternatives.** Client-only dialogs; confirmations without previews; a separate approval workflow (heavier, possibly
later).

**Consequences.** Every write path, including imports and typed operations, shares one confirmation mechanism.
Previews go only to the requesting user and are never stored.

**Evidence.** [02 § 5](research/02-secure-architecture.md#destructive-workflows-and-production-policy),
[research/05](research/05-web-review.md) M1 (dialogs that didn't say what would be destroyed), `tests/e2e/specs/api/confirmation.spec.ts`.

## D07. OIDC plus local accounts with TOTP; seeds encrypted at rest

**Context.** Companies want SSO with group-based roles; small teams and break-glass access need local accounts.
Local accounts need a second factor. A copy of the database or a backup should not reveal second factors.

**Decision.**
- OIDC (authorization code + PKCE + state + nonce, confidential client); roles from a groups claim; users without a
  mapped group are refused. Tokens never reach the browser.
- Local accounts with argon2id, lockout, and TOTP required for the configured roles (recommended: admin and operator).
- TOTP seeds encrypted with AES-256-GCM under an HKDF-derived key from `auth.local.totpEncryptionKey`, with the user id
  as additional data.
- **Final (owner decision, Option A): the server refuses to start when any stored TOTP seed cannot be decrypted with
  the configured keys.**

**Alternatives for an undecryptable seed.**
- *Start and lock the affected accounts.* Rejected: it hides the problem and can lock out every local admin at once.
- *Start and treat the accounts as not enrolled.* Never acceptable: anyone who knows the password could then enroll
  their own authenticator.

**Companions (v0.3).** Refusing to start is only safe if
operators have clean ways to rotate keys and recover users:
- **Key ring with key IDs:** `auth.local.totpEncryptionKeys: [{ id, secret }]` plus
  `auth.local.totpPrimaryKeyId`. The primary key encrypts new seeds; retired keys only decrypt; seeds are re-encrypted
  to the primary at startup, so rotation never forces re-enrollment. This follows the Google Tink keyset and ASP.NET
  Data Protection key-ring model. The single `totpEncryptionKey` stays supported.
- **Recovery codes:** ten single-use codes (60 random bits each), shown once at enrollment, stored as argon2id hashes,
  compared in constant time and consumed atomically; regenerable from Account with the password; sign-in accepts one
  instead of a TOTP code. This follows Google, Microsoft and GitHub backup codes.
- **Break-glass CLI on the server host:** `node apps/server/src/cli/admin.ts status | reset-totp --user <name> |
  reset-totp --all --yes | rotate-totp-key` (or `pnpm --filter @rconsole/server admin …`, bin `rconsole-admin`). Reset
  clears seeds and recovery codes and revokes sessions; rotation re-encrypts under the primary; both are audited.
  `status` and `reset-totp` work without any key, so a lost key is always recoverable.

**Consequences.** Rotation never forces re-enrollment; losing every key means `admin reset-totp` and re-enrollment
(OPERATIONS.md § 6a). Keys must be backed up apart from the data directory. OIDC roles are read at sign-in; a shorter OIDC session
lifetime bounds stale roles.

**Evidence.** [E2E-FINDINGS.md](E2E-FINDINGS.md) F-05 (seeds in clear text, fixed), [02 § 5](research/02-secure-architecture.md#authentication-and-sessions),
`apps/server/src/security/totpCipher.ts`.

## D08. SQLite for sessions, users and audit

**Context.** The server needs durable sessions (survive restarts), local users and an append-only audit log. Research
02 suggested managed storage or PostgreSQL, and warned against storing control-plane state in the Redis being
inspected.

**Decision.** `node:sqlite` (built into Node 24), one file in the data directory, WAL mode, migrations at startup. The
audit table rejects UPDATE and DELETE through triggers, and every event is also written to stdout for the SIEM.
Session IDs are stored as SHA-256 hashes only.

**Alternatives.** PostgreSQL (another service to run and secure); the inspected Redis (mixes control and data planes);
in-memory sessions (everyone signs in again after every restart).

**Consequences.** **One replica per data directory.** High availability is a quick restart plus backups. In-memory
state (rate limits, confirmations, jobs) is per instance. No dependency was added. Long-term audit history belongs in
the SIEM; the SQLite table keeps `audit.retentionDays` (365 by default) and is pruned by an audited job (D19).

**Evidence.** [02 § 4](research/02-secure-architecture.md#data-flow-and-deployment), `apps/server/src/store/db.ts`.

## D09. No AI, no telemetry, no external calls

**Context.** One audited GUI sent console input and Redis tool output to its maintainer's AI service by default and
loaded analytics. Any egress of key names, values or commands is a data leak for this tool.

**Decision.** No telemetry, analytics, error reporting services, AI features, CDN assets or remote fonts. The server
contacts only Redis and the configured OIDC issuer. "Smart" features (autocomplete, inline docs, guided forms,
analysis recommendations, tutorials) are built from Redis's own `COMMAND DOCS`, local rules and static text.

**Alternatives.** An optional AI assistant behind a flag (rejected: data egress, prompt injection from Redis data).

**Consequences.** Help is deterministic and reviewable. Fonts are self-hosted (CSP `font-src 'self'`).

**Evidence.** [01 § 1](research/01-oss-alternatives-audit.md) (P3X), [02 § 1 invariant 5, § 11](research/02-secure-architecture.md#11-intelligent-ux-without-expanding-trust).

## D10. Measure replies instead of predicting their size

**Context.** v0.1 and the first v0.2 rounds bounded memory by *predicting* reply sizes (`MEMORY USAGE`, `STRLEN`,
JSON and search planners) before running a command. Every review round found another shape that slipped past a
prediction: alias expansion in search, huge key names, unsized ranges, sampling holes.

**Decision.** Measure instead. Data-dependent commands run on exclusive raw sockets whose RESP reader counts wire bytes
before decoding and stops at a byte, element and depth cap; overflow destroys only that socket and returns 413. No
prediction probes run. A global command budget, per-user shares and bounded wait queues bound concurrency; streams
have their own budget.

**Alternatives.** Keep refining predictors (an endless list of special cases, extra Redis round trips); trust
node-redis (no reply size limit).

**Consequences.** Memory is bounded independently of data shapes. Closing a socket does not stop work Redis already
started, so time limits and SCAN budgets remain. Replies node-redis reads itself (topology) are not measured; use
verified TLS outside trusted networks.

**Evidence.** REVIEW-LOG "Round 3 – server", [qa/v02-replycap.md](qa/v02-replycap.md),
[research/11](research/11-v02-server-review-r3.md).

## D11. Re-check the actor when a command is dispatched

**Context.** Review finding N1: a write queued behind a full connection pool still executed after an admin disabled
the user. Checks at the HTTP gate are not enough when a request can wait for a pool, a slot or a connection.

**Decision.** Every database command except marked reads is checked again (session alive; account enabled with the
same role and auth generation) synchronously with the write of its bytes, after every wait and on every MOVED/ASK
re-dispatch. These commands always use the measured sockets, never node-redis, which writes queued commands on a later
event-loop turn. A refusal sends nothing, returns 401 and is audited as `auth.revoked`.

**Alternatives.** Check only at the gate (the N1 bug); check before queueing in node-redis (still racy: the N1
follow-up).

**Consequences.** Revoking or demoting a user stops their in-flight writes. Read paths that touch thousands of keys
skip the per-command check (they are still gated per request).

**Evidence.** REVIEW-LOG "Fix verification – server" and "N1 follow-up – server", [research/18](research/18-v02-server-verify.md),
[19](research/19-v02-n1-verify.md), [20](research/20-v02-n1-followup-verify.md).

## D12. Compare-and-set for edits that replace data

**Context.** Shared databases change underneath an open editor. A blind overwrite silently loses another client's
write; Redis Insight's direct type-update paths have no expected-value check.

**Decision.** Edits that replace data carry what the client read (type and SHA-256 of the bytes). The server verifies
it with `WATCH`, a read and `MULTI`/`EXEC` on one exclusive socket of the caller's tier, never Lua, and answers 409 with
the current value on a mismatch. The UI offers Reload or Overwrite anyway (checked again). Creates never overwrite;
rename never replaces an existing key.

**Alternatives.** Last write wins; Lua check-and-set (Lua is blocked for good reasons); optimistic versions stored in
Redis (changes the user's data).

**Consequences.** The operator ACL user needs `+@transaction` (an upgrade note for v0.2). Comparison is by bytes: a list
element changed and changed back at the same index is not detected; collection renames and deletes compare the type
only.

**Evidence.** REVIEW-LOG "Round 3 – web" (compare-and-set design), RI-PARITY-AUDIT K2.

## D13. Names-only key scanning with lazy metadata; `MEMORY USAGE … SAMPLES 5`

**Context.** v0.2 read TYPE, TTL and MEMORY USAGE for every listed key, so it showed 200 keys at a time and needed
"Scan to end" to see the shape of a database. Side by side with Redis Insight, a 7.5k-key development snapshot took
4.6 s to open and about 22.5k Redis commands; a remote 8k-key database took 55 s.

**Decision.** Scan names only (SCAN `COUNT` 2000 per call, up to "Keys to scan", 10,000 by default, each request
bounded in time), build the whole namespace tree in the browser, and read metadata only for rows on screen, pipelined
on the measured transport. Key sizes use `MEMORY USAGE … SAMPLES 5` by default (`policy.keyMetaMemorySamples`); 0 is
exact.

**Alternatives.** Per-key metadata on scan (the v0.2 cost); exact sizes (`SAMPLES 0`, as Redis Insight) by default:
it walks every element of a collection on the Redis server, and that work continues even after the request is gone.

**Consequences.** Opening the browser costs 14 Redis commands instead of about 22.5k and takes under a second. Collection
sizes are estimates unless an operator sets 0. Sorting by type, TTL or size first loads metadata for every listed key,
with progress and Stop.

**Evidence.** [qa/v021-key-browser.md](qa/v021-key-browser.md), RELEASE-NOTES-v0.2 "Redis Insight parity",
[RI-PARITY-PLAN.md](RI-PARITY-PLAN.md).

## D14. Strict CSP with a nonce and Trusted Types; byte-exact display

**Context.** Redis data is attacker-controlled: anyone who can write a key can try XSS against whoever views it.
Binary values, big integers, CRLF, BOM and invisible characters get corrupted by naive text handling, so what you
see, copy or write back may not be what is stored.

**Decision.**
- CSP `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-…'` with a fresh nonce per response,
  `require-trusted-types-for 'script'`, `frame-ancestors 'none'`, no `unsafe-*`. Libraries that inject styles get the
  nonce (CodeMirror); zod runs without JIT. No Trusted Types policy that would let strings become HTML.
- Redis data is never HTML: no `innerHTML`, `dangerouslySetInnerHTML`, `eval`, or URLs built from data. Java and PHP
  serialized values get inert, bounded structure views; nothing is deserialized.
- Values travel as `Bin` (UTF-8 or base64 bytes). Display, copy, download, re-run and write-back keep the exact bytes;
  invisible and bidi characters are made visible; numbers are not rounded.

**Alternatives.** A permissive CSP (`unsafe-inline` styles), or a Trusted Types policy that passes strings through
(both make the headers decorative); sanitising HTML (a sanitiser is a parser to get wrong).

**Consequences.** Every UI dependency must work under this CSP; the e2e suite fails on any CSP or Trusted Types
violation on any page.

**Evidence.** [02 § 8](research/02-secure-architecture.md#8-frontend-and-decoder-hardening),
`tests/e2e/specs/ui/xss.spec.ts`, `tests/e2e/specs/api/headers.spec.ts`, REVIEW-LOG web rounds.

## D15. No Redis data in URLs, logs or browser storage

**Context.** Reverse proxies, load balancers and APM agents log URLs; browser storage outlives sessions; logs end up in
many places. Key names often contain user IDs and e-mail addresses.

**Decision.** Key names, patterns, channels and queries travel in POST bodies; any URL with such query parameters is
refused with 400. Pub/Sub streams use single-use subscription ids. Logs and the audit store command names and
redacted arguments only (key hashes, byte counts). The browser keeps Redis data in tab memory only; `localStorage`
holds presentation preferences.

**Alternatives.** GET reads with query strings (simpler caching and links; leaks data to every log on the path).

**Consequences.** No shareable deep links to keys. Reads are POSTs, so they pass CSRF checks.

**Evidence.** [CONTRACT-CHANGES.md](CONTRACT-CHANGES.md) (2026-10-24, reads moved to POST bodies), E2E-FINDINGS F-09,
`tests/e2e/specs/api/no-data-in-urls.spec.ts`; REVIEW-LOG "Round 1 – server" M6 (reads audited, counts only).

## D16. Cross-model review loops and mandatory live testing

**Context.** One model writing and reviewing its own code repeats its own blind spots. Code review alone misses what
only appears in a browser, as a particular role, on real data shapes.

**Decision.**
- Work is split into independent streams (separate worktrees and branches, explicit file ownership, a shared contract
  whose changes are logged).
- Each stream is reviewed by a **different model** from its author, in rounds covering the code and live use in a real
  browser as every role. Every finding must be reproduced.
- A fixer verifies each finding against the current code, fixes only still-valid ones with minimal changes and a
  regression test that fails before the fix, skips the rest with a reason, and logs every verdict in REVIEW-LOG.md.
  Rounds repeat until none finds a valid Medium or higher; targeted fix verifications follow.
- Before merging: typecheck, unit and integration tests, the cluster/Sentinel/TLS topology suite, the full e2e suite,
  and live QA with accounts for every role against sandbox databases and a read-only target that must never receive a
  write.

**Alternatives.** Single-model self-review; code review without live testing; manual QA only.

**Consequences.** Slower, and every finding leaves a paper trail. v0.2 went through five server rounds, three web
rounds, final reviews and fix verifications; the parity work through another server and web round. The procedure is
in [AGENTS.md](../AGENTS.md).

**Evidence.** [REVIEW-LOG.md](REVIEW-LOG.md), [research/05–25](research/README.md), [qa/](qa/), [V0.2-PLAN.md](V0.2-PLAN.md).

## D17. Redis Insight parity: what we kept, matched and left out

**Context.** The owner compared v0.2 with Redis Insight side by side. The audit found 27 gaps and five areas where
Redis Console was already better.

**Decision.**
- **Kept as better:** the operational database landing and Overview (K1); conflict-aware edits and no-overwrite
  creates and renames (K2); persistent environment, role and read-only context plus server-built confirmations (K3);
  keyboard-first, policy-aware command assistance (K4); the native TimeSeries browser and chart (K5); also key-name
  anatomy and the TTL fuse, exact numbers, guided forms that show their command.
- **Matched through the policy boundary:** names-only scanning with folder counts and shares, tree/list views, column
  chooser and sorting, pattern delete as a job; collection search and formatting, hash field TTLs, full-element reads,
  multi-entry adds, stream groups/consumers/pending; the bottom tools drawer, status metrics, `db N` context, landing
  sort and tags, Pub/Sub ergonomics, read-only slow log config, preferences; index wizard and search workflow, analysis
  recommendations and history, rich workbench results, command-file import, offline tutorials.
- **Intentionally different:** no user-added connections or hosts, no arbitrary `SELECT`, no cloud sign-in, AI or
  telemetry, no Lua/Functions/MODULE/CONFIG SET, no imports that bypass the policy, no slow log configuration
  changes, no executable deserialization, profiler limited by role, environment and time, drafts and history in
  memory only, no arbitrary pipeline sizes.
- **Deferred:** vector-set and array-type inspectors; geo and graph workbench renderers.

**Consequences.** Parity is judged by outcome, not by copying Redis Insight's implementation.

**Evidence.** [RI-PARITY-AUDIT.md](RI-PARITY-AUDIT.md), [RI-PARITY-PLAN.md](RI-PARITY-PLAN.md),
[research/22–25](research/README.md), RELEASE-NOTES-v0.2.

## D18. Client addresses behind proxies: a hop count or the proxy's address

**Context.** The audit log and the per-address limits (sign-in, requests per second) need the client's address, which
behind a reverse proxy only `X-Forwarded-For` carries. The configuration accepted a hop count (`trustProxy: 1`), but
Fastify 5.12.7 turns a number into "trust no proxy" (a hop count alone cannot tell the proxy from a direct client), so
every user appeared as the proxy and shared one sign-in budget.

**Decision.** Offer both industry-standard forms. A hop count N keeps its Express and proxy-addr meaning: the server
gives Fastify a trust function that trusts the N nearest hops, so the client is the Nth `X-Forwarded-For` entry from
the right; it is documented as safe only when nothing but the proxy can reach the port (the `deploy/` examples publish
`127.0.0.1` only or admit only the ingress controller). The proxy's address, a narrow CIDR or an alias is the stricter
form: `X-Forwarded-For` from any other peer is ignored. Production still refuses `true` and broad CIDRs, and also hop
counts above 5, which would trust entries the client wrote (the same as `true`).

**Alternatives.** *Addresses only* (what the docs said while hop counts were broken): stricter, but container and pod
addresses change, and a wrong address silently degrades to "everyone is the proxy". *Hop count plus a private-address
check on the peer*: a heuristic that silently fails for proxies on public addresses.

**Consequences.** Choosing the count is the operator's job: one too few records a proxy for everyone, one too many
lets clients choose their address. Both are covered by `apps/server/test/integration/trust-proxy.test.ts` with real
HTTP proxies, one and two deep, and a forged header sent directly.

**Evidence.** REVIEW-LOG "v0.3 follow-ups" item 1; [INSTALL.md](INSTALL.md#setting-trustproxy).

## D19. Audit retention in SQLite: a bounded, audited exception to append-only

**Context.** The SQLite audit table grew without bound (D08): a busy deployment writes an event per command and per
data read, and the only way to shrink it was to archive the whole file. The table is append-only by triggers, which
protect the trail from application bugs and from SQL anywhere in the code.

**Decision.** `audit.retentionDays` (default 365, the common one-year retention for access logs; at least 30; `0`
keeps everything). A job at startup and every 24 hours deletes older rows, oldest first, 5,000 per transaction, yielding
between batches, and records `system.audit.prune` with the counts. The triggers stay: UPDATE is always refused, and the
DELETE trigger allows only rows older than the cutoff of a grant row that the job inserts and removes inside the same
transaction (never visible to another connection), and never rows younger than 30 days. Only the SQLite copy is
pruned; the stdout stream for the SIEM is the long-term record.

**Alternatives.** *Drop or disable the trigger while pruning* (a window in which any code could delete anything);
*archive to a second table or file* (the same growth, moved); *time-partitioned tables* (more machinery than one index
and a trigger condition); *no retention, document SIEM only* (the previous state: the file grows forever).

**Consequences.** The Admin audit view shows a year of history by default. Deployments that must keep longer either
raise the setting or rely on the SIEM. Anyone who can write the SQLite file can still change it; the triggers guard
the application, not the host (backups and the SIEM do that).

**Evidence.** `apps/server/test/unit/audit-retention.test.ts`; REVIEW-LOG "v0.3 follow-ups" item 3.

## D20. The Workbench geo map is offline: a bundled outline, no tiles

**Context.** Redis Insight shows geo replies on a map (F11 in `docs/RI-PARITY-AUDIT.md`). Web maps usually load tiles
from a tile server at runtime, which would send the area being looked at (and so a hint of the data) to a third party
and break hard rule 11 (no runtime fetches besides Redis and the OIDC issuer) and the strict CSP.

**Decision.** `GEOSEARCH`/`GEORADIUS*` with `WITHCOORD` and `GEOPOS` replies render as an SVG in an equirectangular
frame over a land outline bundled with the app: Natural Earth 1:110m land polygons (public domain), generated into
`apps/web/src/assets/world-110m.ts` by `scripts/world-outline.ts` (28 KB, loaded on first use). Points are focusable
markers; member names are text; at most 2,000 points are drawn and the rest are counted.

**Alternatives.** *Tile servers* (OpenStreetMap and others: third-party requests, CSP holes, availability); *a
self-hosted tile server* (operational weight for an occasional view); *a mapping library* (a large dependency for a
projection and a path).

**Consequences.** The map is coarse (about 1:110m coastlines, no roads or labels), which is enough to see where points
are relative to each other and to the search area; exact positions are in the table. The outline is regenerated by
hand if a finer source is ever wanted.

**Evidence.** `apps/web/src/components/geo.test.tsx`; `tests/e2e/specs/ui/geo-map.spec.ts` (no request leaves the
console origin).


## D21. FalkorDB queries are bounded and cannot run host I/O or user code

**Context.** GRAPH commands have no ACL categories; QUERY and PROFILE can mutate graphs, EXPLAIN is flagged write,
and CONFIG is flagged readonly even for SET. `graphdata` keys need the Workbench rather than a collection editor.
FalkorDB's verbose replies carry graph entity IDs, labels, properties, table rows and statistics.

**Decision.** Explicit application rules and graph-specific ACL grants. RO_QUERY, EXPLAIN, LIST, MEMORY and
`INFO ObjectPool` are reads. QUERY and PROFILE are operator writes and **always** require confirmation, including
queries that appear read-only. GRAPH.DELETE is admin with typed database confirmation; it is the admin tier for that
one command, not a barrier to removing graph data, which operators can do with `DEL`, `RENAME` or a Cypher
`DETACH DELETE` like any other key (review v0.4 r2 graph L3). Prod writes additionally
require the database name and reason. CONFIG GET and SLOWLOG (without RESET) are admin reads; all other CONFIG forms are blocked.
COPY and CONSTRAINT management are deferred. UDF, BULK, RESTORE and internal DEBUG/EFFECT/RECORD commands are blocked.
Unknown GRAPH commands fail closed even if a later module reports permissive flags.

A conservative lexical guard, applied server-side to exact argv for every query/plan command, refuses LOAD, all CALLs
except no-argument `db.labels()`, `db.relationshipTypes()` and `db.propertyKeys()`, and all namespaced/quoted function
calls. This also prevents invoking already-loaded JavaScript UDFs through RO_QUERY. In backtick identifiers backslashes are literal, and FalkorDB 6.0.3 refuses a doubled backtick (the guard reads it as an escape, which can only widen what it treats as a name in a query the engine refuses; verified against the engine, review v0.4 r3 graph L3).
Strings and comments are inert;
unbalanced delimiters and non-ASCII unquoted identifiers/line comments fail closed (use quoted labels and string literals for Unicode). Queries are limited to 64 KiB. This is a feature guard, **not a Cypher parser**:
reserved words used as unquoted properties can be refused, legitimate namespaced/quoted built-ins are unavailable,
and server-side RO_QUERY is the second enforcement layer against mutations. New procedures need review and tests.
`INFO` running/waiting sections are refused because they disclose other users' query text. SLOWLOG RESET is refused. MEMORY supports only USAGE, with SAMPLES capped to 100 (zero/all becomes 100).
SLOWLOG includes query text and remains admin-only.

QUERY/RO_QUERY/EXPLAIN/PROFILE accept only the reviewed TIMEOUT and `--compact` options. A positive timeout is always
sent; zero and values above 1000 ms become 1000 ms. Malformed/duplicate options are rejected. The sandbox uses
TIMEOUT_DEFAULT/MAX 1000, RESULTSET_SIZE 10000 and MAX_QUEUED_QUERIES 25. The legacy TIMEOUT parameter alone leaves
writes unbounded and cannot coexist with DEFAULT/MAX. Other deployments must set equivalent module bounds.
Timeouts do not promise rollback: graph writes can partially execute, and ambiguous failures are never auto-retried.

**Review v0.4 r2 (graph H1, H2).** The guard ended a `//` comment at CR as well as LF, FalkorDB at LF only, so a lone CR
hid LOAD CSV, UDF calls and procedures from it; comments now end at LF (CR LF allowed, a lone CR refused), whitespace
outside strings is ASCII only (browser and server read the same), and an integration test runs hundreds of
tokenisation probes through EXPLAIN and requires a refusal wherever the engine reads code. `IMPORT_FOLDER` points at a
missing directory. The timeout is cooperative (checked between steps): one `reduce` over a long `range` ran 13–16 s and
kept running after the socket closed. The console cannot cancel it, so it holds a graph query's slots (one per user,
two per database) until the engine answers, at most 15 minutes. A single query's CPU and memory remain the
deployment's to bound (a container memory limit; `QUERY_MEM_CAPACITY` does not count list building in 6.0.3), and
viewer RO_QUERY can be withheld per tier where viewers are not trusted with engine time.

The rich renderer accepts default verbose replies; compact/unrecognized shapes retain the generic raw view. It draws
at most 200 unique nodes and 400 edges with deterministic concentric rings; edge endpoints absent from the result
are dashed placeholders. Remaining received entities are counted. Incomplete server replies are labelled; entities
outside the received reply cannot be counted. The table is bounded to 1000 rows and 40 columns; plan trees to 1000
lines and 40 levels. Property text, labels and statistics are escaped text. Focusable SVG nodes expose details by
Enter/Space. No graph data becomes HTML, styles or network requests. Large diagrams show labels on selection to
avoid a wall of overlapping text. Raw replies remain subject to server transport/display caps.

**Alternatives.** Keyword-based destructive-query detection is incomplete and can miss new syntax. Confirming every
write command makes the consequence clear without claiming to classify Cypher. General-purpose graph/physics
libraries add dependencies and unbounded layout work; an offline deterministic SVG meets the inspection need.

**Evidence.** `graphPolicy.test.ts`, server `graph-policy.test.ts` and integration `graph.test.ts`, web `graph.test.tsx`,
`tests/e2e/specs/ui/graph.spec.ts` and [graph live QA](qa/v04-graph.md). FalkorDB 6.0.3 sandbox probes: TYPE is graphdata;
a sandbox canary CSV was read successfully with a temporary import folder (restored afterward), HTTPS loopback was refused by FalkorDB's own address guard,
plain HTTP was refused; application policy refuses every LOAD before dispatch. The pinned upstream
[CSV documentation](https://falkordb.github.io/docs-staging/cypher/load-csv/) describes server file imports, and
[UDF tests](https://github.com/FalkorDB/FalkorDB/blob/v6.0.3/tests/flow/test_udf.py) demonstrate namespaced code execution.


## D22. Array search reads values in bounded batches and matches them on the server, not with ARGREP

**Context.** ARGREP (Redis 8.8 arrays) evaluates its predicates inside Redis over a whole range, on the main thread and
with no time limit; a case-insensitive substring search costs about value bytes × pattern bytes. Redis reports no
byte size for a range (ARINFO has counts and slice layout only; AROP has no length operation), so no argument check
bounds that work: in review v0.4 r2 (H1, H2) a console ARGREP scanned a whole 20 MiB range in 619 ms, and the inspector's
cap, estimated from the array's average element size, admitted 5 times its budget when small values sat elsewhere in
the array, or one 8 MiB value.

**Decision.** The inspector's search reads the range with `ARSCAN … LIMIT n` through the measured transport, in
batches from one per-request budget (`ARRAY_SEARCH_MAX_BYTES`, 16 MiB; each read at most half), and matches on the
server with ARGREP's meanings: EXACT equal bytes, MATCH a substring, GLOB a port of Redis's `stringmatchlen`, NOCASE
folding ASCII letters as Redis's `tolower` does. A value larger than half the budget is skipped by index (found with
`AROP … USED` bisection). ARGREP is blocked in the console and the Workbench.

**Alternatives.** *Keep ARGREP with a sampled size estimate* (not a bound: the reviewer defeated it); *bound the range
span* (element sizes are unknown, so no span is safe); *allow console ARGREP without NOCASE* (still a whole-range scan
of arbitrarily large values in Redis's main thread).

**Consequences.** Redis does only plain reads for a search: the server decodes and keeps at most 16 MiB per request.
Redis builds each batch's reply before the server can close the socket, as for every read, so batches are sized from
the values seen and the first element of a request is read alone. Matching moved onto the server's event loop, so it
has its own allowance (review v0.4 r3 H1): about 16 million matcher steps (some 40 ms) per request, spent by GLOB steps
and native scans; a value that alone costs more is skipped by index, and the search yields to other requests between
values. Every request tests or skips at least one element, so Continue always moves (r3 M1). The results are the same as ARGREP's (verified against Redis for EXACT, MATCH and GLOB with and without
NOCASE, classes, ranges, escapes, binary and Latin-1 bytes), except a `[a-z]` range against bytes above 0x7f on a Redis
built where `char` is signed. Searching large values takes more requests (Continue). Console users search arrays in the
inspector.

**Evidence.** `apps/server/test/integration/array.test.ts` (ARGREP agreement, clustered values, a skipped 8 MiB value),
`apps/server/test/unit/array.test.ts` ("array search byte bound"), `docs/research/29-v04-review-r2-data.md`.
