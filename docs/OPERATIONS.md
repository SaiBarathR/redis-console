# Operations guide

Day-2 reference for running Redis Console. To deploy it for the first time, follow [INSTALL.md](INSTALL.md). The
threat model is in [SECURITY.md](SECURITY.md), the design in [ARCHITECTURE.md](ARCHITECTURE.md).

- [1. Runtime facts](#1-runtime-facts)
- [2. Configuration reference](#2-configuration-reference)
- [3. Redis ACL users per tier](#3-redis-acl-users-per-tier)
- [4. TLS](#4-tls)
- [5. Identity provider setup](#5-identity-provider-setup)
- [6. Rotating secrets](#6-rotating-secrets)
  - [6a. TOTP keys and recovery](#6a-totp-keys-and-recovery)
- [7. Backup and restore](#7-backup-and-restore)
- [8. Upgrading](#8-upgrading)
- [9. Logs, audit and SIEM](#9-logs-audit-and-siem)
- [10. Limits and capacity](#10-limits-and-capacity)

---

## 1. Runtime facts

- One process serves the API and the web app from one origin. It keeps local users, sessions (SHA-256 of the ID
  only) and the audit log in `<dataDir>/rconsole.sqlite` (WAL mode). **Run exactly one instance per data directory.**
- Rate limits, confirmation tokens, jobs (analysis, import, delete by pattern) and stream counters live in memory: a
  restart ends running jobs and open streams; sessions survive it.
- `GET /healthz`: liveness. `GET /readyz`: SQLite works and the server isn't shutting down (503 otherwise); it also
  reports `oidc: error` after a failed OIDC discovery attempt (discovery runs on first use), without failing readiness. A Redis outage never fails readiness.
- SIGTERM/SIGINT: stop accepting connections, end Server-Sent Event streams (`event: end`), close Redis pools and
  SQLite; forced exit after 10 s.
- Exit status 78: invalid configuration (every problem is printed), or stored TOTP seeds that no configured key
  decrypts ([section 6a](#6a-totp-keys-and-recovery)). Exit status 75: another server (or `admin rotate-totp-key`)
  owns the data directory; the message names its pid and host, and its lock is left alone.
- The server owns `<dataDir>/server.lock` while it runs. It creates the file exclusively before it opens the database,
  refreshes it every 15 s and removes it on shutdown. A lock is taken over only when it is stale: its process is gone,
  the host has rebooted since, it names the very process starting (a restarted container), or it has not been
  refreshed for 120 s (a reused pid, or a lock written on another host of a shared volume). When the process still
  exists, the lock is watched for one more refresh period first, so a server that was suspended (a sleeping laptop)
  keeps it. A fresher lock from another host cannot be checked, so the server refuses (75) until it expires.

## 2. Configuration reference

The configuration is one JSON file (`RCONSOLE_CONFIG`), validated strictly with zod at startup. Unknown fields, inline
secrets, credentials in URLs and unsafe production settings stop the server with a list of every error. Relative paths
resolve against the working directory. Examples: `config/rconsole.dev.json` (local sandbox),
`deploy/config.prod.example.json`, `deploy/k8s/configmap.yaml`, and the minimal config in
[INSTALL.md](INSTALL.md#6-write-the-configuration).

### Environment variables

| Variable | Meaning |
|---|---|
| `RCONSOLE_CONFIG` | Path to the JSON config. Required by `apps/server/src/main.ts` (the image sets `/etc/rconsole/config.json`). |
| `RCONSOLE_PORT` | Overrides `server.port`. |
| `RCONSOLE_PUBLIC_URL` | Overrides `server.publicUrl`. |
| `RCONSOLE_DATA_DIR` | Overrides `server.dataDir` (the image sets `/data`). |
| `NODE_ENV` | `production` turns on the production checks below (the image default). |
| `LOG_LEVEL` | pino level, default `info`. |
| Secret variables | Whatever the config references with `{ "env": "NAME" }`. |

### Secret references

Every secret is `{ "env": "VAR" }` or `{ "file": "/path" }` (one trailing newline is removed; an empty file or unset
variable is an error). A plain string is rejected. Secrets are read at startup only. The resolved values are wrapped
so that logging a config object prints `<secret file:/path>`, never the value.

### `server`

| Field | Default | Notes |
|---|---|---|
| `host` | `127.0.0.1` | Bind address. `0.0.0.0` in containers. |
| `port` | `4000` | |
| `publicUrl` | required | The exact external origin, without a path (`https://redis-console.example.com`). The only `Origin` accepted on state-changing requests, the cookie scope and the base of the OIDC redirect URI (`<publicUrl>/api/v1/auth/oidc/callback`). Must be `https://` in production. |
| `trustProxy` | `false` | Which peer may supply `X-Forwarded-For`. Either a **hop count** (0–64; at most 5 in production): the number of proxies in front, so the client is that many `X-Forwarded-For` entries from the right (Express semantics; use it only when nothing but the proxy can reach the port), or the **proxy's address**: a proxy IP, a comma-separated list of IPs/CIDRs, or the aliases `loopback`, `linklocal`, `uniquelocal` (`X-Forwarded-For` from any other peer is ignored). In production, CIDRs must be narrow (IPv4 /8 or longer, IPv6 /16 or longer) and `true` is refused. See [INSTALL.md](INSTALL.md#setting-trustproxy). |
| `requestTimeoutMs` | `120000` | Time to receive the whole request, uploads included (1 s–1 h). Does not limit handler or stream duration. |
| `headersTimeoutMs` | `15000` | Time to receive the headers (1–60 s, at most `requestTimeoutMs`). |
| `connectionTimeoutMs` | `30000` | Socket inactivity, including stalled response writes (10 s–1 h; above the 5 s stream heartbeat). |
| `keepAliveTimeoutMs` | `5000` | Idle time after a response (1–60 s). |
| `dataDir` | `./data` | SQLite location. Created with mode 0700, the file with 0600. |
| `sessionTtlMinutes` | `480` | Absolute session lifetime (5 minutes to 7 days). |
| `sessionIdleMinutes` | `60` | Idle timeout (at most the TTL). |
| `secureCookies` | `true` | `__Host-rc_session`, `Secure`, `HttpOnly`, `SameSite=Strict`. With `false` the cookie is `rc_session`. `true` needs an `https` publicUrl (except `localhost`); production requires `true`. |
| `extraAllowedOrigins` | `[]` | More origins accepted on writes (the Vite dev server). Must be https in production; leave empty there. |
| `webDist` | `apps/web/dist` | The built SPA. If missing, the API still works. |

### `auth.oidc`

At least one of `auth.oidc` and `auth.local` must be enabled.

| Field | Default | Notes |
|---|---|---|
| `enabled` | required | |
| `displayName` | `Single sign-on` | Button label on the sign-in page. |
| `issuer` | required | Discovery base URL. Must be https unless `allowInsecureHttpIssuer`. |
| `clientId` | required | |
| `clientSecret` | required when enabled | Secret reference. Confidential client (`client_secret_basic`). |
| `scopes` | `["openid","profile","email"]` | Must include `openid`. |
| `groupsClaim` | `groups` | Read from the ID token, falling back to userinfo. An array of strings, or one string (treated as one group). |
| `roleMapping` | required | `{ "<group>": "viewer" \| "operator" \| "admin" }`. The highest matching role wins; **no matching group means the sign-in is refused**. A leading `/` (Keycloak full group paths) is ignored. |
| `usernameClaim` | `preferred_username` | Shown in the UI and the audit log. |
| `allowInsecureHttpIssuer` | `false` | Local development only; refused in production. |
| `rpInitiatedLogout` | `false` | Logout also returns the IdP's end-session URL, with `client_id` and `post_logout_redirect_uri` = `<publicUrl>/` (register it). No `id_token_hint`: the ID token is never kept, so the IdP may ask the user to confirm. |
| `sessionTtlMinutes` | `server.sessionTtlMinutes` | Shorter absolute lifetime for OIDC sessions (5–10080). Groups are read at sign-in only, so this bounds how long someone removed from a group keeps the role. |

### `auth.local`

| Field | Default | Notes |
|---|---|---|
| `enabled` | required | Local accounts (argon2id via `node:crypto`: m=19 MiB, t=2, p=1). |
| `requireTotpForRoles` | `["admin"]` | These roles must enroll TOTP before using anything else. A user who enrolled is always asked. Recommended: `["admin","operator"]`. Production logs a warning when `admin` is missing. |
| `bootstrapAdmin` | — | `{ username, password: <secret>, displayName? }`. Created only while no local user exists, with a forced password change and then TOTP enrollment. Remove it after the first sign-in. |
| `lockout` | `{ maxAttempts: 5, windowMinutes: 15 }` | Per-account lockout for `windowMinutes`; failed TOTP codes count. Sign-in is also limited per client address (10 per minute) and globally. |
| `minPasswordLength` | `12` | 12–256. Also applies to the bootstrap password. |
| `totpEncryptionKeys` | one of this or `totpEncryptionKey` is required when `enabled` | The TOTP seed **key ring**: `[{ "id": "<key id>", "secret": <secret ref> }, …]` (1–16 keys; ids 1–64 of `A-Z a-z 0-9 . _ -`, unique; each secret at least 32 characters, `openssl rand -hex 32`, and different from the others). Every key can decrypt; the primary encrypts. TOTP seeds are stored encrypted with AES-256-GCM under a key derived from the key's secret with HKDF-SHA256, with a random IV per record and the user id as additional authenticated data, so a copy of the database or a backup does not reveal second factors. Each stored seed names its key id (`v2:<kid>:…`). At startup every seed is re-encrypted under the primary key (older formats and clear-text seeds too). **Back the keys up separately from the data directory**: the server refuses to start if a stored seed cannot be decrypted with any key of the ring (section 6a). |
| `totpPrimaryKeyId` | required with `totpEncryptionKeys` | Id of the key that encrypts new and re-wrapped seeds. Must be one of the ring's ids. |
| `totpEncryptionKey` | — | The single-key form: `<secret ref>`, at least 32 characters. It is a one-key ring whose key id is `default`. Use either this or `totpEncryptionKeys`, not both; to start rotating, move it into the ring as `{ "id": "default", "secret": <the same ref> }`. |

### `policy`

| Field | Default | Notes |
|---|---|---|
| `maxReplyBytes` | 1 MiB | Display budget of console and workbench reply trees (also 10,000 elements). Larger parts are shown truncated. |
| `maxReadReplyBytes` | 16 MiB | Hard cap on the wire bytes of one Redis reply, counted while it is read; overflow closes that socket and returns 413 naming this cap. Also the cumulative budget of typed reads whose results go into one response. Server metadata (COMMAND 2 MiB; INFO and COMMAND DOCS 4 MiB) and stream events have fixed caps of their own. |
| `maxInflightCommands` | 16 | Measured Redis commands and database requests running at once, server-wide; one user holds at most half. Excess work waits up to 2 s in a short queue, then gets 429. |
| `maxStreams` | 64 | Open live streams (Pub/Sub, profiler) and, separately, metrics streams, server-wide. Per user: 3 live and 5 metrics streams. |
| `maxBodiesInFlight` | 256 | Request bodies being received or handled at once (one user: an eighth). Reserved when the headers arrive; full means 429 at once. |
| `maxBodyBytesInFlight` | 48 MiB | Bytes of request bodies over 64 KiB in flight (one user: half, at least 12 MiB; a chunked body counts as its route's limit). Size it for the heap: a JSON body costs several times its size while it is parsed. |
| `maxValueBytes` | 512 KiB | Most bytes "Load full value" returns. The default preview is 64 KiB. |
| `commandTimeoutMs` | 5000 | Per command. Blocking commands get their capped block time (at most 5 s) plus 2 s. |
| `scanBudgetMs` | 300 | Time budget of one key-browser names request; it returns what it found by then, with the cursor. |
| `keyScanThresholdMax` | 100000 | Most keyspace slots one key-names request examines (the browser's "Keys to scan", 10,000 by default, is clamped to it). 1,000–10,000,000. |
| `keyMetaMemorySamples` | 5 | `MEMORY USAGE … SAMPLES n` for key-list sizes. 5 (Redis's own default) keeps the cost per key constant, so collection sizes are estimates. 0 is exact but walks every element of each collection on the Redis server; use it only where collections are small. |
| `profilerAllowedEnvironments` | `["dev","test"]` | The profiler (MONITOR) is admin-only, at most 60 s, and only in these environments. |
| `prodRequiresReason` | `true` | Every write on an `environment: "prod"` database needs the typed database name and a reason (audited). |
| `analysisMaxMs` | 10000 | Time cap of a memory analysis or analysis job. |
| `workbenchBudgetMs` | 30000 | Total run time of one workbench script (and of an import's blocking commands); remaining lines are skipped with `timeout`. |
| `searchDropDeletesDocuments` | `false` | Whether an admin may drop a search index together with its documents (`FT.DROPINDEX … DD`) from the Search tool. The console, workbench and imports never accept `DD`. |

### `audit`

| Field | Default | Notes |
|---|---|---|
| `retentionDays` | `365` | How long the SQLite audit table keeps events: `0` (keep forever) or 30–36500 days. A job at startup and then every 24 hours deletes older rows, oldest first, 5,000 per transaction, and records `system.audit.prune` with the count (`deleted=<n> batches=<n> before=<cutoff> retentionDays=<d>`; a failure is recorded with outcome `error`). Only the SQLite copy is pruned: the JSON lines already sent on stdout to your SIEM are unaffected, so keep long-term history there. See [section 9](#9-logs-audit-and-siem). |

### `databases[]`

At most 200. Hosts, ports and TLS settings exist only here; the browser refers to a database by `id`.

| Field | Default | Notes |
|---|---|---|
| `id` | required | `[a-z0-9][a-z0-9_-]{0,63}`, unique, stable. Appears in URLs and the audit log. |
| `name` | required | Display name, and the text typed confirmations ask for. |
| `description` | — | Display only. |
| `tags` | — | Up to 8 short display labels on the landing page (letters, digits, space, `. _ / -`). No policy meaning. |
| `environment` | required | `dev` \| `test` \| `staging` \| `prod`. Prod: reason and typed name for every write, FLUSHDB refused, profiler refused, red frame in the UI, and the production rules below. |
| `mode` | `standalone` | `standalone` (`url`), `cluster` (`nodes`, or `url` as the seed; db 0 only) or `sentinel` (`sentinels: [{host, port}]`, `masterName`, optional `sentinelCredentials`). |
| `url` / `nodes` | — | `redis://` or `rediss://` host and port. **No credentials, path or query**; don't mix schemes. |
| `db` | `0` | Logical database (0–15). `SELECT`, `MOVE`, `SWAPDB` and `COPY … DB` are blocked. |
| `readOnly` | `false` | Refuses every write and every state-changing admin command, for every role. |
| `maxRole` | `admin` | Effective role = min(user role, `maxRole`). |
| `credentials` | required | `{ viewer?, operator?, admin?, default? }`, each `{ username, password?: <secret> }`. Each role connects as its own tier's ACL user. A missing tier never falls back to another one: the role uses `default` if set, otherwise gets 503 on this database. With only `default`, the app enforces the policy alone (a warning is logged). |
| `tls` | — | `{ ca?, cert?, key?, servername?, rejectUnauthorized }`; `ca`/`cert`/`key` are secret references holding PEM; `cert` and `key` go together. Requires `rediss://`. Verification can't be disabled for prod databases or in production. |
| `poolSize` | `4` | Sockets per tier in each pool (1–32). Streams have their own limits. A FalkorDB database needs 2 or more (3 or more recommended): a long graph query keeps its socket until the engine answers, so the console runs at most `poolSize - 1` of them and refuses graph queries on a pool of one. |
| `acceptRisks` | `[]` | Reviewed exceptions to the production rules: `"plaintext"`, `"default-credentials"`. Each listed risk is logged as a warning at every start. |

### Production checks (`NODE_ENV=production`)

The server refuses to start when:

- `secureCookies` is false, `publicUrl` isn't https, `allowInsecureHttpIssuer` is true, or an `extraAllowedOrigins`
  entry isn't https;
- `trustProxy` is `true`, a broad CIDR, or a hop count above 5 (longer than any real proxy chain, so clients could choose their address);
- any database disables TLS verification;
- an `environment: "prod"` database doesn't use TLS (`rediss://` or a `tls` block), unless `acceptRisks` has `"plaintext"`;
- an `environment: "prod"` database lacks its own ACL user for a tier reachable under `maxRole` (it would connect as
  `default`), or two reachable tiers share one user, unless `acceptRisks` has `"default-credentials"`.

Warnings (logged, not fatal): `trustProxy: true` outside production, prod databases without TLS, databases with only
`default` credentials, and local admins without required TOTP in production.

Use `acceptRisks` only for situations you have assessed, for example a managed Redis on a private link without TLS
(`plaintext`), or a legacy instance where ACL users can't be created yet (`default-credentials`). Keep it per
database, record a reason and an owner, and remove it when the gap is closed:

```json
{
  "id": "legacy-cache",
  "name": "Legacy cache (prod)",
  "environment": "prod",
  "url": "redis://legacy-cache.internal:6379",
  "readOnly": true,
  "maxRole": "viewer",
  "credentials": { "viewer": { "username": "rc-viewer", "password": { "file": "/run/secrets/legacy_viewer_password" } } },
  "acceptRisks": ["plaintext"]
}
```

---

## 3. Redis ACL users per tier

The exact `ACL SETUSER` lines, what each fragment does, the optional Search and Cluster grants, and how to persist
them are in [INSTALL.md § 5](INSTALL.md#5-create-the-redis-acl-users). The project tests against the same rules
(`infra/redis/users.acl.template`).

Day-2 notes:

- Narrow `~*` and `&*` to the key and channel prefixes the console needs (`~app:cache:* ~app:session:*`).
- For a read-only database, configure only a viewer user and set `"readOnly": true, "maxRole": "viewer"`: writes are
  then refused three times (policy, `readOnly`, Redis).
- The operator user needs `+@transaction` for compare-and-set edits (v0.2 upgrade note). Without it, inspector edits
  fail closed with 403 and a hint.
- `CommandDoc.allowed` in the UI reflects the application policy; Redis may still refuse a command its ACL lacks. The
  UI shows Redis's `NOPERM` and keeps the form; it never retries as another user.

## 4. TLS

**Browser → Redis Console:** terminate TLS at the proxy or ingress (TLS 1.2+). In production `publicUrl` must be
https and `secureCookies` true; the server then sends `Strict-Transport-Security: max-age=63072000; includeSubDomains`
and uses the `__Host-` cookie prefix. Proxy examples: [INSTALL.md § 8](INSTALL.md#8-put-a-tls-reverse-proxy-in-front).

**Redis Console → Redis:** use `rediss://` and, when needed, a `tls` block:

```json
"url": "rediss://redis.internal.example.com:6380",
"tls": {
  "ca":   { "file": "/run/secrets/redis_ca.pem" },
  "cert": { "file": "/run/secrets/redis_client.crt" },
  "key":  { "file": "/run/secrets/redis_client.key" },
  "servername": "redis.internal.example.com"
}
```

- `ca` only for private CAs; `cert`/`key` for mutual TLS (both or neither).
- `rejectUnauthorized: false` is refused for prod databases and in production; use it only on throwaway instances.
- The server applies the same TLS settings to the node-redis clients and to its own measured command sockets,
  including every cluster node.
- Server side (Redis): `tls-port 6380`, `port 0`, `tls-cert-file`, `tls-key-file`, `tls-ca-cert-file`,
  `tls-auth-clients optional|yes`.
- Replies the client library reads itself (handshake, `CLUSTER SLOTS`, Sentinel) are not size-measured. Use verified
  TLS for any database outside a trusted network.

## 5. Identity provider setup

Registration and claim setup for Keycloak, Microsoft Entra ID, Okta and Google are in
[INSTALL.md § 9](INSTALL.md#9-connect-your-identity-provider). To check a change: sign in with one user per group (the
top bar shows the role), and with a user in no mapped group, who must land on `/login?error=oidc_no_role`.

## 6. Rotating secrets

Secrets are read at startup, so rotating one means updating the store and restarting.

| Secret | How to rotate | Impact |
|---|---|---|
| Redis ACL passwords | Add the new password to the ACL user (`ACL SETUSER rc-viewer #<new-sha256>`; the user now has two), update the secret, restart Redis Console, then remove the old one (`ACL SETUSER rc-viewer !<old-sha256>`). | None. |
| OIDC client secret | Create a second secret in the IdP, update the store, restart, delete the old one. | Sign-ins in flight during the restart fail and can be retried. |
| Bootstrap admin password | Used only on the first start. Remove it from the config and the store after the first sign-in. | None. |
| Local user passwords | Users change their own under *Account*. Admins can set a new one under *Admin → Users*, which revokes that user's sessions. | |
| TOTP | Admins can reset a user's TOTP in *Users* (also clears their recovery codes). The user then re-enrolls at the next login. Without a working admin account, use `admin reset-totp` on the server host (section 6a). | |
| TOTP encryption keys (`auth.local.totpEncryptionKeys`) | Add a new key to the ring, make it the primary, restart (startup re-encrypts every seed under it), then remove the old key and restart again. Step by step in section 6a. | None: nobody re-enrolls and nobody is signed out. Removing a key that still encrypts a seed is refused at startup. |
| Everyone's sessions | Stop the server, `sqlite3 <dataDir>/rconsole.sqlite 'DELETE FROM sessions'`, start. Restarting alone doesn't end sessions. | Everyone signs in again. |
| Redis TLS client certificates | Replace the files referenced by `tls.cert`/`tls.key` and restart. | |

After any rotation, watch the server log and the audit log for authentication errors. A database showing
`status: error` usually means Redis refused the credentials.

### 6a. TOTP keys and recovery

**Fail closed.** At startup the server re-encrypts every stored TOTP seed (and pending enrollment) under the primary key. If any seed cannot be decrypted with any key of the ring, it **refuses to start** (exit code 78) and changes nothing, so two-factor sign-in is never silently weakened. The same happens for a stored value that is neither an encrypted seed nor a clear-text base32 seed from an old version (corrupted or edited by hand; `admin status` shows it as `malformed`): it is never taken for a seed. The message gives the number of affected users (never names or seeds), the key ids that are missing from the ring, and the recovery commands below. Successful re-encryption is logged and audited as `system.totp.rewrap` (`encrypted=<n> rewrapped=<n> primary=<id>`).

**Rotating the TOTP key** (no user impact):

1. Generate a secret (`openssl rand -hex 32`), store it next to the current one, and add it to the ring. A deployment on the single-key form moves its key into the ring with the id `default` at the same time:
   ```json
   "totpEncryptionKeys": [
     { "id": "default", "secret": { "file": "/run/secrets/totp_encryption_key" } },
     { "id": "2026-10", "secret": { "file": "/run/secrets/totp_encryption_key_2026_10" } }
   ],
   "totpPrimaryKeyId": "2026-10"
   ```
2. Make the new key the primary (`totpPrimaryKeyId`, as above).
3. Restart. Startup re-encrypts every seed under the primary and audits the counts. `admin status` now shows every seed under `v2:2026-10`.
4. Later, remove the old key from the ring (and from the secret store) and restart. If a seed still used it, the server refuses to start and names the key, so nothing breaks silently; put the key back and restart once more.

`admin rotate-totp-key` does step 3 without starting the HTTP server (for example from a maintenance job while the server is stopped). It refuses while a server is running on the data directory, because that server would not know a new primary key; restart the server instead.

**Recovery codes.** At TOTP enrollment every local user gets 10 single-use recovery codes (`xxxx-xxxx-xxxx`), shown once, with Copy and Download (a file built in the browser). At sign-in, *Use a recovery code* accepts one in place of the six-digit code. Account shows how many are left (with a warning at 3 or fewer) and generates a new set after asking for the password, which revokes the old set. Codes are stored only as argon2id hashes (one random salt per set), compared in constant time, consumed atomically (single use, also under concurrent sign-ins), count towards the per-account lockout and the sign-in rate limit like TOTP codes, and are audited as `auth.recovery` (allowed or denied, with the number left, never the code). An admin TOTP reset clears them.

**Break-glass admin CLI.** It runs on the server host against the data directory, without HTTP, and never prints seeds, keys, codes or hashes. It reads the server config like the server does (`RCONSOLE_CONFIG`, with `RCONSOLE_DATA_DIR` applied; a relative `server.dataDir` resolves against the working directory, exactly as for the server), or `--config <file>` / `--data-dir <dir>` (relative to the directory you run the command in). `status` and `reset-totp` need no key, so they work with `--data-dir` alone when the keys are lost. Every command prints the data directory it used, and it never creates a database: a directory without `rconsole.sqlite` is an error.

| Command | What it does |
|---|---|
| `admin status` (`--json`) | Key ids configured (and the primary), stored seeds per format and key id (`v2:<kid>`, `v1`, `plain`, `malformed`), key ids in use that are not in the ring, local users with TOTP and each user's unused/used recovery codes. |
| `admin reset-totp --user <name>` | Clears the user's TOTP seed, pending enrollment and recovery codes, bumps their auth generation (revoking every session and any sign-in in progress) and deletes their sessions. Audited as `admin.cli.reset-totp` (user `cli:<os user>`). The user enrolls again at the next sign-in (forced if their role is in `requireTotpForRoles`). |
| `admin reset-totp --all --yes` | The same for every local user with TOTP state (a seed, a pending enrollment or recovery codes). Without `--yes` it only lists them. |
| `admin rotate-totp-key` | Re-encrypts every seed under the primary key and prints the counts; audited as `admin.cli.rotate-totp-key`. Fails with the same message as startup (nothing changed) if a seed cannot be decrypted. Refused while a server is running on the data directory. |

How to run it:

```bash
# Source checkout, in the directory the server runs in, with the server's environment (RCONSOLE_CONFIG etc.):
node apps/server/src/cli/admin.ts status
node apps/server/src/cli/admin.ts reset-totp --user alice
node apps/server/src/cli/admin.ts reset-totp --all --yes
node apps/server/src/cli/admin.ts rotate-totp-key

# Or through pnpm. The script runs in apps/server, so a relative server.dataDir in the config would resolve there;
# pass --data-dir (relative to where you type the command) unless RCONSOLE_DATA_DIR or an absolute dataDir is set:
pnpm --filter @rconsole/server admin status --data-dir data

# Container image (no pnpm inside; RCONSOLE_CONFIG and RCONSOLE_DATA_DIR are already set), server running:
docker compose exec rconsole node apps/server/src/cli/admin.ts status
kubectl -n rconsole exec deploy/rconsole -- node apps/server/src/cli/admin.ts reset-totp --user alice

# Container that refuses to start (exec is not possible): a one-off container from the same service definition
# (same image, volume, secrets and environment):
docker compose run --rm --no-deps --entrypoint node rconsole apps/server/src/cli/admin.ts status
docker compose run --rm --no-deps --entrypoint node rconsole apps/server/src/cli/admin.ts reset-totp --user alice
# Kubernetes: scale the deployment to 0, then run the same command in a pod with the same image, config, secrets
# and data volume (for example a Job copied from the deployment's pod template, with command
# ["node", "apps/server/src/cli/admin.ts", "status"]); scale back to 1.
```

Relative `--data-dir`/`--config` are taken from the directory the command was typed in: the working directory, or, only when it runs as the `admin` package script, pnpm's `INIT_CWD` (a stale `INIT_CWD` inherited from another pnpm script is ignored, so it cannot point a reset at another installation). The package also declares the bin `rconsole-admin` (`apps/server/src/cli/admin.ts`). Exit codes: 0 done, 1 failed, 64 usage (also `--all` without `--yes`), 75 a server is running (`rotate-totp-key`), 78 configuration.

*Running next to the server.* The database is SQLite in WAL mode with a 5 s busy timeout, and every CLI change is one short transaction, so `status` and `reset-totp` are safe while the server runs: it reads accounts and sessions from the database on every request, so a reset takes effect on the user's next request. The server owns `<dataDir>/server.lock` (pid, host, start time, a random nonce) while it runs ([section 1](#1-runtime-facts)); a second server on the same directory refuses to start and leaves it alone. `rotate-totp-key` takes the same lock for its whole run: it refuses (75) while a server holds it, and no server can start until it has finished. A lock written on another host (a shared volume) and refreshed within the last 120 s cannot be checked; `--force` overrides that case only, never a live process on this host.

**When the server refuses to start** because of TOTP keys:

1. Run `admin status` to see which key ids the seeds use and who is affected (in a container: the `docker compose run` form above).
2. If you still have the missing key, put it back into `totpEncryptionKeys` and start the server. Nobody loses anything.
3. If the key is lost, reset the affected users (`admin reset-totp --user <name>`, or `admin reset-totp --all --yes`), then start the server. Those users sign in with their password and enroll again; tell them their old authenticator entry and recovery codes no longer work.

---

## 7. Backup and restore

`<dataDir>/rconsole.sqlite` (plus `-wal`/`-shm` files while running) holds local users (argon2id hashes, encrypted
TOTP seeds), sessions (hashes only), pending OIDC flows and the audit log. Redis data is not stored here.

- **Online backup** (safe while running):
  - plain host: `sqlite3 <dataDir>/rconsole.sqlite ".backup '/backup/rconsole-$(date +%F).sqlite'"`;
  - container (no `sqlite3` in the image): use `node:sqlite` as shown in [INSTALL.md § 12](INSTALL.md#12-health-backups-upgrades-and-logs);
  - or stop the server and copy the whole directory, including any `-wal` and `-shm` files.
- **Keys are not in the backup.** Keep `totp_encryption_key` (or the v0.3 key ring) in your secret manager, never
  next to the data backup: together they reveal second factors.
- Encrypt backups and restrict access like a production database: they contain password hashes and the audit trail.
- The audit table is append-only: triggers refuse UPDATE, and DELETE except from the retention job, which removes rows
  older than `audit.retentionDays` (365 by default; [section 2](#audit)). Keep long-term history in your SIEM. A
  backup taken before a prune still holds the older rows; SQLite reuses the freed pages, so the file does not shrink
  (run `VACUUM` with the server stopped if you need the space back).
- **Restore:** stop the server, replace the directory contents (owned by uid 1000 in the container), start it.
  Sessions in the backup come back too; delete them (section 6) to force a new sign-in. The TOTP key must be the one
  in use when the backup was taken.
- **Kubernetes:** use PVC snapshots (VolumeSnapshot, Velero), or a CronJob that mounts the PVC and runs the backup.
  RWO volumes require the job to run on the same node.

## 8. Upgrading

1. Read the release notes (`docs/RELEASE-NOTES-v*.md`): new required fields, ACL changes (v0.2 needs `+@transaction`
   for operators), behaviour changes.
2. Back up the data directory (section 7).
3. Build or pull the new image, pinned by digest. Start it once against a **copy** of the data directory with the new
   config in staging. SQLite migrations run automatically at startup (`schema_version`); the config is validated
   strictly, so a removed or new required field is reported before anything starts.
4. Replace the running instance. Never run old and new side by side on one data directory (the Kubernetes example
   uses `Recreate`).
5. Roll back by deploying the previous image with the backup from step 2: migrations are not guaranteed to be
   reversible.

**Upgrading to the TOTP key ring** (versions with `auth.local.totpEncryptionKeys`): no config change is needed. The single `totpEncryptionKey` keeps working as the key `default`; the first start re-encrypts every stored seed from the old format (`v1:`) to `v2:default:…` and audits `system.totp.rewrap`. Users keep their authenticators and sessions. Users enrolled before the upgrade have no recovery codes yet: Account shows "0 of 10 left" with a warning and generates them. After that start, an older version cannot read the seeds any more (it only knows `v1:`), so roll back with the backup from step 2.

## 9. Logs, audit and SIEM

The server writes JSON lines to stdout and stderr:

- **Operational logs** (pino): startup, warnings, request summaries with the method, the path (no query string) and
  the status. Cookies, authorization and CSRF headers, bodies and query strings are dropped. Redis error text is
  reduced to its code (`redis_error: SEARCH_SYNTAX`), because it can quote user data.
- **Audit events** carry `"audit": true`:
  ```json
  {"audit":true,"id":"812","at":"2026-10-23T09:12:44.120Z","userId":"…","username":"ada","ip":"10.1.2.3","action":"cli.exec","databaseId":"orders-prod","command":"SET","argvRedacted":["SET","key#3f9a1c2b4d5e","<12 bytes>"],"keyCount":1,"outcome":"allowed","reason":"INC-1234 fix stuck flag"}
  ```
  The command name and a known subcommand are kept; keys become `key#<first 12 hex chars of SHA-256>`; every other
  argument becomes `<n bytes>`. Unknown command names become `<unknown command>` (they may be a pasted value). Redis
  errors are recorded by code only. Failed sign-ins with an unknown username record `unknown` and a hash.
  Outcomes: `allowed`, `denied`, `error`, `confirmation_required`.

What is audited: sign-in, sign-out, failures, lockouts and revocations (`auth.*`), every console and workbench command
(`cli.exec`, `workbench.exec`, `import.exec`),
typed operation and data read (key reads and scans, stream and time-series reads, searches, slow log reads, channel
listings; one event per request, counts only), confirmations with their reason, bulk deletes and jobs, profiler and
Pub/Sub stream start and stop, and user management. Polled server metadata (overview, clients, search index list,
command docs) is not audited.

Collect container stdout with your log agent (Fluent Bit, Vector, Datadog, the OpenTelemetry collector, …) and route
lines with `audit == true` to the SIEM. Useful alerts:

- repeated `outcome=denied` on `cli.exec`/`workbench.exec` from one user (probing blocked commands);
- bursts of denied `auth.login` (the detail says when an account became locked), any `auth.revoked`;
- any `allowed` write on a `prod` database, with its `reason`;
- `profiler.start`, `client.kill`, `slowlog.reset`, `key.bulk-delete.start`, `search.index.drop`, a `FLUSHDB`
  command, and `admin.user.create` / `admin.user.update` (role changes, disables, resets).
- `auth.recovery` (a recovery code was used, or refused), `admin.cli.reset-totp` and `admin.cli.rotate-totp-key` (break-glass CLI on the host), `system.totp.rewrap`
- `system.audit.prune` (the retention job deleted old SQLite audit rows; the count is in the detail): expect at most
  one a day plus one per restart; anything else, or `outcome=error`, deserves a look.

Admins can browse the audit log in the UI (*Admin → Audit log*) with filters by user, database, action and outcome.
It shows what the SQLite table still holds: `audit.retentionDays` (365 by default) of history.

**Retention.** The SQLite table is append-only for the application: triggers abort any UPDATE, and any DELETE except
the retention job's. Each of the job's batches runs in one transaction that inserts a grant row naming the cutoff,
deletes up to 5,000 rows older than it, and removes the grant before it commits, so no other connection ever sees a
grant; the trigger itself refuses to delete a row younger than 30 days, whatever the configuration says. The job runs
at startup and every 24 hours; `retentionDays: 0` turns it off. It is audited as `system.audit.prune` with counts.
Nothing is removed from the stdout stream.

## 10. Limits and capacity

The defaults suit a team-sized deployment in 768 MiB. The full list of per-user limits is in
[ARCHITECTURE.md](ARCHITECTURE.md#7-availability-guards); the ones you can tune are under [`policy`](#policy).

- Memory is bounded by the wire cap (`maxReadReplyBytes`) times the commands in flight (`maxInflightCommands`), plus
  bodies in flight (`maxBodyBytesInFlight`) and decoding overhead. Raise them together with the heap
  (`--max-old-space-size`) and the container limit.
- Closing a socket bounds the server's memory; it does not stop work Redis already started. `keyMetaMemorySamples: 0`
  and large SCAN thresholds cost Redis time even after the request is gone.
- Each 429 names the limit it hit and carries `Retry-After` (seconds). The web app retries reads after it with
  jittered backoff, so brief bursts (a refresh that starts several reads at once) recover on their own; it never
  retries writes. Repeated 429s for one user usually mean a script or several tabs; server-wide ones
  mean the budgets are too small for the load.
