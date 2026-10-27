# Deployment-trial fixes: independent review

Reviewer: Claude Sonnet 5.5 (the author of the change set is a different model). Date: 2026-10-27.
Snapshot: `fix/deploy-trial-learnings @ e78ba2d` (`e78ba2d1507c15819df57e3eab5a1ecaeb8c7fa0`).
Range: `a8a4dae..HEAD`. Two commits landed while the review was running and are included: `029d8fa` (INSTALL 11 and
the QA record: keep two local admins) and `e78ba2d` (a test-only change to an integration test's heap measurement).
Only this report is added by the review; no source, test or doc file was changed.

**No High finding. Two Medium (M1, M2), five Low. Every configuration the old production check refused is still refused
(768 combinations compared, 0 regressions). The routing change and the engine label are sound apart from L1.**

## Scope and environment

Read the local machine rules, `AGENTS.md` sections 2, 4 and 9, then the four commits' diffs in full
(`apps/server/src/config.ts`, `redis/engine.ts`, `routes/databases.ts`, `packages/shared/src/api.ts`,
`apps/web/src/App.tsx`, `lib/engine.ts`, Landing, StatusBar, Dashboard, the new and changed tests, `docs/INSTALL.md`,
`docs/OPERATIONS.md`, `docs/CONTRACT-CHANGES.md`, `docs/qa/v041-deployment-trial.md`), and compared the production
check with `git show a8a4dae:apps/server/src/config.ts`.

Ran: `pnpm --filter @rconsole/server test:unit` (44 files, 636 passed), `pnpm --filter @rconsole/web test`
(42 files, 550 passed), `pnpm --filter @rconsole/shared test` (8 files, 73 passed), `pnpm -r typecheck` (clean).
Scratch scripts, kept outside the worktree, called the real `resolveConfig`, `configWarnings`, `tierUserProblems` and
`serverEngine` under Node 24, and a copy of the old rule. Two throwaway containers (`alpine:3`, created and removed by
name) were used for `docker cp` mode checks. `docker compose config` parsed snippets without starting anything.
Not run: the e2e suite (the author holds its lock), any server on 4000/4400, any Redis connection at all. The e2e specs
and QA tours were read, not run.

## Findings

### M1. A prod database whose `admin` tier is `"username": "default"` is now refused, although viewer and operator have their own ACL users

- **Where:** `apps/server/src/config.ts:677-681` (`tierUserProblems`, the `asDefault` rule), used by the production
  check at `:507-509`.
- **Reproduction** (real `resolveConfig`, `NODE_ENV=production`, `environment: "prod"`, `rediss://`, no `acceptRisks`):
  `credentials: { viewer: { username: "rc-v", password }, operator: { username: "rc-o", password },
  admin: { username: "default", password } }` is accepted by `a8a4dae` and now fails with
  `production: databases.main: admin connects as Redis's "default" user, so Redis cannot enforce that role; give each
  tier its own ACL user, or "acceptRisks": ["default-credentials"] as a reviewed exception`.
  The same script with `viewer: "default"` alone (maxRole `viewer`) is correctly refused; `admin: "default"` with
  `maxRole: "viewer"` is correctly accepted (the tier is unreachable).
- **Impact:** two things. (1) The stated reason is false for this layout: Redis does enforce the viewer and operator
  tiers (separate users); the admin tier is meant to be able to do everything, so "cannot enforce that role" is not what
  is wrong. The real concern, if any, is that `default` is the identity every other client of that server uses, which the
  message does not say. (2) It is a behaviour change for existing deployments: a configuration that started on 0.4.0 stops
  starting after the upgrade, and no upgrade note says so (see L5). The refusal is fail-closed and the message is
  actionable, so this is not a security regression, but it is a judgement call that the fix commit did not state.
- **Suggested fix (owner's decision):** either keep the rule and reword the message for the highest reachable tier
  (for example "admin connects as Redis's built-in `default` user, which every other client of this server also uses"),
  or exempt the highest reachable tier when every lower reachable tier has its own user. Whichever is chosen, add a
  unit test for it and the upgrade note from L5.

### M2. `(umask 077; docker cp …)` does not make the backup copy private; the guide's own next sentence contradicts it

- **Where:** `docs/INSTALL.md:778` (section 12, backups) and the QA record row F12 (`docs/qa/v041-deployment-trial.md`).
- **Reproduction** (Docker CLI on macOS; the client's tar extraction is shared code, not re-run on Linux): a file with
  mode 0644 in a container, copied with `(umask 077; docker cp c:/etc/passwd ./out)`, arrives as `-rw-r--r--`. The same
  copy of a file that is 0600 inside the container arrives as `-rw-------`. So `docker cp` applies the source mode
  after creating the file and ignores the umask.
- **Impact:** the backup contains password hashes, encrypted TOTP seeds and the audit trail, and the guide ships a
  command that looks as if it protects the copy and does not. The prose below it ("`docker cp` keeps the file's mode
  inside the container (0644); restrict the copy yourself (`chmod 600`)") is right, but a reader who runs the command
  as written believes the file is private, and the F12 finding is recorded as fixed.
- **Suggested fix:** make the file private where `docker cp` takes its mode from: add
  `docker exec redis-console chmod 600 /data/backup.sqlite` between the backup and the `docker cp` (verified above), or
  copy into a `mkdir -m 700` directory, or stream it (`docker exec redis-console cat /data/backup.sqlite >
  rconsole-….sqlite` under `umask 077`, where the shell creates the file). Drop the `umask` subshell if it is not kept.

### L1. `serverEngine` throws when `server_name` is `constructor` or `__proto__`, which marks a connected database as `error`

- **Where:** `apps/server/src/redis/engine.ts:6` and `:14` (`NAMES[id] ?? id` on a plain object), called inside the
  connect `try` at `apps/server/src/routes/databases.ts:94`.
- **Reproduction:** `serverEngine({ server: { redis_version: '7.2.4', server_name: 'constructor' } })` throws
  `(NAMES[id] ?? id).slice is not a function`; so does `__proto__` (`NAMES['constructor']` is the `Object` function,
  `NAMES['__proto__']` is `Object.prototype`). `toString`, `hasOwnProperty` and `valueOf` do not throw because the id is
  lowercased first. In the route the error lands in the `catch`: the database is listed with `status: error` and a
  `statusMessage` of the TypeError text, nothing is cached, and every call re-sends `INFO`.
- **Impact:** low. It needs a Redis-compatible server that names itself like an Object property, from a database the
  operator configured; there is no data disclosure and the text is rendered as text. But it is Redis data deciding a
  property lookup, and it is a one-line fix.
- **Suggested fix:** `Object.hasOwn(NAMES, id) ? NAMES[id] : id`, or a `Map`; also ignore an `id` that is not
  `/^[a-z0-9._-]{1,32}$/` (today a name with control characters is passed through, bounded at 32 characters and rendered
  as text only, so this is hygiene).

### L2. INSTALL 7.5's Compose snippet names the service `redis-console`; the example it extends calls it `rconsole`

- **Where:** `docs/INSTALL.md:485` (the snippet), against `deploy/docker-compose.example.yml` (service `rconsole`, project
  name `rconsole`), which section 7.2 tells the reader to download.
- **Reproduction:** the `v0.4` example plus the 7.5 snippet's `redis-console:` service and networks, run through
  `docker compose config`, fails with `service "redis-console" has neither an image nor a build context specified:
  invalid compose project`. The snippet alone parses.
- **Impact:** a first-time reader who adds the snippet to the downloaded file gets a loud error, not a silent one. The
  same family of mismatch exists in section 12 (`docker exec redis-console …` is the container of the plain `docker run`
  in 7.1; the Compose example's container is `rconsole-rconsole-1`), which the Compose-based trial makes more likely to
  be hit.
- **Suggested fix:** use the example's service name in 7.5, and say in section 12 which container name applies to which
  install (`docker compose exec rconsole …`).

### L3. The appendix row for the deployment trial is detached from its table

- **Where:** `docs/INSTALL.md:865-867`: a blank line separates the "Development quick start" row from the new
  "Deployment trial" row.
- **Reproduction:** read the three lines; a Markdown renderer ends the table at the blank line, so the new row renders as a
  paragraph of pipe characters.
- **Impact:** cosmetic, but it is the row that records what was verified. **Fix:** remove the blank line at `:866`.

### L4. `gw_priority` needs a recent Compose and Engine; the guide gives no minimum

- **Where:** `docs/INSTALL.md:487`.
- **Reproduction:** Compose 5.5.0 (this machine) accepts the snippet. Not reproduced on an older Compose or Engine;
  from the Docker documentation as I recall it, the attribute arrived with Compose 2.33 and Engine 28, and older Compose
  rejects the unknown key. Labelled as an unreproduced suspicion.
- **Impact:** a host on Docker 24 to 27 (common on LTS distributions) would fail on the snippet. **Fix:** state the minimum
  next to the snippet, and say what to do without it (put the published-port network first in the list or avoid joining a
  second network).

### L5. Warnings and notes around the new rule are uneven, and the stricter check has no upgrade note

- **Where:** `apps/server/src/config.ts:696-717` (`configWarnings`), `:729-731` (`hasPerTierCredentials`),
  `docs/CONTRACT-CHANGES.md` (new entry has only `api.ts`; the earlier tier rule, M4, is logged under
  "Configuration (no type changes)" at `:690`).
- **Reproduction** (scripts against `resolveConfig` + `configWarnings`):
  1. Dev database `viewer: "default"`, `admin: "rc-a"`: `[]` warnings, because one non-`default` tier makes
     `hasPerTierCredentials` true, although the viewer tier runs as Redis's `default` user.
  2. Non-prod database with `acceptRisks: ["plaintext", "default-credentials"]`: accepted, no warning, so a stale exception
     on a dev or staging entry is never named (the "not needed" check only runs for `prod`).
  3. Prod database with only a `default` entry and `acceptRisks` both: three warnings for one database, two of them about
     the same gap (`only "default" credentials …` and `environment=prod requires per-tier ACL users … (accepted risk
     "default-credentials")`).
  4. A prod database accepted under `default-credentials` with `viewer: "default"` now logs the gap at every start. That
     is intended; the upgrade note is what is missing, since configurations the old check accepted (`viewer: "default"` and
     `admin: "default"` layouts, see M1) refuse to start in the next release.
- **Impact:** noise and a gap in dev visibility; the missing note is an operational surprise at upgrade.
- **Suggested fix:** an entry under "Configuration" in `docs/CONTRACT-CHANGES.md` and in the next release notes naming
  the new refusal and the log lines; optionally let `hasPerTierCredentials` and the "not needed" check cover every
  environment, and drop the generic `only "default"` line when the prod-specific line is printed.

### L6. INSTALL 5 explains the second exception with the wrong reason

- **Where:** `docs/INSTALL.md` section 5, "Redis servers you cannot add ACL users to": "`default` usually may do
  everything. That is why a prod database needs both exceptions".
- **Impact:** `plaintext` is needed because the example URL is `redis://`, not because `default` can do everything; a
  reader with a TLS-enabled application Redis would conclude they need `plaintext` as well. **Fix:** say that
  `plaintext` is for the missing TLS and `default-credentials` for the `default` user.

### L7. Engine label details (cosmetic)

- **Where:** `apps/server/src/redis/engine.ts:13-14`.
- **Observation:** an unknown engine is shown lowercased (`keydb 7.2.4`), and when `<name>_version` is absent the
  compatibility version is shown as that engine's own version while the tooltip then says it is the compatibility
  version. Neither is unsafe. **Fix (optional):** keep the original case for unknown names; omit the engine, or mark the
  version as compatibility, when `<name>_version` is missing.

## Checked and found sound

- **Production check regressions.** The old rule (copied from `a8a4dae`) and `tierUserProblems` were run over every
  combination of `maxRole` (3) and, for each of viewer, operator, admin and the `default` entry, absent, `default`, `a`
  or `b` (768 cases, empty credentials skipped as the schema refuses them). Old-refused and new-accepted: **0**.
  Newly refused: 175, and in every one a tier reachable under `maxRole` uses the username `default` (a property check
  over all cases agrees: `new refuses == old refuses OR a reachable tier is "default"`, 0 mismatches). Edge cases:
  `default` entry plus tiers behaves as before (`{viewer: "v", default: "default"}` with `maxRole: viewer` is accepted;
  a missing reachable tier with a `default` entry is refused); `maxRole` below admin ignores an unreachable tier;
  `viewer` and `operator` both `default` is refused once, with the `default` message, not twice; two tiers sharing a
  non-default user are still refused; non-prod databases are unaffected; `acceptRisks` still silences both rules;
  `{ default: { username: "default" } }` with a plaintext prod URL keeps the old messages. Only M1 is a behaviour
  question.
- **`hasPerTierCredentials`.** Used only by `configWarnings` (`config.ts:702`) and the unit tests. `credentialForTier`
  (the only runtime consumer, `redis/manager.ts:550`) is unchanged, so no connection or authorization decision changes.
- **`{ "username": "default" }` without a password is a valid credential and connects.** `zCredential` makes the password
  optional; the measured transport sends no `AUTH` for `default` without a password (`redis/capped.ts:221`).
- **Routing.** `path="*"` now redirects to `/` and `path="/"` renders the picker. `Login` and the forced
  password/TOTP screen (`Account forced`) are rendered by `Session` without `Routes`, so they are unaffected and keep
  whatever path the user is on; after they finish, `Shell` mounts on `/login` and redirects once with `replace`, so Back
  does not loop. `/db/<unknown>` still reaches `DatabaseBoundary` (the index route redirects to `/overview`, which shows
  "not available to you"). A deep link such as `/db/x/keys` is kept through sign-in. The OIDC callback is a server route
  and returns to `/` (`routes/auth.ts:282`); failures return to `/login?error=…` while signed out, where `Login` reads
  `?error`. A signed-in visit to `/login?error=…` now drops the query, which the picker never used. Every `goto` in
  `tests/e2e/specs` and `apps/web/qa` targets `/`, `/login`, `/db/<id>/<view>`, `/admin/*`, `/account` or `/preferences`
  (all declared routes); the two with odd paths (`xss.spec.ts:125-126`) only assert that nothing executes. The new test
  fails on the old code by reading: the old `*` rendered the picker at `/login`, and the test asserts `pathname === '/'`.
- **Engine label.** `server.engine` comes from `INFO` (Redis data) and is rendered only as React text and a `title`
  attribute; name and version are each cut at 32 characters; the only feature gate in the web
  (`Landing.tsx:84`, `versionAtLeast(db.server?.version, [8, 8])`) and the server (`redis_version` at
  `routes/databases.ts:89`) still use the compatibility version. `server.version` itself is unbounded, as before
  (bounded by the metadata reply cap, rendered as text). The Valkey claim in INSTALL section 2 matches the code
  (arrays stay off for a server reporting 7.2.4).
- **Docs against the code.** `credentials: { viewer: { username: "default" } }` validates; the logged line quoted in
  section 5 matches `configWarnings`; `OPERATIONS.md` now describes the refusal and the new warnings correctly;
  SSE heartbeat every 5 s (`http/sse.ts:97`) and the 12 MiB body limit (`app.ts:42`) match the Cloudflare section;
  `v0.4` exists as a tag and carries both example files; the admin CLI has `status` and `reset-totp` only and
  `bootstrapAdmin` acts only with no local users (`auth/local.ts:8`), as INSTALL 11 says; `gh attestation` and the digest
  comparison command are plausible and not contradicted; the privacy grep from the machine rules finds only
  case-insensitive `/users/` path matches inside API routes and a Dockerfile comment, no host, user or dataset names.
- **Commits.** Messages name the trial findings and carry the attribution line. No stray files.

## Test gaps worth closing with the fixes

- No test fixes the "old refusals still refuse" property. The comparison in the checked list can be a table-driven unit
  test (old rule inlined, or a list of explicit cases) so a later edit to `tierUserProblems` cannot loosen it.
- No test for `admin: "default"` with own viewer/operator users (M1), for `default` entry + shared users, or for
  `server_name` values that are Object property names (L1).
