# @rconsole/e2e: end-to-end and API security suite

Playwright (Chromium, headless) against the real server and the built SPA, in the production-style single-origin setup.

## Run

```bash
pnpm install
pnpm --filter @rconsole/e2e exec playwright install chromium   # once
pnpm test:e2e                                                   # everything, headless, HTML report
pnpm --filter @rconsole/e2e report                              # open tests/e2e/playwright-report
```

Prerequisites: Docker and the sandbox from `scripts/dev-setup.sh` (`.env` and Keycloak on :8089). No external Redis or owner data is needed. The harness starts a disposable seeded Redis behind the read-only proxy by default. Acquire `/tmp/rconsole-e2e.lock` before local runs when sharing this machine with other agents.

Useful variations:

```bash
cd tests/e2e
npx playwright test --project=setup --project=api        # API/security tests only (~6 min)
npx playwright test specs/ui/keys.spec.ts                # one file (setup runs first automatically)
npx playwright test -g "blocked"                         # by title
RC_SCREENSHOTS=1 npx playwright test --project=screenshots   # regenerate docs/screenshots

# Fast iteration: keep a stack running, then attach specs to it
pnpm --filter @rconsole/e2e serve                        # terminal 1 (Ctrl-C stops it)
RC_E2E_ATTACH=1 npx playwright test --project=setup      # terminal 2: bootstrap accounts once
RC_E2E_ATTACH=1 npx playwright test --no-deps specs/ui/console.spec.ts
```

## What global setup does

1. Wipes `.state/` and `.data/` (the server's SQLite dir), so every run starts with a fresh bootstrap admin.
2. Starts a dedicated Redis 8 container `rconsole-e2e-redis` on **127.0.0.1:6431**. It has the same `redis.conf` and per-tier ACL users (`rc-viewer`, `rc-operator`, `rc-admin`) as the infra `redis-e2e` sandbox, but other developers and agents don't share it.
3. Starts a **read-only RESP proxy** on 127.0.0.1:6430. By default its upstream is a new disposable Redis container on a dynamically allocated loopback port, seeded with strings, a hash and a list. To test an external upstream, explicitly set `RC_E2E_REMOTE_HOST`, `RC_E2E_REMOTE_PORT`, and a password (see below). If that target cannot be reached/authenticated, the harness falls back to the disposable fixture. Only Redis `readonly` commands and a short connection/introspection allowlist are forwarded. The read-only command table comes from `COMMAND` on the local e2e Redis, never from the upstream. Non-read commands are dropped and recorded; the final spec requires zero violations in both modes. External upstreams are never seeded or configured: the harness sends them only AUTH and PING directly, and everything else goes through the proxy.
4. Seeds fixtures (`lib/fixtures-data.ts`): every type (string, hash, list, set, zset, stream with consumer groups and pending entries, JSON, TimeSeries, Bloom, a RediSearch index), binary keys and values, a 2 MiB value, a 5k-field hash, a 20k-item list, XSS payloads in keys and values, Unicode/emoji/RTL/zero-width names, 150 bulk-delete keys, and a prod-simulation DB (logical db 1).
5. Builds every workspace package that has a `build` script (the SPA), then starts the server (`apps/server` `start`) on :4400 with `config/rconsole.e2e.json`. Output goes to `.state/server.log`.

Databases in `config/rconsole.e2e.json`:

| id | Redis | Purpose |
|---|---|---|
| `sandbox-e2e` | 127.0.0.1:6431 db 0 (env `test`) | everything destructive |
| `e2e-prod-sim` | 127.0.0.1:6431 db 1 (env `prod`) | prod rules: typed confirmation, reason, no FLUSHDB, no profiler |
| `remote-6390` | proxy :6430 → selected upstream (env `prod`, `readOnly`, `maxRole: viewer`) | read-only enforcement on fixture or optional external data |

## Projects

| Project | Contents |
|---|---|
| `setup` | Bootstrap admin: forced password change, then TOTP enrollment, then full access. Creates `e2e-viewer`, `e2e-operator` and `e2e-admin2`, and saves sessions to `.state/storage-*.json`. |
| `api` | Role matrix (every `ROUTES` entry × anonymous/viewer/operator/admin), CSRF, headers/CSP/cookies, blocked commands (case variants, argv, argvBin, tokenizer tricks), read-only/prod, confirmations, bulk delete, keys, features, auth (TOTP replay, lockout, fixation, logout, idle/absolute expiry), rate limits. |
| `ui` | Auth and OIDC (Keycloak viewer1/operator1/admin1; nogroup1 refused), key browser (each type: view, add, edit, TTL, rename, delete, formatters, large values, binary, Unicode), console/workbench/guided, confirmation dialog, bulk delete, read-only UI, XSS, diagnostics (slowlog, clients, analysis, pub/sub round trip, streams/ack, search, timeseries, profiler), admin (audit redaction, users), every page × role under CSP. |
| `final` | Aggregate checks: zero leak-scan findings across all collected responses, a clean server log (no secrets, values or session IDs), audit JSON lines present, only read commands reached the selected upstream. |
| `screenshots` | Opt-in (`RC_SCREENSHOTS=1`). Writes `docs/screenshots/*.png`. |

Projects run on one worker in declaration order. Shared Redis state, per-user rate limits and TOTP replay protection make parallel runs nondeterministic.

## Built-in guards (every test)

- **Leak scan** (`lib/leak.ts`): every API response (`lib/api.ts`), every page response and every `EventSource` message (`lib/test.ts`) is checked against all `.env` values, every password and TOTP seed created during the run, and `redis://` URLs.
- **CSP / console:** every page records `securitypolicyviolation` events (including Trusted Types), console errors, page errors and JS dialogs. Any of these fails the test.
- **Sign-in pacing** (`lib/throttle.ts`): the server limits sign-in endpoints to 10/min per IP, and all clients are 127.0.0.1, so the suite mirrors that bucket. Other 429s are retried with backoff, except in `rate-limit.spec.ts`.

## Known bugs

Confirmed bugs are listed in `docs/E2E-FINDINGS.md` and marked in tests with `knownBug('F-xx')` (`lib/findings.ts`, which uses `test.fail`). When a bug is fixed, the affected test reports "expected to fail, but passed". Remove the marker and update the findings doc.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `RC_E2E_BASE_URL` | `http://localhost:4400` | Server under test |
| `RC_E2E_REDIS_PORT` | `6431` | Dedicated e2e Redis |
| `RC_E2E_REDIS_EXTERNAL` | — | `1`: don't manage the container (CI service container) |
| `RC_E2E_KEEP_REDIS` | — | `1`: keep the container after the run |
| `RC_E2E_PROXY_PORT` | `6430` | Read-only proxy listen port |
| `RC_E2E_REMOTE_HOST` / `RC_E2E_REMOTE_PORT` | unset | Explicit external upstream; both required to opt in |
| `RC_E2E_REMOTE_PASSWORD_ENV` | `RC_E2E_REMOTE_PASSWORD` | Name of variable containing the upstream password (from environment or `.env`) |
| `RC_E2E_REMOTE_PASSWORD` | generated for disposable target | Direct upstream password if no indirection is set |
| `RC_E2E_REMOTE_USER` | `default` | External upstream ACL username |
| `RC_E2E_SKIP_BUILD` | — | `1`: reuse existing builds |
| `RC_E2E_SERVER_CMD` | `apps/server` `start` | Custom server command |
| `RC_E2E_EXTERNAL_SERVER` | — | `1`: test an already running server (no log checks) |
| `RC_E2E_ATTACH` | — | `1`: global setup does nothing (use with `serve`) |
| `RC_SCREENSHOTS` | — | `1`: enable the screenshots project |

CI (`.github/workflows/ci.yml`) starts the repository sandbox with generated secrets and runs the same suite with no external upstream configured. `tests/e2e/ci/sandbox.sh` also seeds a local read-only stand-in for server integration tests (`RC_TEST_REMOTE_HOST`, `RC_TEST_REMOTE_PORT`, `RC_TEST_REMOTE_USER`, `RC_TEST_REMOTE_PASSWORD_ENV` / `RC_TEST_REMOTE_PASSWORD`). The checks job runs cluster, Sentinel and mutual TLS topology tests as well.
