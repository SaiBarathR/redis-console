# Redis Console: agent guide

A secure, browser-based replacement for Redis Insight. **Security is the product.** This file is the baseline for any
coding agent that builds, reviews or tests this repository. `CLAUDE.md` is a symlink to it.

## 0. First steps

1. **If `AGENTS.local.md` exists, read it first. Its machine-specific rules take precedence over this file** (tunnels,
   banned ports, the owner's running instance, port assignments, QA account details, read-only targets).
2. Before changing behaviour, read `docs/ARCHITECTURE.md` (how), `docs/DECISIONS.md` (why) and the hard rules below.
   Security-relevant work: also `docs/SECURITY.md`.
3. Work in your own worktree and branch (section 5). Never commit on `main` directly.

## 1. Project map

| Path | What |
|---|---|
| `packages/shared/src` | The contract both apps import: `api.ts` (types + zod schemas), `commands.ts` (command rules), `roles.ts`, `bin.ts` (binary-safe `Bin`), `digest.ts` (compare-and-set), `insight.ts`. |
| `apps/server/src` | Node 24 + Fastify 5 + node-redis. The ONLY component that holds secrets or talks to Redis. `app.ts` (request hooks), `context.ts` (`dbScope`, `actorCheck`), `config.ts`, `policy/` (classify, authorize, confirm, preview, redact), `redis/` (manager, measured transport `capped.ts`/`resp.ts`, compare-and-set `checked.ts`), `routes/`, `security/`, `store/` (SQLite), `audit.ts`. |
| `apps/server/test` | `unit/`, `integration/` (needs the sandbox; suites skip when it's unreachable), topology tests. `apps/server/scripts/topology.sh`. |
| `apps/web/src` | React 19 + Vite SPA. `App.tsx` (shell, routes), `pages/`, `components/` (inspector, drawer, confirmation), `lib/` (`api.ts`, `keyscan.ts`, `keymeta.ts`, `keytree.ts`, `keyboard/registry.ts`, `live.tsx`, `memory.tsx`, formatters), `styles/` (`tokens.css`). `apps/web/TESTIDS.md` is the automation interface. |
| `tests/e2e` | Playwright: `specs/api`, `specs/ui`, `specs/final` (leak scan, read-only proxy assertions), `lib/`. See `tests/e2e/README.md`. |
| `infra/`, `scripts/` | Local sandbox (Redis 8 + Keycloak), `dev-setup.sh`, `qa-accounts.mjs`, `snapshot-redis.sh`. |
| `config/` | `rconsole.dev.json` (generic sandbox), `rconsole.e2e.json`; `rconsole.local.json` is a gitignored private config. |
| `deploy/`, `Dockerfile`, `.github/workflows` | Compose and Kubernetes examples, the image, CI. |
| `docs/` | Index in `docs/README.md`. History (do not rewrite; redacted once for publication, see `GENERALIZATION-NOTES.md`): `REVIEW-LOG.md`, `CONTRACT-CHANGES.md`, `qa/`, `research/`, `V0.2-PLAN.md`, `RI-PARITY-*`. |

## 2. Hard rules

1. The browser never receives Redis credentials, connection URLs, hosts, OIDC secrets or tokens, or session secrets.
   The browser can never choose a Redis host, port, TLS setting or logical database: databases are server config only.
2. Every Redis command passes the server policy (`packages/shared/src/commands.ts` + `apps/server/src/policy`) **and**
   runs as the Redis ACL user of the caller's effective role. Unknown commands fail closed. A missing tier never
   falls back to another tier's user.
3. Never render Redis data as HTML. No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, or navigation
   built from Redis data. Never deserialize Java/PHP payloads; structure views are inert and bounded.
4. Never log Redis values, passwords, tokens, cookies or session IDs. The audit stores command names and redacted argv.
5. No Redis data in URLs (POST bodies only) or in browser storage (`localStorage` holds enumerated preferences only).
6. Byte-exact data: values travel as `Bin`; display, copy, download, re-run and write-back keep the stored bytes.
7. Edits that replace data use compare-and-set (`expect`, `redis/checked.ts`); creates and renames never overwrite.
8. Data-dependent replies and every actor-checked command use the measured transport. Never send an actor-checked
   command through node-redis; never add a read without a byte, element or time bound.
9. The key browser scans names only; metadata is read lazily for visible rows (`MEMORY USAGE … SAMPLES n`).
10. The server decides confirmations and builds their preview from the exact argv that runs. Client checks are hints.
11. No telemetry, AI, analytics, CDN assets or runtime fetches besides Redis and the OIDC issuer.
12. New dependencies need a reason. Prefer Node built-ins. Exact versions (`save-exact`). No install scripts outside
    `onlyBuiltDependencies` in `pnpm-workspace.yaml`.
13. TypeScript is erasable-syntax-only (no enums, namespaces, parameter properties); relative imports use `.ts`.
14. Invalid config refuses to start. Never weaken a production check to make something work.

## 3. Setup and commands

Requirements: Node ≥ 24.11, pnpm 11.7 (`corepack enable`), Docker.

```bash
pnpm install
bash scripts/dev-setup.sh      # once: creates .env (gitignored) and starts the sandbox (ask first if it may be shared)
pnpm --filter @rconsole/web build
RCONSOLE_PORT=<your port> RCONSOLE_PUBLIC_URL=http://localhost:<your port> RCONSOLE_DATA_DIR=<your dir> \
  pnpm --filter @rconsole/server dev     # loads .env itself; serves the built SPA
```

- Config resolution for `dev`/`start`: `RCONSOLE_CONFIG`, else `config/rconsole.local.json`, else
  `config/rconsole.dev.json`. The production entry point (`apps/server/src/main.ts`) requires `RCONSOLE_CONFIG`.
- Sandbox: Redis 8 `sandbox-main` 127.0.0.1:6410, `sandbox-e2e` :6411 (empty), `snapshot` :6412 (refresh with
  `scripts/snapshot-redis.sh --host H --port P --password-env VAR [--user U] [--tls]`), ACL users `rc-viewer`,
  `rc-operator`, `rc-admin` (passwords in `.env`); Keycloak http://localhost:8089, realm `rconsole`, users `viewer1`,
  `operator1`, `admin1`, `nogroup1` (password `KC_USER_PASSWORD`). The sandbox realm accepts OIDC callbacks on
  `http://localhost` ports 4000, 4100, …, 4900 and 5173–5176, so pick your server port from those.
- Hot reload: `pnpm dev` at the root runs the server (watch mode) and Vite together on ports that agree
  (`scripts/dev-loop.ts`): `RCONSOLE_PORT` (default the config's `server.port`, 4000) and `RCONSOLE_WEB_PORT` (default
  5173; the dev config allows 5173–5176). Open the Vite address; it proxies `/api`, and the public URL defaults to it so
  SSO returns there. Use your own ports: `RCONSOLE_PORT=<port> RCONSOLE_WEB_PORT=<vite port> RCONSOLE_DATA_DIR=<dir> pnpm dev`.
- Other commands need the environment: `set -a; source .env; set +a`. Never print `.env`.

| Command | What |
|---|---|
| `pnpm -r typecheck` | All packages. |
| `pnpm --filter @rconsole/shared test` / `@rconsole/web test` / `@rconsole/server test` | Unit tests; server also integration. `test:unit` for server unit only. |
| `apps/server/scripts/topology.sh up` / `down` | Cluster, Sentinel and mutual-TLS Redis on 6420–6428 (`RC_TOPO_PASSWORD` set). |
| `pnpm test:e2e` | Full Playwright suite (fixed ports 4400, 6430, 6431: take the lock). |
| `node scripts/qa-accounts.mjs http://localhost:<port>` | QA accounts for every role on your instance. |

## 4. Data safety

- **Write only to sandbox databases**: the infra sandbox and containers you started. Use a unique key prefix
  (`<agent>:<date>:<run>:`) and delete what you create. `--reset-data` and recreating shared containers need the
  owner's approval.
- **Read-only targets are never written**: any database configured `readOnly: true` or named read-only in
  `AGENTS.local.md`. Not from code, tests, `redis-cli` or the app. Read them only through the app as a viewer, and
  prove it: the e2e read-only proxy records zero non-read commands; in live QA, the audit log shows no allowed write
  on that database.
- **Never connect to a Redis that isn't in the active config or `AGENTS.local.md`.** No exploratory `redis-cli` to
  other ports.
- Never print, copy into reports, or commit secrets: `.env`, `.qa/`, `config/rconsole.local.json`, `AGENTS.local.md`.
- Never edit `rconsole.sqlite` by hand (for example to reset TOTP); use the admin CLI
  (`pnpm --filter @rconsole/server admin reset-totp --user <name> --data-dir <your data dir>`), and only on a data
  directory you created.

## 5. Parallel-agent workflow

- One workstream = one worktree + one branch: `git worktree add ../redis-console-wt/<name> -b feat/<name> <base>`.
  Integration happens on `release/vX.Y`.
- The plan gives every stream explicit **file ownership**. In shared files (`routes/keys.ts`, `Diagnostics.tsx`,
  `api.ts`, …) change only your sections and extract your part into its own file early.
- Each agent uses **its own server port, Vite port, `RCONSOLE_DATA_DIR`, QA accounts file and Redis container ports**
  (assignments in `AGENTS.local.md`). Never use another agent's or the owner's port or data.
- Machine-wide e2e lock (the suite uses fixed ports):
  ```bash
  until mkdir /tmp/rconsole-e2e.lock 2>/dev/null; do sleep 30; done
  trap 'rmdir /tmp/rconsole-e2e.lock' EXIT
  pnpm test:e2e
  ```
- **Stop only processes you started, by PID** (`kill <pid>`; note PIDs when you start them, including watchers).
  Never `pkill -f`, `killall` or pattern kills: other agents and the owner run the same command lines. Remove only
  containers you started, by name.
- Don't push unless asked. Don't rewrite shared branches.

## 6. Contract changes

- `packages/shared` is the contract. Changes are additive by default; a **breaking** change updates both apps and the
  e2e specs in the same change.
- Log every change in `docs/CONTRACT-CHANGES.md`, newest first: `## <date> — <stream> (<branch>)`, then bullets per
  file (`### api.ts`, `### commands.ts`), each marked additive or **breaking**, with the server behaviour and the audit
  action.
- A new route goes into `ROUTES` and the role matrix (`tests/e2e/specs/api/role-matrix.spec.ts`; a guard test fails
  otherwise). Changed `data-testid`s update `apps/web/TESTIDS.md` and the specs together.

## 7. Test gates (before any merge)

1. `pnpm -r typecheck`.
2. Unit tests: shared, web, server (server integration against the sandbox).
3. Topology: `export RC_TOPO_PASSWORD=$(openssl rand -hex 16); apps/server/scripts/topology.sh up;
   pnpm --filter @rconsole/server test; apps/server/scripts/topology.sh down` (coordinate the 6420–6428 ports).
4. Full `pnpm test:e2e` under the lock: 0 failed, 0 flaky. CSP violations, leaks and writes to the read-only target
   fail the suite.
5. Live QA (section 8) for anything a user can see or do.

Report exact counts ("server 812 passed, 16 skipped"). A flake is investigated and recorded, not rerun until green.

## 8. Live QA (mandatory)

Reading code is not testing. Every feature is used in a real browser, as every role, on real data shapes.

1. Start your own server instance (own port and data dir) with the built SPA.
2. Accounts: `node scripts/qa-accounts.mjs http://localhost:<port>` creates `qa-viewer`, `qa-operator`, `qa-admin`,
   `qa-admin2` (TOTP enrolled) in `.qa/accounts.json`; `node scripts/qa-accounts.mjs --totp qa-admin` prints a code.
   Also sign in through Keycloak (`viewer1`, `operator1`, `admin1`; `nogroup1` must be refused).
3. Drive Playwright Chromium (headless is fine) through each changed flow as viewer, operator and admin: writes on
   sandbox databases, reads on the read-only target, the prod rules where a prod-tagged sandbox exists.
4. Record zero CSP/Trusted Types violations and zero page errors; check what the network tab sends.
5. Write the evidence to `docs/qa/<topic>.md` (what was run, as whom, on which database, results, cleanup).
   Screenshots go to gitignored directories; they must show sandbox data only.
6. Clean up: delete your keys, stop your server by PID, remove your containers.

## 9. Review rounds

- The reviewer is **a different model** from the author. The scope is the code **and** live use in a browser as every
  role. Reports go to `docs/research/NN-<topic>.md`.
- Each finding: an ID (`H1`, `M2`, `L3` by severity), where (file and line, or route), **a reproduction** (a failing
  test, a request, or browser steps, with the observed result), the impact, and a suggested fix. Unreproduced
  suspicions are labelled as such.
- Reviewing security, check four things:
  - **Reachable by role:** each route and command for anonymous, viewer, operator and admin; effective role with
    `maxRole`; `readOnly`; prod rules; which ACL tier executes it.
  - **After revocation:** what an in-flight or queued request can still do after logout, disable, demotion or password
    change (gate, after body, after waits, at dispatch).
  - **Resource bounds:** reply bytes, element counts, time, concurrency, body size, streams, jobs, per user and
    server-wide; what Redis keeps doing after the socket closes.
  - **Data leaving the server:** responses, error text, logs, audit, URLs, browser storage, previews, other users.

## 10. Fix rounds

Verify each finding against the current code; fix only still-valid issues; skip the rest with a brief reason; keep
changes minimal; validate.

1. Reproduce the finding on the current code first (a test or a live request).
2. Write the regression test; it must **fail before** the fix.
3. Make the smallest correct change. One finding per commit, message naming it (`fix(server): … (review v0.2 M3)`).
4. Skipped or partially fixed findings get a concrete reason (not reproducible, already fixed in `<sha>`, by design
   with the rule that requires it).
5. Log every verdict in `docs/REVIEW-LOG.md`:
   ```markdown
   ## <Round> – <server|web|console> (<Model> reviewer)

   Report: `docs/research/NN-….md` (snapshot `<branch>` @ `<sha>`). Fixer branch: `<branch>`.

   | ID | Verdict | Reason | Commit | Regression tests |
   |---|---|---|---|---|
   | M1 | fixed | Reproduced: <what happened>. <What changed>. | `abc1234` | `unit/…` › "<test title>" |
   | L2 | skipped | <Why>. | | |

   ### Validation
   - Each regression test failed before its fix and passes after it.
   - <suite counts>; live checks (who, where, what).
   ```
6. Run all gates (section 7). Repeat rounds until one finds nothing valid at Medium or above; then a reviewer runs a
   targeted fix verification of the last fixes.

## 11. Release

1. Merge the streams into `release/vX.Y`; run every gate and the review loop on the merged tree.
2. Bump `version` in the package manifests; write `docs/RELEASE-NOTES-vX.Y.md` (what changed, upgrade notes such as
   new ACL grants and config keys, how it was checked).
3. Tag `vX.Y` (annotated) and fast-forward `main` (`git merge --ff-only release/vX.Y`). Push only when the owner asks.
4. Release tags are never moved or deleted. Pushing a `vX.Y` tag publishes the image and then the GitHub release page
   (`.github/workflows/release.yml`). The page is built from the release notes by `scripts/release-page.ts`: links are
   pinned to the tag and an Install section names the image, its digest and how to verify it. Check the page after the
   run. To correct it, fix the notes and run
   `node scripts/release-page.ts <tag> <owner/repo> <digest> | gh release edit <tag> --notes-file -` (rerunning the
   job would read the notes as tagged).

## 12. Commits

- Small and focused; one concern per commit. Prefix with the area: `feat(web):`, `fix(server):`, `test(e2e):`,
  `docs:`, `chore:`. Name the review finding or plan item when there is one.
- End every message with your attribution line (Claude: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  other agents their own).
- Never commit secrets, `.env`, `.qa/`, local configs, screenshots of non-sandbox data, or generated output.
- The repository is public: committed files (code, tests, docs, QA records) contain sandbox data only, no absolute local
  paths, host names or details of anyone's machine or private data.

## 13. Definition of done

- The change does what was asked, within the hard rules, with tests that would fail without it.
- All gates in section 7 pass, with counts; live QA done and recorded for user-visible changes.
- Contract changes logged; `TESTIDS.md`, user guide, operations and architecture docs updated where behaviour changed.
- No leftover processes, containers, keys or temporary accounts; everything committed on your branch.

## 14. Reporting back

Report briefly: what changed (files, commits), how it was verified (commands and counts, live QA: roles, databases,
results), what was skipped or is still open (with reasons), anything that needs the owner's decision, and what you
started and stopped (PIDs, containers, ports). Never paste secrets or Redis values from non-sandbox databases.
