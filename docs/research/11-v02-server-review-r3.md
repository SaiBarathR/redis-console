# Redis Console v0.2 — independent server review, round 3 (Claude)

Reviewed 2026-10-23 at `release/v0.2` **b9ea7e2** (detached worktree `review-s3`, no source changes, no commits).
Scope: `apps/server`, `packages/shared`, `config/`, `deploy/`, `Dockerfile`, `scripts/`.

**Result: 2 High, 3 Medium, 6 Low.** No authorization bypass, credential leak or session flaw was found: every
write path held on read-only and `maxRole`-capped databases, and each role connected as its own ACL user. The
remaining problems are about availability. One 745-byte viewer request crashes the server, and the reply-size
preflight still lets several reads buffer far more than its 16 MiB budget, while refusing some ordinary JSON reads.
After three rounds of patching the preflight one command at a time, I recommend replacing its core with a cap on
the bytes actually received (see "Simplification proposal").

## Method

- Read `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/V0.2-PLAN.md`, `apps/server/README.md`, `docs/REVIEW-LOG.md`,
  reports 07 and 08, and the whole server source in scope.
- Live instance: `:4500` with `config/rconsole.dev.json`, data dir `/tmp/rc-review-s3`, and QA accounts from
  `scripts/qa-accounts.mjs`. Keycloak `viewer1`/`operator1`/`admin1` were also used.
- Two short-lived scratch instances, both stopped afterwards:
  - `:4700`, the dev config with `--max-old-space-size=512` (the production image's heap), for the crash test.
  - `:4800`, a config whose 6411 copies are `readOnly`, `maxRole: viewer`, `maxRole: operator` and `environment: prod`, for the write-path matrix.
- A disposable `redis:7-alpine` container on `127.0.0.1:6445`, removed afterwards.
- Fixtures used only `rc-review-s3:*` keys and one dictionary on 6411. The 6412 copy was only read (plus
  `INFO commandstats`). `remote-6390` was only read, through the app (PING, MGET). I never connected to 6380 and
  did not touch port 4000 or `data/`.
- `pnpm --filter @rconsole/server test:unit`: **407 passed** (25 files). `typecheck` clean. E2E was not run.
- Scripts and outputs are in `/tmp/rc-review-s3-tests/`. `lib.mjs` is the client and `redis.mjs` refuses any port
  except 6411/6412. Each finding names its script.

---

## High

### H1. One small viewer request exhausts the heap and crashes the server (FT.AGGREGATE APPLY alias doubling)

**Where:** `apps/server/src/policy/searchGuard.ts:273-294` (`ref`, `refsOf`), `:318-323` (`APPLY`, `AS`).
Reached from `routes/cli.ts:95` (CLI and workbench) and from `FT.PROFILE … AGGREGATE`.

`refsOf` returns a list with one `Term` per field reference, and `ref(name)` expands an alias into its full list.
So `APPLY "@x+@x" AS x` replaces `x` with a list twice as long. With n such steps the list holds 2ⁿ terms. It is
built in memory, synchronously, before `measureFields` contacts Redis, so the index does not even need to exist.

**Reproduction** (`apply-blowup.mjs`, `apply-live.mjs`)

As `qa-viewer`, send `POST /api/v1/databases/sandbox-e2e/cli` with:

`argv = ['FT.AGGREGATE','noidx','*','LOAD','1','@x', ('APPLY','@x+@x','AS','x') × n, 'LIMIT','0','10']`

| n | body | server time | heap | event loop (`/healthz` stall) |
|---|---|---|---|---|
| 20 | 570 B | 83 ms | +157 MiB | 31 ms |
| 22 | 620 B | 347 ms | +356 MiB | 294 ms |
| 23 | 645 B | 642 ms | — | 589 ms |
| 27 on the 512 MB-heap instance | 745 B | — | — | **process died**: `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory` |

**Observed vs expected:** any viewer crashes the process (all users, sessions and SSE streams) with one request well
under every body limit. A size check should never use more than a fixed amount of memory or time.

**Impact:** a deterministic denial of service. The production `Dockerfile:67` sets `--max-old-space-size=512`, so
n ≈ 27 is enough there, and about 30 on default heaps. Three references per APPLY (×3 per step) need even fewer steps.

**Minimal fix:**
- Keep each alias's bound as numbers, merged by addition, instead of term lists: a constant `k`, a count per field
  index, and a per-match flag.
- Alternatively, refuse once the term count passes a small cap, for example 1,000.
- Also cap the number of APPLY/REDUCE steps (for example 32).
- Add the n = 30 case as a unit test with a time limit.

### H2. The reply-size preflight is still not a bound: four confirmed ways to buffer far more than 16 × `maxReplyBytes`

The guarantee in the docs is that reads are refused when they could exceed 100k elements or 16 MiB, because
node-redis buffers the whole reply. These forms break it. Every one ran as a viewer unless noted.

**(a