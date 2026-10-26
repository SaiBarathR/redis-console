# TOTP key ring, recovery codes and admin CLI — notes for the docs rewrite

For the agent rewriting `README.md`, `INSTALL.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` and `AGENTS.md` on
`chore/pub-docs`. Branch `feat/totp-keyring` did not edit those files. Everything below is implemented and tested;
the authoritative operator text is `docs/OPERATIONS.md` §6a and `apps/server/README.md` ("Admin CLI").

## Names (exact)

| What | Name |
|---|---|
| Key ring config | `auth.local.totpEncryptionKeys: [{ "id": "<kid>", "secret": { "env": "VAR" } \| { "file": "/path" } }]` |
| Primary key | `auth.local.totpPrimaryKeyId: "<kid>"` (required with the ring, must be one of its ids) |
| Single-key form (still valid) | `auth.local.totpEncryptionKey: { "env" \| "file" }` = a one-key ring with the implicit id `default`. Not together with `totpEncryptionKeys`. |
| Key id rule | `^[A-Za-z0-9._-]{1,64}$`, unique; 1–16 keys; each secret ≥ 32 characters (`openssl rand -hex 32`) and different from the others |
| Stored format | `v2:<kid>:<iv>:<ct>:<tag>` (strict base64url parts). Still read: `v1:<iv>:<ct>:<tag>` (written by the single key before this change) and clear text (before F-05; only upper-case base32, `^[A-Z2-7]{16,128}=*$`). Anything else is `malformed`: never taken for a seed, startup refuses |
| Crypto | AES-256-GCM; key per ring entry = HKDF-SHA256(secret, salt `rconsole/totp-seed`, info `rconsole totp-seed aes-256-gcm v1`); random 96-bit IV; user id as AAD |
| CLI (any install, from the server's working directory) | `node apps/server/src/cli/admin.ts status [--json]`, `… reset-totp --user <name>`, `… reset-totp --all --yes`, `… rotate-totp-key` |
| CLI (source checkout, pnpm) | `pnpm --filter @rconsole/server admin status [--json]` |
| | `pnpm --filter @rconsole/server admin reset-totp --user <name>` |
| | `pnpm --filter @rconsole/server admin reset-totp --all --yes` |
| | `pnpm --filter @rconsole/server admin rotate-totp-key` |
| CLI options | `--config <file>` (default `$RCONSOLE_CONFIG`), `--data-dir <dir>` (default the config's `server.dataDir` / `$RCONSOLE_DATA_DIR`); relative flag paths are taken from the directory the command was typed in (pnpm's `INIT_CWD` is trusted only when `npm_lifecycle_event=admin` and `npm_package_name=@rconsole/server`). A relative `server.dataDir` resolves against the working directory, as for the server (under pnpm that is `apps/server`). Every command prints `Data directory: <dir>`; a directory without `rconsole.sqlite` is an error (never created). `--force` (rotate only: lock from another host), `--json` (status), `-h` |
| CLI (container image, no pnpm) | running: `docker compose exec rconsole node apps/server/src/cli/admin.ts status`, `kubectl -n rconsole exec deploy/rconsole -- node apps/server/src/cli/admin.ts …`; refusing to start: `docker compose run --rm --no-deps --entrypoint node rconsole apps/server/src/cli/admin.ts status` |
| Package bin | `rconsole-admin` → `apps/server/src/cli/admin.ts`; package script `admin` |
| CLI exit codes | 0 ok, 1 failed, 64 usage (also `--all` without `--yes`), 75 server running (rotate), 78 config |
| Server lock | `<dataDir>/server.lock` (JSON: pid, host, startedAt), written at start, removed on shutdown |
| Refuse-to-start | exit code 78 (same as config errors), on stderr. First line: `[rconsole] refusing to start: <n> local user(s) have a stored TOTP seed that no key of the TOTP key ring can decrypt (their seeds name key id(s) that are not in the ring: <ids>). Nothing was changed.`, then the two ways out and the commands `node apps/server/src/cli/admin.ts status` / `… reset-totp --user <name>` (or `reset-totp --all --yes`), plus the pnpm forms. Counts and key ids only: no user names, user ids, seeds or ciphertext |
| New route | `POST /api/v1/auth/recovery-codes` `{ currentPassword }` → `{ recoveryCodes, me }` (`ROUTES.recoveryCodesRegenerate`) |
| Changed routes (additive) | `POST /api/v1/auth/totp/verify` accepts `{ recoveryCode }` instead of `{ code }`; `POST /api/v1/auth/login` accepts optional `recoveryCode`; `POST /api/v1/auth/totp/confirm` returns `recoveryCodes` |
| Contract | `Me.recoveryCodesRemaining?`, `RECOVERY_CODE_COUNT` (10), `RECOVERY_CODES_LOW` (3), `zRecoveryCode`, `zRecoveryCodesRegenerate`, `RecoveryCodesResponse`, `TotpConfirmResponse.recoveryCodes` |
| Audit actions | `auth.recovery`, `auth.recovery.regenerate`, `system.totp.rewrap`, `admin.cli.reset-totp`, `admin.cli.rotate-totp-key` (CLI user is `cli:<os user>`) |
| DB | migration 3: table `recovery_codes (user_id, code_hash, salt, created_at, used_at)`; `code_hash` = `a2id:m=19456,t=2,p=1$<base64 argon2id>` |
| Web test ids | `recovery-codes`, `recovery-saved`, `recovery-download`, `recovery-toggle`, `recovery-code`, `recovery-remaining`, `recovery-low`, `recovery-password`, `recovery-regenerate` |

## Suggested text

**README / feature list:** "Local accounts: argon2id passwords, TOTP with 10 single-use recovery codes, TOTP seeds
encrypted at rest under a rotatable key ring. A host-side admin CLI resets TOTP when an administrator is locked out."

**INSTALL (local accounts):**

```json
"local": {
  "enabled": true,
  "requireTotpForRoles": ["admin", "operator"],
  "totpEncryptionKeys": [{ "id": "k1", "secret": { "file": "/run/secrets/totp_encryption_key" } }],
  "totpPrimaryKeyId": "k1"
}
```

"Generate the key with `openssl rand -hex 32` and back it up apart from the data directory. The single-key form
`"totpEncryptionKey": { … }` also works (its key id is `default`). Rotation and recovery: docs/OPERATIONS.md §6a."

Rotation (4 steps): 1. add the new key to `totpEncryptionKeys`; 2. set `totpPrimaryKeyId` to it; 3. restart (startup
re-encrypts every seed under the primary, audited as `system.totp.rewrap`); 4. later remove the old key and restart.
Removing a key that still encrypts a seed makes the server refuse to start, naming the key id. From the single-key
form, step 1 is: move the existing key into the ring as `{ "id": "default", "secret": <same ref> }` and add the new one.

Locked out (lost key, or no admin can sign in): on the server host, in the server's working directory and environment,
`node apps/server/src/cli/admin.ts status`, then `… reset-totp --user <name>` (or `--all --yes`), then start the
server; those users enroll again. (Source checkout: `pnpm --filter @rconsole/server admin … --data-dir <dir>`.)

**ARCHITECTURE (auth bullet):** "TOTP seeds: AES-256-GCM under a key ring (Tink / ASP.NET Data Protection style: every
key decrypts, the primary encrypts, each record carries its key id; HKDF-SHA256 per key; user id as AAD). Startup
re-wraps every seed to the primary, all or nothing, and fails closed: if a seed does not decrypt with any configured
key the server refuses to start (count of affected users, missing key ids, recovery commands), so 2FA is never
silently weakened. Recovery codes: 10 per user, 60-bit `xxxx-xxxx-xxxx`, argon2id-hashed under one salt per set,
compared in constant time, consumed by one conditional UPDATE (no replay, also concurrently), same lockout/rate limit as TOTP, audited
`auth.recovery`. Break-glass CLI `apps/server/src/cli/admin.ts` works on the data dir without HTTP; SQLite WAL + 5 s
busy timeout + one short transaction per change make reset/status safe next to a running server; rotate refuses while
`server.lock` names a live process."

**DECISIONS (new entries):**
- *Fail closed on undecryptable TOTP seeds; make it operable with a key ring and a host CLI.* Alternatives: skip
  unreadable seeds (silently turns 2FA off for those users — rejected), single key with manual SQL reset (previous
  state; error-prone). Consequence: removing a key in use or losing a key stops startup until an operator acts.
- *Recovery codes hashed with argon2id under one salt per set,* not one salt per code (would cost up to 10 argon2
  runs per attempt, a DoS lever) and not a keyed HMAC (would tie the codes to the TOTP key ring and break on
  rotation). 60 bits of entropy plus argon2id keeps an offline guess per user expensive.
- *Regenerating recovery codes re-authenticates with the password,* so a stolen session alone cannot mint a second
  factor. It does not sign out other sessions.
- *`admin rotate-totp-key` refuses while a server runs,* because the running server would not know the new primary.
  Restart is the normal path.
- *Seeds are re-wrapped at every start* (not lazily on use), so `admin status` shows when an old key is unused and can
  be removed.

**AGENTS.md:** "Never edit `rconsole.sqlite` by hand to reset TOTP; use `pnpm --filter @rconsole/server admin
reset-totp --user <name> --data-dir <your data dir>`. Never run the admin CLI against a data directory you did not
create."

## Migration notes for existing deployments

- No config change is required. A deployment on `auth.local.totpEncryptionKey` keeps working: at the first start of
  this version every seed is re-encrypted from `v1:` to `v2:default:…` (audited `system.totp.rewrap encrypted=0
  rewrapped=<n> primary=default`). Nobody re-enrolls, nobody is signed out.
- After that start, an older version cannot read the seeds (it only knows `v1:`): roll back only with a pre-upgrade
  backup of the data directory.
- Users enrolled before the upgrade have no recovery codes: Account shows "0 of 10 left" with a warning and generates
  a set after asking for the password.
- The bootstrap admin of a fresh install sees its codes right after enrolling TOTP; the forced page stays until
  "I saved my recovery codes".
- A stored value that is neither `v1:`/`v2:` nor an upper-case base32 clear-text seed now makes startup refuse
  (`admin status` lists it as `malformed`) instead of being encrypted as if it were a seed. Values this project ever
  wrote are never malformed; only a corrupted or hand-edited row is. Fix: `admin reset-totp --user <name>`.

### Upgrading a running deployment step by step

For a deployment that started with a single `auth.local.totpEncryptionKey` (seeds stored as `v1:`):

1. Stop the server and back up the data directory while it is stopped (for example `cp -a data data.pre-keyring`),
   because the first start of this version rewrites the seeds to `v2:default:…` and older versions cannot read those.
2. Install this version and start it exactly as before (same config, same secrets). No config change. Expect one log
   line `TOTP seeds re-encrypted under the primary key` (`encrypted=0 rewrapped=<users with TOTP or a pending
   enrollment> primaryKeyId=default`) and the audit event `system.totp.rewrap`. Sessions stay valid and authenticators
   keep working (verified live: a `v1` seed written by the previous version's `TotpCipher` → restart → the same browser
   session still signed in, the same authenticator code accepted).
3. Each TOTP user opens Account, sees "0 of 10 left" and generates recovery codes with the password.
4. Check with the CLI: `node apps/server/src/cli/admin.ts status` (with `RCONSOLE_CONFIG` exported as for the server)
   or `node apps/server/src/cli/admin.ts status --data-dir <data dir>`. Under pnpm the working directory is
   `apps/server`, so pass an absolute `--data-dir` (a relative `./data` from the config would resolve to
   `apps/server/data`; the CLI refuses a missing directory rather than creating it).
5. Optional rotation to the ring form (no user impact): replace `totpEncryptionKey` with
   `"totpEncryptionKeys": [{ "id": "default", "secret": { "env": "TOTP_ENCRYPTION_KEY" } }, { "id": "k2026-10", "secret":
   { "env": "TOTP_ENCRYPTION_KEY_2026_10" } }], "totpPrimaryKeyId": "k2026-10"` (new value from `openssl rand -hex 32`
   in the secret store), restart, check `admin status` shows only `v2:k2026-10`, then drop the `default` entry and
   restart. Keep `TOTP_ENCRYPTION_KEY` until that last restart succeeded.
6. Roll back = stop, restore the backup, start the previous version.

## Security review (finishing pass, 2026-10-24)

Checked and kept: 60-bit codes from `randomBytes` with `b & 31` (256 = 8 x 32, no modulo bias), argon2id (m=19 MiB,
t=2, p=1) with one random 16-byte salt per set; single use by a conditional `UPDATE … WHERE used_at IS NULL` that runs
synchronously after the account re-check (no await in between), so concurrent sign-ins with one code succeed once;
recovery failures count towards the per-account lockout and share the per-IP / per-/48 / global sign-in rate limit;
lock re-checked right before consumption; regeneration needs the password; codes appear only in the confirm and
regenerate responses (`no-store`), never in logs (bodies are not logged; `*.recoveryCode(s)` redacted as a backstop) or
audit details (counts only); AAD = user id (a value moved to another row or relabelled to another key id does not
decrypt; a `v2` → `v1` relabel decrypts to the same seed for the same user and is re-wrapped, so it gains nothing); key
ids are regex-bound (`^[A-Za-z0-9._-]{1,64}$`, no `:`), looked up in a `Map`; CLI `status` prints formats, key ids,
user names and counts only.

Fixed (each with a regression test):
- Malformed stored values were treated as clear-text seeds and encrypted (`0935bc2`, `totp-keyring.test.ts`).
- Recovery code hashes were matched by SQL equality; now `timingSafeEqual` over the user's unused hashes (`40cf259`,
  `test/unit/recovery-codes.test.ts`). Hardening: not exploitable before (unknown salt), but no longer needs the argument.
- The refusal named only pnpm commands, absent from the image (`0765ab7`); the test also asserts that no user name, id,
  seed or ciphertext appears.
- The CLI trusted any inherited `INIT_CWD`, so a relative `--data-dir` could hit another installation (`915b641`,
  `admin-cli.test.ts`); commands now print the data directory.

