# v0.3 TOTP key ring, recovery codes and host admin CLI review

Reviewed 2026-10-24 by GPT-6.1 (independent review task), against `release/v0.3` at `0f0e571cd9cbc4afd2d97700148f6207e2c5aa6c`. Source checkout: `../redis-console-wt/v03-review`, detached and unchanged. No implementation fixes or commits were made.

**Result: one Medium availability issue and one Low reset correctness issue, both reproduced. No authentication bypass or recovery-code disclosure was found in the exercised paths.**

## Findings, by severity

### M1 — A failed second server start replaces the live server's lock, allowing unsafe key rotation

**Locations:** `apps/server/src/store/lock.ts:21–30` (unconditional overwrite and PID-based cleanup), `apps/server/src/app.ts:141–149` (migration before writing the lock), `apps/server/src/cli/admin.ts:224–237` (advisory check followed by migration), `apps/server/src/main.ts:55` (listen occurs after these operations).

**Reproduction, using an isolated data directory and port 4800:**

1. Create a local user with an encrypted TOTP seed. Configure the server with only key `old`, and start server A on that data directory. Prepare a separate rotation config containing `old` plus `new`, with `new` primary.
2. While A is running, run `node apps/server/src/cli/admin.ts rotate-totp-key --config <rotation-config> --data-dir <scratch-dir>`. It correctly returns **75**.
3. Accidentally launch the same server command again, with A's original config, data directory and port. Server B writes its PID over A's `server.lock`, then fails to bind with `EADDRINUSE`, exiting **1**. The lock now names B's dead PID. A remains alive.
4. Repeat the rotation CLI command. `serverState()` treats B's lock as stale and rotation returns **0**, rewriting the seed to `v2:new`.
5. Submit `POST /api/v1/auth/login` for the enrolled user to A, with the correct password. Its response changes from **200** (`totpRequired`) before rotation to **500** after rotation: A has no `new` key.

**Observed evidence:** reproduced three times. In the final run A PID **40427** stayed alive; B PID **40430** exited 1 with `EADDRINUSE`; `server.lock` named B; rotation changed from exit 75 to exit 0; the stored key became `v2:new`; sign-in changed from 200 to 500. Both processes were subsequently stopped/exited. The earlier runs produced the same result.

**Expected:** a failed duplicate start must not replace the live owner's lock or allow rotation while that owner is alive. Startup must also avoid rewrapping a database used by a server with a different key ring.

**Impact:** a routine duplicate launch, followed by otherwise documented offline rotation, can break authentication and authenticated requests for users with encrypted TOTP state on the original server. This needs host/operator activity; it is not a demonstrated remote unauthenticated exploit. A second server with a new primary can also reach migration before its bind failure; that ordering is visible in source, whereas the CLI sequence above was tested end to end.

**Minimal fix:** acquire exclusive ownership of the data directory **before** seed migration, using atomic lock creation/ownership and safe stale-lock recovery; refuse another live owner. Hold that ownership until shutdown and release only the exact owned lock. Have offline rotation acquire the same exclusive maintenance lock, rather than only checking an advisory marker, so startup and rotation cannot race. Preserve foreign-host refusal and restrict `--force` to the documented case. Add a two-process regression: A running → duplicate B fails → A remains the owner → rotation still returns 75 and A can authenticate.

### L2 — Reset retains the old authenticator's replay counter and rejects a new authenticator's valid code

**Locations:** `apps/server/src/store/users.ts:243` (`resetTotp` leaves `totp_last_step` intact), `apps/server/src/routes/auth.ts:353–355` (new enrollment verifies against that old step).

**Reproduction, real HTTP plus the host CLI, for viewer/operator/admin:**

1. Enroll TOTP and confirm at time step `S`; the account stores `totp_last_step = S`.
2. Run `node apps/server/src/cli/admin.ts reset-totp --user <name> --data-dir <scratch-dir>` while the server runs. Sign in again, then `POST /api/v1/auth/totp/enroll` to obtain a different seed.
3. Within the same time step, submit the new authenticator's valid code to `POST /api/v1/auth/totp/confirm`.
4. Observe **400, `Invalid code.`**, because step `S` is rejected as replayed even though this is a different seed. A code for `S+1`, within the normal verification window, returns **200**.

**Observed:** all three roles reproduced 400 for the new seed at the old step and 200 at the next step. The HTTP probe generated both codes locally and never printed either seed or code. The shared reset implementation affects the host CLI and HTTP admin reset.

**Expected:** replay protection for a removed seed must not reject codes belonging to a newly enrolled seed.

**Impact:** transient, confusing failure immediately after a break-glass/admin reset. Ordinarily this clears at the next 30-second step; accepting a future step for the old seed can extend the wait. No bypass or disclosure was demonstrated.

**Minimal fix:** include `totp_last_step = 0` in the reset transaction. Add a fixed-clock regression confirming a new seed in the same step after reset, while preserving replay rejection for repeated use of an unchanged seed.

## What is correct

### Seed encryption, parsing and migration

- AES-256-GCM uses HKDF-SHA256-derived 256-bit keys, random 96-bit IVs and 128-bit tags. User ID is authenticated as AAD. Independent probes and the unit tests rejected copying a ciphertext to another user and changing its key ID to a different configured key.
- The v2 parser requires the expected component count, a bounded key ID and the base64url alphabet. Decryption checks IV/tag byte lengths and authenticates the ciphertext. Missing IDs, corrupt tags, wrong keys and malformed versions fail closed. Key configuration rejects duplicate IDs, duplicate secrets, invalid IDs, missing/unknown primary IDs, short secrets, mixed single/ring forms and rings outside 1–16 entries.
- Key IDs are routing metadata; the AES derivation is deliberately unchanged from v1 and uses the secret, while AAD contains the user ID. The format version and key ID are not themselves in AAD. Distinct secrets in a configured ring prevent simple relabelling to another key from decrypting. A legitimate rewrap preserves the seed and does not change account generation or end sessions.
- The single-key form becomes key ID `default`. An independently constructed v1 ciphertext and a plaintext pending seed migrated together with counts `rewrapped=1, encrypted=1`; the decrypted seed was preserved.
- Migration uses `BEGIN IMMEDIATE`, examines both active and pending seeds, authenticates records already under the primary too, and applies updates only after all records pass. An unknown-key record prevented a different plaintext record from being rewritten; the stored seed snapshot remained identical.
- A separate real `main.ts` process with the required key removed exited **78**, left the seed unchanged, and named the affected count and missing key ID. Its refusal output contained none of the tested username, user ID, password or key secrets. The implementation emits counts and syntactically restricted key IDs, not stored ciphertext or seeds.
- **Legacy compatibility boundary:** any stored value matching the permitted uppercase base32 legacy grammar is accepted and encrypted. Startup cannot distinguish a genuine old plaintext seed from an attacker-written value with the same grammar. The independent malformed-value checks rejected wrong-case/version prefixes, separators and arbitrary text. Consequently the promise is strict format rejection and ciphertext authentication, not protection against arbitrary SQLite writes through the legacy plaintext path. Plaintext legacy records have no user-binding until migrated.

### Recovery codes

- Each of ten distinct codes has twelve independently sampled Crockford base32 symbols: **60 random bits per code**, with unbiased `byte & 31` selection over 32 symbols. Hyphens add readability; case and documented look-alike normalization do not reduce generated entropy.
- Storage contains only argon2id hashes: memory 19,456 KiB, two passes, parallelism one, 32-byte outputs, with a fresh 128-bit salt per set. Sharing a salt within a set permits one expensive hash per guess; it does not tie recovery to encryption-key rotation. Generation hashes codes sequentially.
- `consumeRecoveryCode` compares all unused same-format hashes using `timingSafeEqual`, then uses a conditional `UPDATE ... used_at IS NULL`. Three simultaneous real HTTP sign-ins using one code returned **[200, 401, 401]** for each role. The integration suite additionally exercises three rounds of simultaneous use and replay rejection. The conditional update also protects against a second SQLite writer winning first.
- Both password-plus-code login and the pending TOTP step accept recovery codes. A wrong password does not consume a valid code. A used/replaced code is rejected. Account generation, disabled/TOTP state, lockout and pending-session liveness are checked again after asynchronous hashing.
- Recovery failures share account lockout and the sign-in limiter. Real HTTP probes locked each role after five wrong codes; correct password plus a valid unused code was then refused with 401 without consuming it. The focused rate-limit integration test passed its expected sequence **401, 401, 401, 429**. Live browser automation also encountered the normal 429 limit during a fast multi-role run; the completed run respected that cadence.
- Regeneration requires an active local session, enabled TOTP, CSRF and the current password. A wrong password returned **403** and retained the old set. Successful regeneration returned ten new codes and revoked the old set. CLI reset during regeneration's hashing caused **401**, leaving TOTP/codes cleared. These checks passed over real sockets for all three roles.
- Enrollment and regeneration are the only intended plaintext-code response points. `/auth/me` exposes a remaining count; user inventory and CLI status expose counts/formats. No retrieval endpoint for old plaintext codes was found.
- On the port-4700 instance, log/audit scans against the exercised passwords, seeds, displayed codes, normalized codes and current database hashes found **zero matches**. There were 40 stored recovery hash rows and 56 audit rows at that check. The isolated HTTP probes separately checked audit records and CLI output against generated codes and hashes. Audit entries contain action/outcome/count metadata, including `auth.recovery` and regeneration, without codes or hashes.

### Host CLI and session effects

- Explicit relative `--config`/`--data-dir` paths resolve from the invocation directory, using `INIT_CWD` only under the matching `admin` package lifecycle. Environment/config paths follow the server's working-directory semantics. The CLI refuses a directory without `rconsole.sqlite`; it does not silently create a new installation. Existing tests cover direct invocation, stale `INIT_CWD`, relative flags and actual `pnpm --filter @rconsole/server admin` execution.
- A relative config `server.dataDir` under pnpm still resolves from `apps/server`, as documented. Operators must supply the server's environment or explicit data path; the CLI cannot infer which installation an operator intended. It reports the resolved directory, including structured `dataDir` under `status --json`.
- `status` and `reset-totp` work without decryption keys when supplied a data directory and no config. They use SQLite WAL and a 5-second busy timeout. Live CLI resets were exercised next to a running HTTP server; a reset transaction cleared seeds, pending enrollment and recovery codes, bumped auth generation and removed sessions.
- In the real HTTP probes, **both existing sessions** became 401 after CLI reset, and an in-flight regeneration was refused. Integration tests also cover reset racing enrollment confirmation and recovery sign-in. Startup rewrap preserves sessions. Regeneration revokes the old code set and deliberately preserves existing sessions; two real sessions remained 200 after regeneration. This matches the documented policy.
- The HTTP admin route has an explicit exception for **self-reset**: it retains the current admin session at the new generation and revokes the user's other sessions (`routes/admin.ts:114–116`). The host CLI has no such exception. This distinction is source-verified; the self-reset exception was not separately browser-tested in this review.
- `reset-totp --all` without `--yes` returned **64**, listed the targets and left all three enrolled accounts intact. Adding `--yes` returned **0** and removed every target's TOTP/recovery state. A nonexistent user returned **1**, unknown command returned **64**, and status returned **0**. Startup configuration/seed refusal returned **78**; ordinary rotation beside a valid live lock returned **75**.
- Existing CLI tests passed for dead PID locks, live same-host PID locks (including refusal with `--force`) and foreign-host locks (`--force` permitted only there). M1 qualifies this protection: the lock lifecycle itself is not exclusive and can lose the live owner.
- Reset and rotate produce audit entries identifying `cli:<OS user>`, action, target/count and outcome. Rotation failure writes an error audit entry. Output omits keys, seeds, recovery codes and hashes. Status intentionally exposes local usernames and second-factor inventory to the host operator.

### Browser behavior

Real headless Chromium checks against the built SPA at `http://localhost:4700`, using the prescribed QA accounts:

| Role | Flow exercised | Result |
|---|---|---|
| Viewer | Optional TOTP enrollment, initial code display, Copy, Download, dismissal/reload, recovery sign-in | Passed; 9 codes left after sign-in |
| Operator | Optional TOTP enrollment, initial code display, Copy, Download, dismissal/reload, recovery sign-in | Passed; 9 codes left after sign-in |
| Admin | Password-gated regeneration, code display, Copy, Download, dismissal/reload, recovery sign-in | Passed; 9 codes left after sign-in |

- The displayed ten codes existed in component memory. Saving dismissed the panel; reloading did not retrieve them. The password field was cleared when regeneration succeeded.
- Copy passed the exact newline-separated code list to the real `navigator.clipboard.writeText`, and that call resolved. A test wrapper observed the write without replacing its behavior. Reading the clipboard from the app was blocked by its Permissions Policy; the final copy check did not weaken that policy.
- Download produced `redis-console-recovery-codes.txt`, with the correct username and every code. It is created locally with a Blob; the object URL is revoked. Test downloads were removed.
- “Use a recovery code” switched the pending sign-in form and accepted an uppercase saved code. Successful sign-in cleared the input and showed the decremented remaining count.
- `localStorage` and `sessionStorage` contained none of the displayed codes or their canonical forms, both while displayed and after recovery sign-in. No persistence of codes was found in source. Explicit user Copy/Download naturally places them in the clipboard/download file.
- Completed browser checks recorded **zero page errors and zero CSP violations** for each role.

## Validation and limits

- `pnpm install`: passed, pnpm **11.7.0**, Node **v24.14.1**.
- `pnpm --filter @rconsole/web build`: passed (including web TypeScript checking).
- `pnpm --filter @rconsole/server typecheck`: passed.
- `pnpm --filter @rconsole/server test:unit`: **35 files, 552 tests passed**.
- Focused server integration command: `pnpm --filter @rconsole/server exec vitest run test/integration/recovery-codes.test.ts test/integration/auth.test.ts test/integration/security-auth.test.ts`: **3 files, 43 tests passed**.
- `pnpm --filter @rconsole/web test`: **32 files, 467 tests passed**.
- `pnpm audit --json`: **0 vulnerabilities** at all severities.
- Additional independent Node probes used real HTTP sockets on **4800/4900**, disposable SQLite directories and generated fixture accounts. They reproduced M1, L2 and the successful behaviors listed above. There were no Redis mutation requests in these auth-only probes; no Redis fixtures or containers were created.
- The prescribed main QA server ran on **4700**, `/tmp/rc-v03-review`, with an absolute path to the generic dev config and sourced `.env`. `scripts/qa-accounts.mjs http://localhost:4700` provisioned all four QA accounts through Keycloak/admin APIs. No owner account or owner data was used.
- T3 preview navigation worked, but two snapshot attempts failed with `Preview automation snapshot timed out after 15000ms.` Browser checks therefore used the repository's Playwright Chromium package. An initial clipboard-read probe hit the expected Permissions Policy restriction; a later fast multi-role run hit expected HTTP 429. Neither was treated as a product failure; the final completed checks above cover the relevant behavior.
- Full Redis integration/E2E, cluster/Sentinel failover, Docker/Kubernetes deployment execution, multi-host shared-volume behavior, physical mobile and screen-reader testing were outside this focused review. Foreign-host lock handling was covered by unit tests, not an actual second host. This is not a qualification of every release gate.

## Cleanup

- Sent SIGTERM only to the review-owned port-4700 server, PID **28794**. It reached its 10-second graceful-shutdown timeout and exited **1**; its pnpm parent also exited. This shutdown behavior was observed during cleanup and was not investigated as part of the TOTP review.
- The custom HTTP fixture closed its app/database; each duplicate-start/rotation probe stopped its own surviving server by PID. Verified no listeners remained on **4700, 4800 or 4900**, and the final recorded probe/server PIDs were absent.
- Removed the explicitly owned `/tmp/rc-v03-review`, three HTTP fixture directories, three lock fixture directories, temporary probe scripts, logs, downloaded files and credential/code files. No containers or Redis keys needed deletion. Unrelated scratch paths were left alone.
- Before removal, `git diff --exit-code` and `git status --short` confirmed the review checkout's tracked files were unchanged. Ran the requested `git -C <repo> worktree remove --force ../redis-console-wt/v03-review` successfully and verified the path was absent.
- Port 4000 and the owner's `<repo>/data` were not used or modified. The main checkout receives only this uncommitted report; no commits or pushes were made.

**Release recommendation: hold v0.3 until M1 is fixed and verified; fix L2 alongside it if practical.**
