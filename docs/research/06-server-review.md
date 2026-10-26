# Redis Console backend: independent security review

Reviewed commit: `30e51fb7d4b82fe87f6a7aedd2fa68a9429d3339` (detached review worktree). Scope: `AGENTS.md`, `docs/ARCHITECTURE.md`, shared contracts and command policy, contract changes, server README, all backend source, existing tests and recent hardening commits. No source or lockfile changes were made, and no commits were created.

**Result: changes required before relying on the backend as the credential and data boundary.** Four High, two Medium and two Low findings were reproduced locally. No Critical finding was established. The most consequential defects are stale authentication state surviving credential/role changes, and an operator's ability to use `COPY ... DB` to write into a different logical database without that database's policy.

## Method and evidence

- Installed with `pnpm install --frozen-lockfile`; used the existing `.env` by sourcing it, without copying or printing its contents.
- Existing backend suite: **421 passed, 14 skipped; 32 files passed, one skipped**, 46.42 s. The skipped file was the optional cluster/sentinel/mTLS topology suite. This was a real sandbox run, including the local Keycloak OIDC suite.
- `pnpm --filter @rconsole/server typecheck`: passed.
- `pnpm audit --json`: exit 0, **zero reported vulnerabilities**, 142 total dependencies. This describes the registry audit result at review time, not a guarantee that dependencies contain no defects.
- Independent scratch tests under `/tmp/rc-audit/` imported the exact reviewed source. Redis fixtures used only disposable port **6411**; the existing suite also exercised sandbox-main on **6410**. Scratch fixtures were removed, including the test key in logical DB 1.
- A separate server ran on `http://localhost:4600`, with `/tmp/rc-audit-data`. The bootstrap admin completed the required password change and TOTP enrollment; viewer/operator users were created through the admin API and completed their required password changes.
- The real remote target was used **only through this app**: viewer and operator `INFO server` reads succeeded, and string-argv and binary-argv `SET` attempts both returned 403. No command reached Redis for those refused writes. No connection was made to port 6380; `scripts/dev-setup.sh` was not run.
- Race tests signal when the real user record is read, then submit the real administrative/enrollment request while the real asynchronous Argon2 verification is pending. The signaling wrappers return the original record unchanged; cryptography, authorization, session creation and Redis execution are not stubbed. The three scenarios in `races.mjs` also passed three repeat runs.
- Large-reply tests deliberately use a supported **1,024-byte `maxReplyBytes`** setting and small fixtures. They demonstrate budget bypasses without attempting an OOM. Larger-impact examples below are estimates from the code, not destructive tests.

Scratch evidence retained:

| Artifact | Purpose |
| --- | --- |
| `/tmp/rc-audit/audit.mjs`, `scratch.log`, `results.json` | API-created accounts, login demotion race, cross-DB COPY, allocation and response budgets, policy and confirmation checks |
| `/tmp/rc-audit/races.mjs`, `races.log`, `races-repeat-{1,2,3}.log` | TOTP enrollment race, revoked-session resurrection, workbench after disable |
| `/tmp/rc-audit/oidc.mjs`, `oidc.log`, `oidc-results.json` | Local synthetic issuer, OIDC negative tests, logout token disclosure |
| `/tmp/rc-audit/static.mjs`, `static.log` | External index.html symlink, using a fake secret fixture |
| `/tmp/rc-audit/live.mjs`, `live.log` | Real HTTP bootstrap/enrollment/admin flow and remote read/write-refusal checks |
| `/tmp/rc-audit/baseline-tests.log`, `typecheck.log`, `pnpm-audit.json` | Baseline verification |

The scratch imports reference the original review-worktree path. To rerun after its required removal, recreate that detached checkout at the same path and install dependencies. For example:

```sh
cd ../redis-console-wt/review-server
set -a
source <repo>/.env
set +a
export RC_AUDIT_BOOTSTRAP='Initial audit bootstrap 123456!'
node --disable-warning=ExperimentalWarning /tmp/rc-audit/audit.mjs
node --disable-warning=ExperimentalWarning /tmp/rc-audit/races.mjs
node --disable-warning=ExperimentalWarning /tmp/rc-audit/oidc.mjs
node --disable-warning=ExperimentalWarning /tmp/rc-audit/static.mjs
```

The bootstrap password above is only a disposable scratch-test credential. The snippets in each finding show the minimal relevant operations; the named scripts provide their complete setup, synchronization, assertions and cleanup.

## High

### H1. In-flight authentication can restore old privileges, skip newly enabled TOTP, and resurrect a revoked session

**Locations:** `apps/server/src/routes/auth.ts:84`, `:90`, `:93`, `:101`, `:224`, `:227`; `apps/server/src/store/sessions.ts:117`, `:132`; `apps/server/src/app.ts:169`.

Login loads `u` before `await verifyPassword(...)`. After the await it refreshes the lock status, but continues using the old role, disabled flag, password hash and TOTP configuration. User administration can demote the account and destroy all existing sessions during that await. Login then creates a new session with the old role. The ordinary request hook checks whether the user exists/is disabled and whether enrollment is required, but does not reconcile the session role with the current user role.

Password change has a second entry point into the same stale-state problem: it retains the old session across two hash operations, then calls `rotate(s)`. Rotation unconditionally inserts a new session even when its DELETE removed zero rows because an admin already revoked it.

**Minimal local reproductions:** `audit.mjs` and `races.mjs`.

```js
// Synchronize after login reads the operator, before its real password hash finishes.
const pendingLogin = outsider.req('POST', '/api/v1/auth/login', {
  username: operator.username, password: operatorPassword
});
await userSnapshotRead;
await admin.req('PATCH', `/api/v1/admin/users/${operator.id}`, {role: 'viewer'});
const login = await pendingLogin;
assert.equal(login.json.me.role, 'operator');       // database role is now viewer
assert.equal((await outsider.req('POST', cli, {
  argv: ['SET', scratchKey, 'role-race']
})).status, 200);                                  // real write succeeds
```

Two additional independently asserted variants:

1. Begin password-only login before enrollment finishes; finish the owner's `/auth/totp/confirm` during hashing. Login returns an **active** session with `totpEnabled: true` and no `totpRequired`, although that sign-in never supplied a code.
2. Begin `/auth/password` as an operator; demote the user to viewer while hashing. The password response returns role **operator**, rotation recreates a session that administration revoked, and a subsequent `SET` succeeds.

**Impact:** an account can retain elevated permissions after demotion, and password knowledge can suffice for a sign-in racing TOTP activation. This affects future requests, not merely a command that was already executing. Per-tier Redis ACLs do not stop it: the stale session selects the old, more privileged ACL tier. The tests proved operator-to-viewer bypass; the code also uses the same mechanism for higher roles.

**Concrete fix:** introduce an authentication/authorization generation on users, incremented for role, disabled, password and TOTP changes. Capture it when verification begins and atomically require an unchanged generation before creating/rotating a session or changing credentials. Re-read and validate the current account after every asynchronous credential operation; a password-hash change must invalidate the verification result rather than merely refreshing the role. Make rotation require an existing, unexpired, unrevoked session in the same transaction; reject a zero-row DELETE. Store/check the generation on sessions at the request gate. Add all three race cases as regressions.

### H2. `COPY ... DB` bypasses the destination logical database's `readOnly` and `maxRole`

**Locations:** `packages/shared/src/commands.ts:51`; `apps/server/src/routes/cli.ts:43`; `apps/server/src/context.ts:95`; `apps/server/src/policy/policy.ts:172`.

`COPY` is classified as a normal write, but its `DB` option is not checked. Scope and credentials come exclusively from the database ID in the URL; the destination DB index in argv never resolves to a destination policy. This contradicts the fixed logical-database boundary documented beside the blocked `MOVE` and `SELECT` rules.

**Minimal local test:** `audit.mjs`. Configure two aliases on disposable 6411: `e2e` is writable DB 0; `db1-ro` is DB 1 with `readOnly: true, maxRole: 'viewer'`.

```js
await sandboxDb0.set(src, 'cross-database');
assert.equal((await operator.req('POST', '/api/v1/databases/db1-ro/cli', {
  argv: ['SET', dst, 'blocked']
})).status, 403);
const copied = await operator.req('POST', '/api/v1/databases/e2e/cli', {
  argv: ['COPY', src, dst, 'DB', '1', 'REPLACE']
});
assert.equal(copied.status, 200);
assert.equal(copied.json.reply.v, '1');
await sandbox.select(1);
assert.equal(await sandbox.get(dst), 'cross-database');
```

**Impact:** an operator with access to a writable alias can create or overwrite keys in another logical DB on the same Redis server, even if that DB is configured as viewer-only/read-only, or is not configured in the console at all. The destination can also miss its production confirmation requirements. This does **not** cross hosts or demonstrate writes to remote-6390; the reproduction was exclusively on 6411.

**Concrete fix:** reject the `DB` option in console/workbench `COPY` commands. If cross-DB copying is required later, expose a typed operation taking a configured destination ID, independently enforce source/destination roles and write restrictions, bind both IDs into confirmation, and use approved destination credentials. Parse options positionally and case-insensitively, including binary argv. Add line, argv and argvBin regressions.

### H3. Repeated-member reads bypass the reply byte preflight

**Locations:** `apps/server/src/policy/replyGuard.ts:87`, `:89`, `:180`; `apps/server/src/routes/cli.ts:77`, `:82`.

The preflight for `SRANDMEMBER`, `HRANDFIELD` and `ZRANDMEMBER` sets only `fixedElements` and leaves `checks` empty. Negative counts can repeat one large member/value many times. The element count can be below 100,000 while the encoded bytes exceed the configured preflight byte limit by orders of magnitude. node-redis receives/decodes the entire reply before `toReply` limits the browser output.

**Minimal local test:** `audit.mjs`, against a one-member set on 6411.

```js
await sandbox.sAdd(k, 'x'.repeat(1024));
await preflightReply(viewerConn, 'SRANDMEMBER', ['SRANDMEMBER', k, '-50'], 1024);
// No exception, although max preflight bytes is 1024 * 16 = 16,384.
const raw = await viewerConn.send(['SRANDMEMBER', k, '-50']);
assert.equal(raw.reduce((n, b) => n + b.length, 0), 51_200);
assert.equal((await viewer.req('POST', cli, {
  argv: ['SRANDMEMBER', k, '-50']
})).status, 200);
```

**Impact:** a viewer can exhaust console memory when an accessible collection contains a sufficiently large member. With the default limits, 100,000 repeats of a 512-KiB member imply approximately **48.8 GiB** of payload before the reply-tree cap; this extrapolation was not executed. Command timeout and per-user command concurrency do not establish a byte bound.

**Concrete fix:** budget the bytes of repeated output, not only its element count. Conservatively refuse repetition whose worst-case element/value size cannot be bounded; where measured safely, combine the requested count with a conservative maximum element/value size. Enforce a hard decode/transport allocation limit or disallow operations that cannot be bounded before execution. Include large-value negative-count tests for all three commands and `WITHVALUES`/`WITHSCORES` variants.

### H4. Key-browser collection previews load full elements and have no aggregate reply budget

**Locations:** `apps/server/src/routes/keys.ts:184`, `:195`, `:209`, `:221`, `:240`; `:47`.

Collection reads fetch full Redis elements first and only then run `preview()`. They neither call the CLI preflight nor account for `policy.maxReplyBytes`. A small page count is not a byte bound; HSCAN/SSCAN COUNT is also a hint rather than a hard number of returned elements.

**Minimal local test:** `audit.mjs`.

```js
// config.policy.maxReplyBytes = 1024
await sandbox.rPush(k, Array.from({length: 20}, () => 'v'.repeat(4096)));
const r = await viewer.req('GET', `/api/v1/databases/e2e/key?k=${kp(k)}&count=20`);
assert.equal(r.status, 200);
assert.equal(r.json.value.items.length, 20);
assert.equal(Buffer.byteLength(r.body), 83_015); // over 81 times maxReplyBytes
```

**Impact:** the endpoint recommended as the safe alternative to large CLI replies can itself allocate and return large responses. Full elements can be substantially larger than the 64-KiB previews. Even the previews alone can total roughly 64 MiB for 1,000 list elements under default settings; full Redis reply allocations occur earlier. No OOM was attempted.

**Concrete fix:** enforce a cumulative page byte budget, including keys/fields and JSON/base64 overhead, and guard the Redis read before full elements are decoded. Use bounded string-range reads where possible; conservatively refuse or shrink collection pages when element size cannot be bounded. Do not treat COUNT as an allocation limit. Apply the same approach to hashes, sets, zsets and streams; return an explicit continuation/truncation result when stopping early.

## Medium

### M1. Workbench continues issuing new commands after its user is disabled

**Locations:** `apps/server/src/routes/cli.ts:164` (prepare once), `:188`, `:200`; `apps/server/src/routes/admin.ts:86` (revocation).

Workbench authorizes all lines up front and retains the original `scope`. Its execution loop checks the time budget but not session liveness/current user state. Administrative session revocation therefore does not prevent subsequent lines from being sent to Redis.

**Minimal local test:** `races.mjs`; use a unique absent key for the blocking command and a separate scratch write key.

```js
const running = operator.req('POST', '/api/v1/databases/e2e/workbench', {
  script: `BLPOP ${absentKey} 0.2\nSET ${scratchKey} after-disabled`
});
await firstBlockingCommandSubmitted;
await admin.req('PATCH', `/api/v1/admin/users/${operatorId}`, {disabled: true});
const r = await running;
assert.equal(r.json.results[1].reply.v.data, 'OK'); // submitted after disable
assert.equal((await operator.req('GET', '/api/v1/auth/me')).status, 401);
```

**Impact:** disabling/demoting a user does not stop an already prepared script from issuing additional reads/writes during the remaining workbench budget. This is distinct from H1: the old session is genuinely absent and future HTTP requests are refused; the existing batch ignores that state. An already executing Redis command may be unavoidable, but future batch commands are preventable.

**Concrete fix:** before each line, verify the session still exists and the current authentication/authorization generation matches; stop the entire batch on revocation. Recompute effective role and authorize each command if role changes are intended to be tolerated. Apply cancellation/liveness checks at bounded intervals in other multi-command operations, especially bulk deletion.

### M2. Workbench's per-command cap permits a much larger accumulated HTTP response

**Locations:** `apps/server/src/routes/cli.ts:93` (new reply budget per command), `:187`, `:203`, `:212`.

Each result gets an independent reply budget, then all results remain in memory until one JSON response is serialized. The request-wide result has no byte cap. Per-command concurrency slots are released between lines and do not limit simultaneous accumulated workbench responses.

**Minimal local test:** `audit.mjs`.

```js
// maxReplyBytes = 1024; supported script length and 100-command limit.
const script = Array.from({length: 100}, () => `ECHO ${'q'.repeat(900)}`).join('\n');
const r = await viewer.req('POST', '/api/v1/databases/e2e/workbench', {script});
assert.equal(r.status, 200);
assert.equal(r.json.results.length, 100);
assert.equal(Buffer.byteLength(r.body), 121_404);
```

**Impact:** viewers can repeatedly force much larger allocations than one reply budget. At default settings, a short script reading the same roughly 1-MiB value 100 times can accumulate roughly 100 MiB of payload before JSON serialization. This is a resource-budget gap, not an assertion that the existing per-command truncation is broken.

**Concrete fix:** add an explicit total workbench byte/element budget, debit it across lines including echo/error/encoding overhead, and stop with a bounded truncation result once exhausted. Reserve a slot for the whole script and bound the aggregate memory of active scripts globally. Alternatively deliver bounded incremental results with backpressure and cancellation.

## Low

### L1. Optional RP-initiated logout returns the ID token to the browser

**Locations:** `apps/server/src/auth/oidc.ts:154`, `:164`; `apps/server/src/routes/auth.ts:144`, `:145`.

With `rpInitiatedLogout: true`, the server keeps the raw ID token, adds it as `id_token_hint` to the logout URL, and returns that URL as API JSON. This violates the stated “tokens never reach the browser” boundary. It is an intentional OIDC logout mechanism, but the implementation and unconditional security promise disagree.

**Minimal local test:** `oidc.mjs`, using a local synthetic issuer with an `end_session_endpoint` and a synthetic marker, never a real user's token.

```js
// Configuration: rpInitiatedLogout = true.
const {id, session} = sessions.create({...oidcViewer, idToken: syntheticMarker});
const c = clientFor(app, cookieName, id, session.csrfToken);
const r = await c.req('POST', '/api/v1/auth/logout', {});
assert.equal(new URL(r.json.redirectUrl).searchParams.get('id_token_hint'), syntheticMarker);
```

**Impact:** browser code receives an identity assertion, potentially including personal claims; navigation may also put it into browser history/IdP URL logging. This is **not** evidence of a Redis password, OAuth access token or refresh token leak. The option is disabled by default, which limits severity.

**Concrete fix:** omit `id_token_hint` and use an IdP-supported logout URL based on `client_id` and an approved post-logout URI. Avoid retaining the ID token solely for a browser redirect. If the company explicitly requires the hint, narrow the architecture promise and document/approve the browser-token exposure as an exception.

### L2. Static index loading bypasses the external-symlink check applied to assets

**Locations:** `apps/server/src/routes/static.ts:67`, `:73`, `:78`, `:109`; compare the guarded asset path at `:94`.

Assets are resolved through `realpathSync()` and checked against the real dist root. The special index template is read directly from `path.join(root, 'index.html')`; an index symlink outside dist is followed without that check.

**Minimal local test:** `static.mjs`; both files are disposable fixtures under `/tmp`.

```js
writeFileSync(`${tmp}/outside.txt`, 'AUDIT_FAKE_SECRET_OUTSIDE_DIST');
mkdirSync(`${tmp}/dist`);
symlinkSync('../outside.txt', `${tmp}/dist/index.html`);
const t = await startApp(testConfig({server: {webDist: `${tmp}/dist`}}));
const r = await t.app.inject({method: 'GET', url: '/'}); // anonymous
assert.equal(r.statusCode, 200);
assert.ok(r.body.includes('AUDIT_FAKE_SECRET_OUTSIDE_DIST'));
```

**Impact:** an external index symlink introduced by a deployment artifact or an actor able to change dist can expose a server-readable file to anonymous requests. This is **not** a demonstrated remote path-traversal exploit: creating/changing the symlink is a prerequisite, hence Low severity. No actual secret file was read by this test.

**Concrete fix:** validate the resolved index path against the resolved dist root before accepting/reading it, and fail closed for an external target. Use the validated path consistently; if dist can be modified concurrently, use safe opening/verification rather than a separate check-then-open sequence. Add an index-symlink regression alongside the asset-symlink test.

## Info and deployment qualifications

- Production validation rejects insecure cookies, HTTP public URLs, insecure OIDC issuers and disabled TLS certificate verification. However, **plaintext Redis connections in a production-tagged database remain valid and only warn**, as do default-only Redis credentials, `trustProxy: true`, and local admins without required TOTP. Those are documented, tested exceptions in this revision, not newly discovered bypasses. For the stated security requirement, deployment should enforce verified Redis TLS, per-tier ACLs, bounded proxy trust and admin MFA rather than rely on warning review.
- Only standalone sandbox Redis was exercised independently. Existing cluster/sentinel/mTLS tests were skipped because their topology was absent; their TLS and routing behavior is not qualified by this review. No extra containers were started.
- The custom OIDC issuer tested claim rejection, group shape and flow reuse. Live Keycloak tests exercised normal sign-in/state/browser binding. This was not a malicious-IdP, browser-XSS, frontend or infrastructure audit.
- No evidence established an operator command that the **literal shared static rules** classify as admin, or a viewer CLI command that writes ordinary key data. All static command/subcommand classes matched the enforcement classifier in the independent comparison. H2 is an omitted argument/destination-policy constraint, and H1 supplies the wrong role to otherwise working enforcement.

## What was checked and was correct

These statements apply to the reviewed snapshot and the exercised paths, subject to the findings above.

### Authentication and sessions

- Local passwords use salted Argon2id through Node crypto and constant-time tag comparison; bootstrap password change and required admin TOTP were exercised through real HTTP. Password changes rotate the normal session and revoke other existing sessions in the non-racing case.
- Atomic account lockout, username-case/padding equivalence and concurrent failed guesses passed the existing regression tests. The lock is refreshed after password verification; the remaining stale fields are H1.
- RFC 6238 vectors, replay rejection and two parallel TOTP sign-ins consuming a code only once passed. H1 concerns activation racing password-only login, a different path.
- Random 256-bit session identifiers, hashed lookup IDs, idle/absolute expiry, login rotation and logout invalidation passed. Cookies have HttpOnly and SameSite=Strict; secure mode uses `__Host-` and Secure. Ordinary new requests from disabled users are rejected, and existing SSE streams check session liveness every five seconds.
- Non-admin user-administration access was denied. Self-demotion/self-disable and last-enabled-local-admin protection (when no OIDC fallback exists) passed the admin tests. With OIDC enabled, the code intentionally permits removal of the last local admin; it does not prove that an available IdP admin currently exists.

### OIDC

- Authorization URLs include state, nonce and an S256 PKCE challenge. The token exchange supplies the stored verifier and expected state/nonce.
- The local synthetic issuer's valid token was accepted. Wrong issuer, wrong audience, wrong nonce and expired ID tokens were rejected; every consumed callback, including a failed token-validation callback, was rejected on reuse.
- Existing live Keycloak tests passed tampered state, missing flow cookie, foreign browser binding, callback reuse and no-group login refusal.
- A groups array mapped to viewer and a scalar groups string mapped to operator. A differently cased admin group mapped to no role and was refused: matching is case-sensitive and fails closed. No comma/space splitting was inferred for scalar claims.

### Authorization and command policy

- Existing role/command/database matrices passed; independent requests denied viewer/operator access to CONFIG GET, CLIENT LIST, MEMORY PURGE, LATENCY RESET, ACL LIST and user administration.
- The existing suite tested readOnly across typed operations, bulk deletion, CLI, workbench, publish and administrative write paths, plus production typed-name/reason confirmation. These guards apply correctly when the request's configured database is the actual destination; H2 is the destination escape.
- `maxRole` correctly caps ordinary requests and connection tiers. `CLIENT INFO` in the existing live matrix verified `rc-viewer`, `rc-operator`, `rc-admin`, and admin capped to `rc-operator`. Missing tier credentials return 503 rather than silently choosing a lower tier; configured `default` credentials are explicitly shared and still subject to application policy.
- Independent live metadata checks classified `FT.SEARCH`/`FT.AGGREGATE`, `JSON.GET`, `TS.RANGE`, `BF.EXISTS`, `VCARD` and `VSIM` as read; `FT.CREATE`/`FT.DROPINDEX`, `JSON.SET`, `TS.ADD`, `BF.ADD`, `VADD` and `VREM` as write. On this sandbox both SORT and SORT_RO were blocked by metadata categories; SORT STORE therefore provided no viewer-write bypass.
- Unknown commands/subcommands fail closed. Connection-changing, scripting, replication and module-management commands are blocked by the static policy. All shared static rules were compared against classifier output.
- String lines, string argv and binary argv share classification; the byte-tokenizer and workbench line/quoting regression tests passed. Independent binary SET on disposable e2e succeeded only for the permitted operator path; binary SET on remote-6390 was refused.

### Confirmations

- Independent exact-body mutation and successful-token replay both returned 428; the original exact request executed once. Existing tests also cover session/route/database binding, expiry, typed text, required reason and pending-token caps.
- Confirmation hashes use canonical JSON and exclude only the confirmation field. No argument-substitution or token-reuse bypass was reproduced. H2 does not require a confirmation under the current COPY rule.

### Input, confidentiality and availability

- JSON-only bodies, body limits, strict CLI/auth/admin schemas, prototype-poisoning rejection, null-prototype Redis field maps and malicious field-name regressions passed. Typed operation schemas strip some unknown fields rather than rejecting all of them; this differs from the broad architecture wording, but no authorization exploit from that behavior was established.
- Ordinary static asset dotfile/traversal/external-symlink checks passed; the separate index entry point is L2.
- SSE stream/event/duration limits, subscription message previews, reservation/backpressure regressions, logout termination and security headers passed. The parser regression tests passed the hostile MONITOR/nonce inputs. SCAN COUNT and glob wildcard caps, blocking timeout caps, workbench time budget, CLI concurrent-command limits and analysis sample/concurrency budgets were checked in source/tests. These are not substitutes for the byte-budget gaps in H3/H4/M2.
- CONFIG GET password fields returned `<redacted>` in an independent admin request. INFO sanitization and audit redaction regressions passed. ACL LIST/GETUSER and ACL mutation paths are blocked by the app's subcommand policy; permitted ACL WHOAMI/CAT reveal identity/category information, not stored passwords.
- CLIENT LIST is admin-only; raw CLIENT INFO, ROLE and CLUSTER topology responses intentionally reveal connection/topology information, as the README documents. SLOWLOG/profiler intentionally show truncated command arguments/values to their allowed roles; no blanket claim that Redis values never reach API responses is appropriate for a data-browsing console. No new Redis credential disclosure through these commands was established.
- Request logger redaction and unknown-command/unknown-username/Redis-error audit redaction tests passed. Secret wrappers avoid ordinary JSON/inspection disclosure. The review found the optional ID-token response exception in L1; it did not find a path returning configured Redis passwords.

### Dependencies and cleanup

- Direct external dependencies use exact versions; workspace references are local. The lockfile was unchanged. `pnpm-workspace.yaml` allows dependency builds only for esbuild. Install completed without additional build approvals or source changes.
- Registry audit and server typecheck passed as described above. Optional topology coverage remains unverified.
- Cleanup completed: the audit server exited cleanly after SIGTERM, port 4600 has no listener, and `git -C <repo> worktree remove --force ../redis-console-wt/review-server` succeeded. The review checkout is absent. The temporary live SQLite data directory `/tmp/rc-audit-data` was removed; scratch tests, logs and results remain under `/tmp/rc-audit/`.
