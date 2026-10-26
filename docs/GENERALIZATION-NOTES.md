# Generalization notes

Branch `chore/pub-generic`. Goal: anyone can clone, run, test and deploy the repository without the original author's machine, data or names, while the owner's local setup keeps working through gitignored local files. User-facing documentation (README.md, AGENTS.md beyond the machine-specific section, and the guides in `docs/`) is owned by the parallel docs branch `chore/pub-docs`.

## What changed

- **Configuration.** `config/rconsole.dev.json` is generic: `sandbox-main` (6410), `sandbox-e2e` (6411) and `snapshot` (6412). The server's `dev` and `start` scripts (`apps/server/scripts/dev.ts`) resolve the config in this order: `RCONSOLE_CONFIG` (a relative path resolves from the script's working directory, `apps/server` under pnpm), then `config/rconsole.local.json` if it exists, then `config/rconsole.dev.json`. Both scripts load `../../.env` if present; variables already in the environment win. Relative `dataDir` keeps resolving from the working directory, as before. The production entry point `apps/server/src/main.ts` (used by the image) still requires an explicit `RCONSOLE_CONFIG`.
- **Snapshot sandbox.** The machine-specific compose service on 6412 is now `redis-snapshot` (still `127.0.0.1:6412`), seeded from `infra/redis/seed-snapshot.rdb` into `infra/.generated/data-snapshot/`. The machine-specific refresh script is replaced by `scripts/snapshot-redis.sh --host H --port P --password-env VAR [--user U] [--tls]`: the password is read from the named variable (never argv), the snapshot is taken with `redis-cli --rdb` (replication, so the source must allow it), kept as a mode-600 backup under `infra/.generated/snapshots/`, copied to the seed and data directory, and only `redis-snapshot` is recreated. `scripts/dev-setup.sh` no longer creates a placeholder for a read-only remote's password.
- **E2E remote coverage is self-contained.** Database `remote-6390` (a stable test ID; prod, readOnly, maxRole viewer) always points at the read-only filtering proxy on 6430. The upstream is an explicitly configured external Redis, or else a disposable `redis:8` container on a random loopback port seeded with a few `example:remote:*` keys. A configured target that is unreachable or rejects AUTH falls back to the fixture, with a log line. The harness sends an external upstream only AUTH and PING directly. The proxy's read-only command table comes from `COMMAND` on the local e2e Redis (6431), never from the upstream. The harness renders `tests/e2e/.state/config.json` (mode 600, gitignored) from `config/rconsole.e2e.json` with the selected ports and username, and gives the password to the server as `RC_E2E_REMOTE_PASSWORD`. The final spec asserts zero proxy violations in both modes. No spec depends on owner data.
- **Server integration tests.** The optional read-only remote suite (`apps/server/test/integration/remote.test.ts`) runs only when `RC_TEST_REMOTE_HOST` and `RC_TEST_REMOTE_PORT` are set.
- **CI** (`.github/workflows/ci.yml`) runs on GitHub-hosted runners with no external data. `tests/e2e/ci/sandbox.sh` (refuses to run unless `CI=true`) runs `scripts/dev-setup.sh` with generated secrets, seeds two `example:*` keys into redis-main, and points `RC_TEST_REMOTE_*` at redis-main as a read-only stand-in. The checks job also starts the cluster, Sentinel and mutual-TLS topology (`apps/server/scripts/topology.sh up`) and runs the full unit and integration suites. The image job starts the production image with a read-only root filesystem and a throwaway config and checks `/healthz` and the SPA (`scripts/ci-image-smoke.sh`, CI only). The E2E job runs the whole Playwright suite against the disposable fixture upstream. While this branch was open, the workflow also ran on pushes to `chore/pub-generic`; that entry was removed from `on.push.branches` after the merge (v0.3 follow-ups).
- **Names.** Fixtures, tests, QA scripts and comments use `example` / `snapshot` instead of owner names. The QA tours (`apps/web/qa/insight-live.browser.spec.ts`, `apps/web/qa/v02-ui-live.browser.spec.ts`, `apps/server/scripts/replycap-qa/mget-latency.mjs`) take the snapshot's top-level key prefix from `RC_QA_KEY_PREFIX` (default `example`).
- **Ignore files.** `.gitignore` covers `config/rconsole.local.json`, `AGENTS.local.md`, `infra/redis/seed-*.rdb`, `.qa/` (plus the existing `*.rdb`, `.env`, `infra/.generated/`, `data/`). `.dockerignore` excludes the same private files.
- **AGENTS.md** (also CLAUDE.md, a symlink): the machine-specific "Test data safety" bullets are replaced by generic ones and a pointer to `AGENTS.local.md`. The rest is left to the docs branch.

## Environment variables

| Variable | Used by | Default | Meaning |
|---|---|---|---|
| `RCONSOLE_CONFIG` | server `dev`/`start` | `config/rconsole.local.json` if present, else `config/rconsole.dev.json` | Config file. Required for `src/main.ts` and the image. |
| `RC_E2E_REMOTE_HOST`, `RC_E2E_REMOTE_PORT` | E2E | unset | Opt in to an external read-only upstream for `remote-6390`. Both are required. |
| `RC_E2E_REMOTE_USER` | E2E | `default` | ACL user for the external upstream. |
| `RC_E2E_REMOTE_PASSWORD_ENV` | E2E | `RC_E2E_REMOTE_PASSWORD` | Name of the variable (environment or `.env`) holding the upstream password. |
| `RC_E2E_REMOTE_PASSWORD` | E2E | generated | Upstream password when no indirection is set; the harness sets it for the server. |
| `RC_TEST_REMOTE_HOST`, `RC_TEST_REMOTE_PORT` | server tests | unset | Enable the read-only remote integration suite. |
| `RC_TEST_REMOTE_USER` | server tests | `default` | ACL user for that remote. |
| `RC_TEST_REMOTE_PASSWORD_ENV` | server tests | `RC_TEST_REMOTE_PASSWORD` | Name of the variable holding its password. |
| `RC_QA_KEY_PREFIX` | QA tours | `example` | Top-level key prefix of the data in the `snapshot` database. |
| `RC_QA_KEY_PATH` | QA tours | `group:items:v1` | Folders below that prefix leading to a namespace of JSON strings. |
| `--password-env VAR` | `scripts/snapshot-redis.sh` | required | Name of the exported variable holding the source password. |

The leak scanner treats every `.env` value as a secret except the public `RC_E2E_REMOTE_*`/`RC_TEST_REMOTE_*` host, port, user and `*_PASSWORD_ENV` settings. The password they point to is still scanned.

## Files

| File | Tracked | Purpose |
|---|---|---|
| `config/rconsole.dev.json` | yes | Generic sandbox config. |
| `config/rconsole.e2e.json` | yes | E2E template; rendered into `tests/e2e/.state/config.json`. |
| `config/rconsole.local.json` | no (gitignored) | Machine-specific config, used automatically by `dev`/`start` when present. |
| `AGENTS.local.md` | no (gitignored) | Machine-specific rules for agents; AGENTS.md tells agents to read it if present. |
| `apps/server/scripts/dev.ts` | yes | Config resolution for `dev`/`start`. |
| `scripts/snapshot-redis.sh` | yes | Refresh the 6412 snapshot sandbox from a Redis you are allowed to replicate. |
| `scripts/ci-image-smoke.sh` | yes | CI-only production image HTTP smoke test. |
| `tests/e2e/lib/remote-target.ts` | yes | Selects the external or disposable upstream for the read-only proxy. |
| `infra/redis/seed-snapshot.rdb`, `infra/.generated/data-snapshot/` | no | Snapshot seed and live data directory. |

## A private local setup

- Put a machine's real databases in `config/rconsole.local.json` (gitignored; `dev`/`start` pick it up) and its rules
  for agents in `AGENTS.local.md` (gitignored; AGENTS.md tells agents to read it first): read-only targets, ports that
  must not be touched, a long-running instance and its data directory, port assignments for parallel agents. Keep both
  files mode 600 and copy them into each new worktree (gitignored files are per checkout).
- E2E against a real read-only upstream instead of the disposable fixture:
  `RC_E2E_REMOTE_HOST=<host> RC_E2E_REMOTE_PORT=<port> RC_E2E_REMOTE_PASSWORD_ENV=<variable in .env> pnpm test:e2e`.
- QA tours on a private snapshot: set `RC_QA_KEY_PREFIX` and `RC_QA_KEY_PATH` to its key layout and start the instance
  with `RCONSOLE_CONFIG=<repo>/config/rconsole.dev.json` (generic ID `snapshot`).

## Publication

Before the repository was published, the historical records (`docs/REVIEW-LOG.md`, `docs/qa/**`, `docs/research/**`,
`docs/V0.2-PLAN.md`, `docs/RI-PARITY-*`, `docs/DESIGN.md`) were redacted once: host and machine names, local paths and
the names of the private development dataset were replaced (`snapshot`, `example:`, `<repo>`), and the v0.2 QA
screenshots, which showed that dataset, were removed. The public history starts at v0.3, so commit hashes quoted in
those records refer to the private development history.

The E2E database ID `remote-6390` and its display name "Remote 6390 (read-only)" are kept as stable test identifiers;
they do not imply a specific host.
