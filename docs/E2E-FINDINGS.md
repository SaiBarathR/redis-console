# E2E findings

Bugs found by the end-to-end suite (`tests/e2e`) against the merged `feat/server` + `feat/web` code. Each confirmed finding has an ID. The tests that hit it call `knownBug('<ID>')` (`tests/e2e/lib/findings.ts`), which marks them `test.fail()`. While the bug is open those tests count as "expected failures", and as soon as the bug is fixed they turn red ("expected to fail, but passed"), which is the signal to remove the marker. Nothing is skipped or hidden.

Severity scale: **Critical** (secret leak, auth bypass, write on read-only/prod), **High** (security control weakened, or a core feature unusable), **Medium** (a feature broken for some roles or flows, or a defense-in-depth gap), **Low** (minor UX or hardening issue).

| ID | Severity | Area | Title | Status |
|---|---|---|---|---|
| F-01 | Medium | server ↔ ACL | Slowlog fails for viewer and operator (`SLOWLOG LEN` denied by the tier ACL) | **fixed** (server falls back when LEN is denied; verified) |
| F-02 | Medium | server ↔ ACL | Search index list fails for viewer and operator (`FT._LIST` denied by the tier ACL) | **fixed** (ACL template grants `+ft._list +ft.info`; verified) |
| F-03 | High | web ↔ server contract | Stream entries never shown in the key browser | **fixed** (stream pagination agreed in the POST `key/read` contract; verified) |
| F-04 | Low | server + web | Renaming onto an existing key silently does nothing but reports success | **fixed** (verified) |
| F-05 | Low | server | TOTP seeds stored in clear text in SQLite | **fixed** (AES-256-GCM at rest, HKDF key from `auth.local.totpEncryptionKey`; verified) |
| F-06 | Low | web | Invalid `pattern` attribute on the username field (console error, client-side validation off) | **fixed** (`-` escaped; verified) |
| F-07 | Low | web | Profiler offered on prod-tagged databases (the server refuses it) | **fixed** (`DatabaseSummary.features.profiler`; verified) |
| F-08 | Medium | web | Login page shows no error for a wrong password, a bad TOTP code or a locked account | **fixed** (login errors and the `session-ended` notice shown; verified) |
| F-09 | High | web ↔ server contract | Integrated build: the web still calls the GET read routes the server removed, so the key browser and related tools fail | **fixed** (web migrated to POST reads and pub/sub subscriptions; verified in the final run) |

**Final status (main, after `9d094ee`): 9 findings, all 9 fixed and verified. The last three (F-05, F-06 and F-07, all Low) were fixed on main; the full suite ran 447 tests, 447 passed, with zero expected failures (no `knownBug` markers left).** No Critical findings. The fixed findings' tests pass and their `knownBug` markers have been removed. In every run, the leak scan found no secret in any of the hundreds of collected JSON, HTML or SSE responses, or in the server log. The read-only proxy confirmed that no non-read command reached 127.0.0.1:6390. Every blocked command and tokenizer trick was refused for admin. CSRF, the CSP, headers, cookies and the role matrix all behaved as specified.

---

## F-01 · FIXED · Medium · Slowlog unavailable for viewer and operator

- **Where:** `apps/server/src/routes/diagnostics.ts` (GET `/databases/:db/slowlog`) and `infra/redis/users.acl.template`.
- **Repro:** as `e2e-viewer` or `e2e-operator`, run `GET /api/v1/databases/sandbox-e2e/slowlog`, or open *Diagnostics → Slow log*.
- **Expected:** 200 with the entries (`SLOWLOG|GET` is classified `read`, and the viewer ACL grants `+slowlog|get`).
- **Actual:** `403 forbidden`: "Redis ACL denied the command: NOPERM User rc-viewer has no permissions to run the 'slowlog|len' command". The route also calls `SLOWLOG LEN`, which neither the viewer nor the operator ACL user allows. Admin works.
- **Fix options:** derive `len` without `SLOWLOG LEN` (or treat NOPERM on LEN as "unknown"), **or** add `+slowlog|len` to the viewer and operator ACL lines (and to `docs/OPERATIONS.md`). Keep the server and the documented ACLs in sync.
- **Tests:** `api/role-matrix.spec.ts` › `slowlog [GET] as viewer -> 200`, `slowlog [GET] as operator -> 200`; `api/features.spec.ts` › `slowlog lists entries…`; `ui/diagnostics.spec.ts` › `as operator › slowlog lists entries`.

## F-02 · FIXED · Medium · Search index list unavailable for viewer and operator

- **Where:** `apps/server/src/routes/modules.ts` (GET `/databases/:db/search/indexes` uses `FT._LIST`) and `infra/redis/users.acl.template`.
- **Repro:** as viewer or operator, run `GET /api/v1/databases/sandbox-e2e/search/indexes`, or open *Diagnostics → Search*.
- **Expected:** 200 with the index list. The shared policy classifies `FT._LIST` as `read`.
- **Actual:** `403 forbidden`: "NOPERM User rc-viewer has no permissions to run the 'FT._LIST' command". `FT._LIST` is in Redis's `@admin` category, and the tier users only have `+@read`. In the UI the index selector stays empty, so search is unusable for non-admins, even though `FT.SEARCH` itself is allowed.
- **Fix options:** add `+ft._list` to the viewer and operator ACL lines (and document it), or fall back to `FT.INFO` on known index names when `FT._LIST` is denied.
- **Tests:** `api/role-matrix.spec.ts` › `searchIndexes [GET] as viewer/operator -> 200`; `api/features.spec.ts` › `search: indexes and query`; `ui/diagnostics.spec.ts` › `as operator › search: run a query against the index`. The admin variants pass.

## F-03 · FIXED · High · Stream entries never shown in the key browser

- **Where:** `apps/web/src/pages/Keys.tsx` (KeyPanel query) ↔ `apps/server/src/routes/keys.ts` (stream branch of GET `/key`).
- **Repro:** open any stream key in the key browser, for example `e2e:stream:orders` (10 entries).
- **Expected:** the entries table lists the newest entries.
- **Actual:** "10 entries · 2 groups" followed by "No results to display." The web always sends `cursor=0` (meant for hash and set SCAN). For streams the server treats `cursor` as an exclusive end ID and runs `XREVRANGE key (0 - COUNT n`, which is always empty. `GET /key?k=…` without `cursor` returns the entries.
- **Fix options:** agree the stream pagination parameter in `packages/shared/src/api.ts` (`cursor` for streams, or the web's `start`), and have the web send it only for streams. The server could also treat `cursor=0` as "from the newest entry".
- **Tests:** `ui/keys.spec.ts` › `view e2e:stream:orders`; `ui/xss.spec.ts` › `stream value with payloads`.

## F-04 · FIXED · Low · Rename onto an existing key silently does nothing

- **Where:** `apps/server/src/routes/keys.ts` (`key.rename` with `nx: true`) and `apps/web/src/pages/Keys.tsx`.
- **Repro:** rename `e2e:scratch:ui-ren-a` to an existing key name.
- **Expected:** a clear error ("destination exists"), with the dialog left open.
- **Actual:** the API answers `200 {"ok":true,"result":{"t":"dbl","v":"0"}}`, the UI closes the dialog as if it had succeeded, and nothing changes. No data is lost, but the user believes the rename happened.
- **Fix:** return a 409 or validation error when RENAMENX returns 0. Also return the result as an integer, not a `dbl`.
- **Test:** `ui/keys.spec.ts` › `rename a key (and refuse to overwrite an existing one)`.

## F-05 · FIXED · Low · TOTP seeds stored in clear text

- **Where:** `apps/server/src/store/users.ts` (`totp_secret` column).
- **Repro:** read `users.totp_secret` from `<dataDir>/rconsole.sqlite`.
- **Expected:** seeds encrypted at rest (for example AES-GCM with a key from the `SESSION_SECRET` secret reference), so that a leaked backup does not also leak second factors.
- **Actual:** the base32 seed is stored as is. Passwords are argon2id-hashed, which is fine.
- **Fix:** `apps/server/src/security/totpCipher.ts`. Seeds (active and pending) are encrypted with AES-256-GCM under a key derived with HKDF-SHA256 from the new required secret reference `auth.local.totpEncryptionKey` (the config had no session-secret reference to reuse). Each record has a random 96-bit IV, and the user id is the AAD, so a ciphertext moved to another row does not decrypt. `UserStore.migrateTotpSeeds()` encrypts legacy clear-text rows at startup and refuses to start if a stored seed does not decrypt with the configured key. Documented in `docs/OPERATIONS.md` (configuration, rotation, checklist); added to the dev, e2e and `deploy/` configs, `scripts/dev-setup.sh` and the CI sandbox script. Unit tests: `apps/server/test/unit/totp-at-rest.test.ts`.
- **Test:** `api/auth.spec.ts` › `secrets at rest: no clear-text passwords or TOTP seeds in the data directory`.

## F-06 · FIXED · Low · Invalid `pattern` on the username field

- **Where:** `apps/web/src/pages/Admin.tsx` (user editor, `user-username` input).
- **Repro:** open *Local users → Add user*.
- **Expected:** no console errors. The browser validates the username format before submitting.
- **Actual:** Chrome logs "Pattern attribute value [a-zA-Z0-9._-]{3,64} is not a valid regular expression … /v: Invalid character in character class". HTML `pattern` is compiled with the `v` flag, where `-` must be escaped (`[a-zA-Z0-9._\-]`). The browser then ignores the pattern, so invalid names are only caught by the server's 400.
- **Fix:** the pattern is now `[a-zA-Z0-9._\-]{3,64}`. The other `pattern` attributes in `apps/web` (`[0-9]{6}` on the TOTP fields in `Auth.tsx`) are valid under the `v` flag. The console allowance for this error in `create a user, change role, disable and re-enable` was removed as well.
- **Test:** `ui/admin.spec.ts` › `user editor renders and validates without console errors`.

## F-07 · FIXED · Low · Profiler offered on prod-tagged databases

- **Where:** `apps/web/src/pages/Diagnostics.tsx` (tool availability only checks the admin role).
- **Repro:** as admin, open *Diagnostics* on `e2e-prod-sim` (environment `prod`, not read-only).
- **Expected:** the Profiler tool is hidden, because `policy.profilerAllowedEnvironments` excludes prod. (It is correctly hidden on `remote-6390`, where the effective role is viewer.)
- **Actual:** the Profiler card is shown. Starting it fails, because the server correctly returns 403 (`api/features.spec.ts` verifies this). So this is cosmetic, not a security issue. Exposing an "allowed tools" flag on `DatabaseSummary` would let the UI hide it.
- **Fix:** `DatabaseSummary.features.profiler` (additive, `docs/CONTRACT-CHANGES.md`), computed by the server with the same check the profiler route enforces (effective role admin and environment in `policy.profilerAllowedEnvironments`). `Diagnostics.tsx` shows the Profiler card only when it is true, and otherwise explains that policy disables it.
- **Test:** `ui/diagnostics.spec.ts` › `as admin › profiler is not offered on prod-tagged databases`.

## F-08 · FIXED · Medium · No error shown for a failed login

- **Where:** `apps/web/src/lib/api.ts` (any 401 except `/auth/me` dispatches `session-expired`) and `apps/web/src/App.tsx` (the handler clears state and re-renders).
- **Repro:** on `/login`, enter a valid username with a wrong password and click *Sign in*. Or exceed the lockout threshold.
- **Expected:** a generic "Invalid username or password, or the account is temporarily locked." message (the server sends exactly that).
- **Actual:** nothing is shown. The 401 from `/auth/login` is treated as an expired session, and the login form is re-rendered without the error. Users get no feedback and can lock themselves out without noticing. The server side is correct: it returns a generic 401 and the lockout is enforced, as `api/auth.spec.ts` verifies.
- **Fix:** don't dispatch `session-expired` for `/auth/login`, `/auth/totp/verify` or `/auth/password` (or for any request made without a session).
- **Tests:** `ui/auth.spec.ts` › `wrong password shows a generic error`, `lockout after repeated failures is shown and blocks the correct password`.

## F-09 · FIXED · High · Integrated build: web still uses the removed GET read routes

- **Where:** `apps/web/src/pages/Keys.tsx`, `Guided.tsx`, `Diagnostics.tsx` ↔ the server change "no Redis data in URLs" (`docs/CONTRACT-CHANGES.md`, 2026-10-24 later).
- **Repro:** merge `feat/server` and `feat/web`, then open the key browser.
- **Expected:** the web uses `POST /keys/scan`, `POST /key/read`, `POST /streams/groups|pending`, `POST /timeseries/range`, `POST /pubsub/channels` and `POST /pubsub/subscriptions` followed by `GET /pubsub/stream?sub=`.
- **Actual:** the web still sends `GET /keys?match=…`, `GET /key?k=…` and so on. The server now answers those with 400 (Redis data in the query string) or 404. In the integrated build the key browser shows no keys, and guided find/inspect, pub/sub, the streams tool and time series fail. The server side is correct: `api/no-data-in-urls.spec.ts` passes for the API.
- **Status:** fixed. The final `feat/web` uses the POST read routes and single-use pub/sub subscriptions. `api/no-data-in-urls.spec.ts` › `the SPA never puts key names in its own URLs or requests` and all key browser, pub/sub, streams and time series UI tests pass.
- **Tests (sample):** `ui/keys.spec.ts` (all key views), `ui/xss.spec.ts` (key list, value viewers), `ui/diagnostics.spec.ts` (pub/sub, streams, time series), `ui/console.spec.ts` (guided find/inspect), `api/no-data-in-urls.spec.ts` › `the SPA never puts key names in its own URLs or requests`.

---

## Notes on the test environment (not app bugs)

- **Shared sandbox:** other agents use the shared `sandbox-e2e` Redis (127.0.0.1:6411) concurrently (`webqa:*`, `rcsrv:*` keys, their own search indexes). The suite therefore runs its `sandbox-e2e` database on a dedicated, identically configured Redis 8 container on 127.0.0.1:6431 (same `redis.conf`, same per-tier ACL users). It never flushes 6411.
- **RediSearch and FLUSHDB:** RediSearch drops every index when *any* logical database is flushed, so fixtures seed db 1 (prod simulation) before db 0.
- **Sign-in rate limit:** the server rate-limits sign-in endpoints to 10/min per IP. All test clients are 127.0.0.1, so the suite paces sign-ins with a mirror of the bucket (`lib/throttle.ts`). This is intended behavior.
- **Context inheritance:** inside Playwright tests, `request.newContext()` inherits `use.storageState`. Logging in from such a context correctly replaces the existing session (anti-fixation). The suite pins an empty storage state for anonymous clients.
