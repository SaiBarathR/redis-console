# Deployment trial: a first-time install of 0.4.0 (2026-10-27)

**Goal:** install the published image the way a new user would, following [INSTALL.md](../INSTALL.md) as written,
and record every place where the guide or the product made that harder than it should be.

**Setup:** a Linux server (Ubuntu 24.04, Docker 29, Compose 5) that already runs several self-hosted applications and
publishes them through a locally managed Cloudflare Tunnel. Image `ghcr.io/saibarathr/redis-console:0.4.0`, pinned by
digest, run with Docker Compose from the example file. Local accounts with TOTP; no identity provider.

**Databases (six Redis-compatible servers found on the host):**

| Server | Where | Login | Configured as |
|---|---|---|---|
| Redis 8.10 | installed on the host, `127.0.0.1` only | none | `dev`, writable (a scratch server) |
| Redis 8.10 | another Compose project (a development stack) | password | `dev`, writable |
| Redis 7.4 | another Compose project (an application's data) | password | `prod`, `readOnly`, viewer |
| Redis 7.2 | another Compose project (a job queue) | none | `prod`, `readOnly`, viewer |
| Redis 7.4 | another Compose project (a task broker) | none | `prod`, `readOnly`, viewer |
| Valkey 8.1 | another Compose project (a job queue) | none | `prod`, `readOnly`, viewer |

The application servers were left exactly as they were (no ACL users, no restarts), so the prod entries use
`"acceptRisks": ["plaintext", "default-credentials"]`. The host's Redis was made reachable from containers by adding the
Docker gateway address to `bind` (with protected mode off, at the owner's choice: it holds throwaway data) and ordering
it after `docker.service`.

## What happened

- The configuration started on the first try (status `ready`). The startup log listed the expected warnings.
- **Through the tunnel:** the bootstrap sign-in led to the forced password change, TOTP enrollment and ten recovery
  codes. Every database showed *connected* with the expected effective role (admin on the two `dev` servers, viewer on
  the four read-only ones).
- **Reads** (`DBSIZE`, key browser, inspector on four keys each) worked on all six, Valkey included. **Writes** were
  refused on the read-only ones by the policy (403, nothing sent to Redis). On the scratch server a `SET`, `GET` and
  a confirmed `DEL` worked, and the key was gone afterwards.
- **Server-Sent Events through the tunnel:** live metrics arrived every 2 s; a Pub/Sub message published through the
  API reached the subscriber's stream in about 2 s.
- **`trustProxy`:** with `false`, the audit log showed the Docker gateway of the console's network for every sign-in.
  With that address set, it showed the real client address, also when the client sent its own `X-Forwarded-For`.
- **Backups:** the documented `node:sqlite` online backup worked, and passed `integrity_check`. The console was also
  added to the host's existing nightly dump job.

## Findings and what changed

| ID | Finding | Change |
|---|---|---|
| F1 | Compose setup assumed a checkout (`cp <checkout>/deploy/…`). | INSTALL 7.2 downloads the two example files from the release tag. |
| F2 | No guidance for Cloudflare Tunnel. | INSTALL 8 "Cloudflare Tunnel": ingress to `127.0.0.1` (the port is IPv4-only), DNS route, `trustProxy`, SSE, body size, Access. |
| F3 | No guidance for Redis servers that belong to other Compose projects. | INSTALL 7.5: external networks, container names; INSTALL 5 "Redis servers you cannot add ACL users to". |
| F4 | A Redis on the host's loopback is unreachable from the container (connection refused), and Redis can start before Docker creates the gateway address. | INSTALL 7.5: `host-gateway`, `bind` with a `-` address, protected mode, `After=docker.service`; troubleshooting row. |
| F5 | A server without a password: the credential shape (`{ "username": "default" }`) was not shown. | INSTALL 5 example. |
| F6 | Read-only use of an application's prod Redis needs both exceptions; only one was shown. | INSTALL 5 example with both, and what each means. |
| F7 | Valkey was not mentioned. | INSTALL 2: read-only use verified on Valkey 8.1; G4. |
| F9 | `gh attestation` is missing from older packaged GitHub CLIs. | INSTALL 3: version note and how to compare the digest instead. |
| F10 | Joining other projects' networks makes the example's `trustProxy: 1` unsafe (their containers reach port 4000 directly). | INSTALL 7.5 and 8: a fixed subnet, trust its gateway address. |
| F11 | Cloudflare injects a script (JavaScript Detections); the CSP blocks it and the browser console shows an error on every page. | INSTALL 8 and troubleshooting: expected, how to turn it off, never relax the CSP. |
| F12 | `docker cp` leaves the backup copy world-readable. | INSTALL 12: `umask 077`, and how to fold the backup into an existing dump job. |
| G1 | A tier configured as `{ "username": "default" }` counted as a per-tier ACL user: a prod database passed the production check without `acceptRisks`, and nothing was logged. | `tierUserProblems()` (server config): such a tier now needs `"default-credentials"`, and the warning says the app enforces the policy alone. Unit tests in `config.test.ts`. |
| G2 | Accepted risks were not logged, although OPERATIONS.md said each is logged at every start. | Each accepted risk is logged, and an exception that is no longer needed is named. |
| G3 | Suspected: the "without TLS" warning ignored `rediss://`. | Not a bug: warnings run on the resolved config, where `rediss://` sets `tls`. No change. |
| G4 | Valkey 8.1 was listed as `7.2.4` (its compatibility `redis_version`). | `server.engine` in the database summary; the picker, status bar and overview show "Valkey 8.1.4" (CONTRACT-CHANGES). |
| G5 | After signing in on `/login`, the address bar kept `/login` (any unknown path did the same). | Unknown paths redirect to `/`. |

F8 (the Compose example lists six secrets that must all exist) needed no change: the guide already says to remove
the entries you don't use.

## Cleanup

The scratch key (`claude:20261027:setup:k`) was deleted (`EXISTS` 0). The bootstrap password was changed at first
sign-in; `bootstrapAdmin` and its secret were removed from the deployment afterwards (INSTALL 11). No other data was
written.
