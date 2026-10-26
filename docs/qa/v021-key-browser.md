# Key browser v0.2.1: names-only scan and lazy metadata (live QA)

Branch `feat/v021-kb` (from `main` `c43ad4f`, with `release/v0.2.1` `bcbc05c` merged for the parity plan). Stream KB of
`docs/RI-PARITY-PLAN.md`: names-only scan with lazy metadata, F2 (folder counts and percentages, coverage), F14
(Tree/List, column chooser, descending sort), F16 (last refresh, opt-in auto-refresh), F20 (pattern delete as a job).
Contract: `docs/CONTRACT-CHANGES.md` (2026-10-24, key browser v0.2.1).

## What the owner saw, and the cause

On `remote-6390` (about 8,000 keys) Redis Insight opened on the full namespace tree ("Results: <all>. Scanned <all> / <all>"),
while v0.2 showed "200 matches · 200 examined of <all> keys"; *Continue scan* added 200 at a time and *Scan to
end* took about a minute. v0.2's `keys/scan` returned metadata with every name: for each key TYPE, TTL and MEMORY USAGE
(three commands), so a full inventory cost three commands per key, paced under the scan rate limit.

Redis Insight (source in `<research-dir>/repos/redisinsight`): the tree view asks `keys` for 10,000 names with
`keysInfo: false`; the server loops `SCAN … COUNT min(2000, count)` until it has `count` keys or examined `scanThreshold`
(default 10,000) slots; a pattern without glob characters is looked up directly; `keys/get-metadata` loads type, TTL and
`MEMORY USAGE … SAMPLES 0` (pipelined) only for the rows the virtual list shows.

## Design (as built)

- `POST keys/names`: names only, binary-safe, `count` ≤ 10,000, `scanThreshold` ≤ `policy.keyScanThresholdMax`
  (default 100,000), SCAN COUNT ≤ 2,000 per call, `policy.scanBudgetMs` per request (the browser continues with the
  cursor until "Keys to scan" is covered), half of `maxReadReplyBytes` of names per page. Cluster: per primary, existing
  cursor encoding. No glob characters: one `TYPE` lookup.
- `POST keys/meta`: TYPE, PTTL, `MEMORY USAGE … SAMPLES 0` for ≤ 500 keys, pipelined per node on the measured transport
  (each reply capped at 4 KiB and charged to the request budget; actor checked with the write of the batch). Hidden
  columns skip PTTL / MEMORY USAGE.
- Web: the tree is a trie built once per name list and delimiter; rows exist only for open folders; children are
  sorted once per folder (natural order via precomputed sort keys, no `Intl.Collator` per comparison); folder byte sums
  are one pass over keys with metadata. Metadata requests follow the virtual list's visible range (80 ms debounce,
  300 ms max wait, one request at a time, ≤ 500 keys or 512 KiB per batch), cached per key in session memory.
- Rate limits: names 10/s burst 20, metadata 10/s burst 30, two of each running per user; one pattern-delete job per
  user, four per server. A normal open is one names request plus one metadata batch per screen scrolled.

## Method

- Server from this worktree on port 4600 (`config/rconsole.dev.json`, `RCONSOLE_DATA_DIR=/tmp/rc-v021-kb`), accounts
  from `scripts/qa-accounts.mjs`. "Before" is the same command on `main` `c43ad4f` (v0.2), same machine, same data.
- `apps/web/qa/key-browser-bench.mjs`: Chromium (Playwright 1.64, headless, 1440×900), signed in as `qa-viewer`; the
  overview page first (so connection pools are warm), then the timer starts at navigation to the key browser and stops
  when the whole tree is listed (v0.2.1: `key-scan-summary[data-done=true]`; v0.2: after clicking *Scan to end*, when
  the footer says *Scan complete*). Redis commands: `INFO commandstats` on 6412 before and after, read directly with the
  sandbox admin user (only the key-browser commands are listed; the shell's own `INFO` is left out). `remote-6390` is
  only read through the app, so only timings and HTTP requests are reported for it. Two runs each; they agreed within
  2 %.
- `apps/web/qa/key-browser-large.mjs`: 100,000 small keys under a disposable prefix in sandbox-e2e (6411; 40 % in one
  namespace, ten namespaces, 97 sub-folders each, a tenth with a TTL), signed in as `qa-operator`, then deleted again.

## Results: time to the full tree and Redis commands

| | v0.2 (`main`) | v0.2.1 | Redis Insight's approach |
|---|---:|---:|---:|
| **snapshot** (6412, about 7.5k keys): time to the full tree | 4.62 s (first 200 keys at 0.80 s, then *Scan to end*) | **0.81 s** (whole tree on open; names request 8 ms on the server) | — |
| HTTP requests | 20 × `keys/scan` | 1 × `keys/names` + 1 × `keys/meta` | 1 keys + 1 get-metadata |
| SCAN | 20 | **4** (COUNT 2000) | 4 (COUNT 2000) |
| DBSIZE | 20 | 1 | 1 |
| TYPE / TTL (PTTL) / MEMORY USAGE | one per key (about 7.5k) each | **3 each** (the 3 keys on screen) | 3 each |
| **Redis commands in total** | **about 22.5k** | **14** | 14 |
| **remote-6390** (about 8k keys, remote read-only upstream): time to the full tree | **55.4 s** (first 200 at 1.81 s) | **0.81 s** (names request 79 ms on the server) | — |
| HTTP requests | 21 × `keys/scan` | 1 + 1 | 1 + 1 |

"Redis Insight's approach" is what its scanner and get-metadata code send for the same view (one names scan of 10,000
plus metadata for the visible rows); it matches ours command for command (Redis Insight sends TTL where we send PTTL).

Browsing after the open costs only what is looked at. On snapshot, opening its largest folder (several thousand keys) and
scrolling five screens issued 5 metadata requests for 159 keys: 159 × TYPE, PTTL and MEMORY USAGE (477 commands, where
v0.2 had read three metadata commands for every key up front).

## Results: 100,000 keys (sandbox-e2e)

| | v0.2.1 |
|---|---|
| Open: first "Keys to scan" step (10,000 slots) | 0.36 s; 2 names requests (the first stopped at its 10,000 names), 1 metadata request; SCAN 6, DBSIZE 2, TYPE/PTTL/MEMORY USAGE 13 each |
| *Scan to end* (100,390 keys) | **0.35 s**; 10 names requests; SCAN 46, DBSIZE 10; 1 metadata request (30 keys on screen) |
| Long tasks (> 50 ms) while scanning to the end | 0 |
| Open the 40,000-key `blob:` folder | 33 ms |
| Scroll 40 screens in a folder / 40 × 25 screens in the flat 100,390-row list | frame p95 19 / 20 ms, max 20 / 22 ms |
| Tree → List (100,390 rows, natural sort) / reverse the sort / List → Tree | 137 ms / 50 ms / 77 ms |
| JS heap after all of the above | 60–103 MB |

v0.2 on the same 100k keys would read 300k metadata commands in about 250 paced pages (*Scan to end* at 400 keys a page
with 110 ms gaps): from the snapshot rate (about 7.5k keys in 3.8 s of draining) that is about 50 s locally and several
minutes over the remote link. This was not run against v0.2; the estimate is from the measured rate.

## Live checks in Chromium

- snapshot as `qa-operator`, light theme, 1440 and 1100 wide: tree on open with counts and shares (matching
  the owner's Redis Insight screenshot), hover actions, Delete keys in this folder… pre-fills the
  pattern; on sandbox-e2e a 300-key folder delete ran as a job (report "Deleted 300 of 300 scanned keys."), the list
  refreshed itself afterwards.
- remote-6390 as `qa-viewer`, dark theme: read-only frame, no delete actions, metadata loads while scrolling
  thousands of keys; only `keys/names`, `keys/meta` and `key/read` requests were sent (the script fails on any other non-GET).
- snapshot as `qa-viewer` and as `qa-admin` (password + TOTP): the viewer gets only the filter action, the admin both;
  keyboard F and Delete on a focused folder filter / open the pre-filled delete; sorting by size loads every key's size
  with a progress line, then orders folders by their byte sums.
- The benchmark was repeated on the final build (after the review fixes): 0.81 s / 0.80 s to the full tree, 14 Redis
  commands on snapshot, names request 12 ms / 80 ms on the server.
- No page errors in any run. One console 401 is the sign-in page's own `/auth/me` before login.

## Tests

- Server: `test/integration/key-browser.test.ts` (names: names only, full drain exactly once, binary names, threshold and
  clamping, count, type filter, exact lookups with escapes, validation, audit (one event, hashes and counts, no names),
  a normal open never 429, bursts do, read-only database and every role; metadata: order, missing keys, binary keys, TTL
  rounding, `ttl`/`size` flags; jobs: preview + typed confirmation + counts + done, cancel with a partial outcome,
  owner-only status, viewer/read-only/wildcard refusals, session end stops the job), `test/unit/capped.test.ts`
  (pipeline: one round trip, error replies in place, per-reply cap and shared budget, trailing bytes and pushes fail
  closed, actor checked once, timeout), `test/unit/misc.test.ts` (glob literal, COUNT 2000, threshold, byte stop),
  `test/unit/bulk-job.test.ts` (counts, error codes only, three failed pages, cancel/revoked/refused, concurrent
  cluster workers), `test/integration/topology.test.ts` (cluster and sentinel: names across primaries with the cursor,
  exact lookup by slot, metadata of keys on every primary in request order, the job across primaries).
- Web: `lib/keytree.test.ts` (grouping, collapse defaults, binary keys, natural and descending order, positions, folder
  sums, folder patterns, canonical ids, 100k keys timing bounds), `lib/keyscan.test.tsx` (threshold loop, Scan more,
  Scan to end, refresh, 429 retry, Stop, the preference, outdated list), `lib/keymeta.test.tsx` (visible rows only,
  debounced batch, cache, 500 per request and one at a time, hidden columns, refresh keeps values, failure backoff,
  load-all for sorting), `pages/Keys.test.tsx` (tree on open with counts/shares/tooltip, metadata only for rows on
  screen, placeholders, complete folder sums, folder filter and delete, viewer without delete, partial coverage wording,
  Tree/List, columns, descending sort, refresh, auto-refresh and its pause).
- E2E: `specs/ui/key-browser.spec.ts` (new), `specs/api/keys.spec.ts` (names, metadata, job), role matrix rows for the
  five new routes, `specs/api/readonly-prod.spec.ts` (names and metadata through the read-only proxy; jobs refused).
- Final counts on `53d578a`: `pnpm -r typecheck` clean; server 830 tests in 61 files (with the cluster/sentinel/TLS
  topology up), web 360 in 26 files, shared 12; full `pnpm test:e2e` 535 passed (15.0 min), and the new key-browser
  spec passed three times in a row (`--repeat-each 3`). Two earlier full runs each found one problem: the outdated-list
  notice had lost its "Rescan" label (restored), and the column-chooser check counted a metadata batch sent before the
  column was hidden (the test now waits for those).

## Bugs found during QA and fixed

An independent read of the server diff (a separate reviewer agent, read-only) found five issues, all fixed with tests:
jobs were stopped only after the app had closed Redis and the audit store (now a `preClose` hook stops them between
batches and the outcome is audited as `stopped (shutdown)`; a failed final audit no longer becomes an unhandled
rejection); repeated keys in one `keys/meta` request each ran `MEMORY USAGE … SAMPLES 0` (now read once; and
`policy.keyMetaMemorySamples` lets operators trade exactness for constant cost); a key-level ACL denial failed the whole
batch (now that key is `unknown`); two confirmed job starts sent together could both pass the per-user limit (checked
again with no await before registering); a cluster batch kept sending after a failure and retried redirected keys one by
one (now one deadline, stop on failure, one refreshed batch per node for MOVED).

- Cluster pattern-delete jobs undercounted deletions (`deleted += await …` read the count before the await while four
  workers ran); found by the new topology test.
- Switching List → Tree while scrolled far down kept the old offset, so the tree's folders were above the viewport; a
  new view, delimiter or pattern now starts at the top.
- A folder holding all but a few keys showed "100%"; it now shows ">99%" (the tooltip has the precise share).
