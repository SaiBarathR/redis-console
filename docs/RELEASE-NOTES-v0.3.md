# Redis Console v0.3

The first public release. Earlier versions were developed privately; their notes are kept in `docs/`.

## What's new

**A project anyone can install**
- The repository is generic: no machine-specific hosts, data or names in code, tests, scripts, config or CI. Private
  setups live in two gitignored files, `config/rconsole.local.json` and `AGENTS.local.md`
  ([GENERALIZATION-NOTES.md](GENERALIZATION-NOTES.md)).
- New and rewritten docs: [INSTALL.md](INSTALL.md) (any server: Docker, Compose, Kubernetes or Node with systemd, Redis
  ACL users, a TLS reverse proxy, OIDC with Keycloak, Entra ID, Okta or Google), [ARCHITECTURE.md](ARCHITECTURE.md), [DECISIONS.md](DECISIONS.md) (the intent and the reason
  behind each choice), [OPERATIONS.md](OPERATIONS.md) (config reference and day-2), a docs index, `CONTRIBUTING.md`,
  and `AGENTS.md` (how agents work, review and test here; `CLAUDE.md` links to it).
- Licensed under Apache-2.0 (`LICENSE`, `NOTICE`). `THIRD-PARTY-NOTICES` lists every bundled dependency and both fonts
  with their licence texts. It is served at `/THIRD-PARTY-NOTICES.txt` (Account → About), shipped in the image, and
  kept current by a CI check.
- **Published image:** `ghcr.io/saibarathr/redis-console:0.3.0` for `linux/amd64` and `linux/arm64`, with an SBOM and a
  signed build provenance attestation ([INSTALL.md §3](INSTALL.md#3-get-the-image)). Release tags publish it
  (`.github/workflows/release.yml`).
- CI runs on GitHub-hosted runners with no external data: typecheck, all unit and integration suites with the cluster,
  Sentinel and mutual-TLS topology, the production image smoke test, and the full Playwright suite against a
  disposable read-only upstream.
- One-command dev loop: `pnpm dev` at the root runs the server in watch mode and Vite on ports that agree
  (`RCONSOLE_PORT`, `RCONSOLE_WEB_PORT`).

**Two-factor authentication you can operate**
- **TOTP key ring.** `auth.local.totpEncryptionKeys` holds several keys with ids, and `totpPrimaryKeyId` picks the one
  that encrypts. Seeds are stored as `v2:<key id>:…` (AES-256-GCM, key derived with HKDF-SHA256, the user id bound as
  additional data) and re-encrypted under the primary key at every start. You can rotate keys without anyone
  re-enrolling.
- **Fail closed.** If a stored seed cannot be decrypted with any configured key, or is malformed, the server refuses to
  start (exit 78). The message gives how many users are affected, the missing key ids and the commands that fix it
  (`admin status` lists the users). It never silently disables someone's second factor.
- **Recovery codes.** Every TOTP user gets 10 single-use codes (`xxxx-xxxx-xxxx`, 60 bits, stored as argon2id hashes).
  They are shown at enrollment, can be used at sign-in instead of an authenticator code, and can be regenerated in
  Account with the password. Account shows how many are left.
- **Break-glass admin CLI** (`rconsole-admin`, or `node apps/server/src/cli/admin.ts`): `status`,
  `reset-totp --user <name>` or `--all --yes`, and `rotate-totp-key`. Every action is audited. See
  [OPERATIONS.md §6a](OPERATIONS.md#6a-totp-keys-and-recovery).
- **One server per data directory.** The server takes `server.lock` in its data directory exclusively before it opens
  the database. A second server or a key rotation on the same directory exits 75 and leaves the running server
  untouched. Stale locks (after a crash, a reboot or a container restart) are recovered automatically.

**Operations**
- **`trustProxy` hop counts work.** A number now means "this many proxies in front": the client is that many
  `X-Forwarded-For` entries from the right (Express semantics). Previously Fastify treated a number as "trust nothing",
  so every client appeared as the proxy. Production refuses counts above 5. Use the proxy's address instead of a count
  when anything other than the proxy can reach the port ([INSTALL.md](INSTALL.md#setting-trustproxy), D18).
- **Audit retention.** `audit.retentionDays` (default 365, 30–36500, or `0` to keep forever) prunes the SQLite audit
  table at startup and daily, in batches, and audits each prune as `system.audit.prune`. The table stays append-only
  otherwise: deletes pass only through a short-lived grant inside the prune transaction, never for rows younger than 30
  days, and updates are always refused. The JSON audit lines on stdout (your SIEM) are not affected.
- **Rate limits explain themselves.** Every 429 carries `Retry-After`. The web app retries rate-limited reads with
  backoff and jitter (never writes), so a busy moment no longer leaves an error on screen.

**Fixes**
- Pressing Enter in the console before command info has loaded waits for it and then runs, instead of reporting
  "unavailable for your role".
- After a TOTP reset, a new authenticator's first code is accepted even in the same 30-second step.

## Upgrade notes

- **Back up the data directory before the first start** (with the server stopped). v0.3 re-encrypts TOTP seeds from
  `v1:` to `v2:default:…`, which v0.2 cannot read. Roll back = stop, restore the backup, start v0.2.
- **No config change is required.** A single `auth.local.totpEncryptionKey` keeps working as key id `default`. To
  move to the ring and rotate, follow [OPERATIONS.md §6a](OPERATIONS.md#6a-totp-keys-and-recovery) or the step-by-step list in
  [TOTP-KEYRING-NOTES.md](TOTP-KEYRING-NOTES.md#upgrading-a-running-deployment-step-by-step).
- **Users enrolled before v0.3 have no recovery codes.** Account shows "0 of 10 left" with a warning; ask each TOTP
  user to generate a set.
- **If you set `trustProxy` to a number,** it now takes effect. Check that the number equals the number of proxies in
  front and that only the proxy can reach the port, or switch to the proxy's address.
- **New config keys, all optional:** `auth.local.totpEncryptionKeys`, `auth.local.totpPrimaryKeyId`,
  `audit.retentionDays`.
- **Audit history:** with the default of 365 days, the first start deletes SQLite audit rows older than a year. Export
  them first, or set `audit.retentionDays: 0`, if you need them in the database.
- **`SESSION_SECRET` is gone.** The server never read it; you can delete it from your environment.
- **The data directory must not be shared** by two running servers (it never was supported); the second now exits 75.
- **API (additive):** `Me.recoveryCodesRemaining`, `recoveryCode` on sign-in and TOTP verification, and
  `POST /auth/recovery-codes`. See [CONTRACT-CHANGES.md](CONTRACT-CHANGES.md).

## How it was checked

- The TOTP key ring was built by one model and reviewed by another (GPT-6.1-Sol, report
  [research/26](research/26-v03-totp-review.md)). Both findings (M1 data directory lock, L2 replay counter after a reset)
  were reproduced, fixed with regression tests that failed before the fix, and verified live. Every verdict is in
  [REVIEW-LOG.md](REVIEW-LOG.md).
- Gates on the final code: `pnpm -r typecheck`; shared 24, web 481, and server 987 tests passed (8 skipped: the
  optional read-only remote suite), with the cluster, Sentinel and mutual-TLS topology up; full Playwright suite 646
  passed, 0 failed, 0 flaky.
- Live in Chromium as viewer, operator and admin, through local accounts and Keycloak SSO, with nginx in front of a
  second instance for `trustProxy`: 0 CSP or Trusted Types violations, 0 page errors ([qa/v03-follow-ups.md](qa/v03-follow-ups.md)).
- The production image was built and smoke-tested with a read-only root filesystem.
