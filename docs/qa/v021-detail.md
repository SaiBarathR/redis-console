# Redis Console v0.2.1 — DETAIL qualification

Branch: `feat/v021-detail`, worktree `../redis-console-wt/v021-detail`, based on `bcbc05c`.
No push. No dependencies added. Implementation commits: `801d251`, `a7643ac`, `8e61f2d`, `0cc581d`, `e29dfa8`, `72f7f79`, `4d097fa`, `960b63b`;
review fix `f04799c`. Every result below was produced at `f04799c` (the earlier runs predated `4d097fa` / `960b63b`).

## Delivered scope

| Fix | Result | Focused server tests | Web unit tests | Chromium suite cases | Live cases on 6411 / 6412 |
|---|---|---:|---:|---:|---:|
| F1 | HSCAN/SSCAN/ZSCAN MATCH; binary exact field/member; list index and previous/next; reverse zset and score bounds. Page filter counts remain separate from collection totals; criteria reset paging. ZSCAN explicitly says scan order. | 8 | 3 | 3 | 6 |
| F3 | JSON/Tree/MsgPack/Hex/Base64/vector formatting in collection cells; per-cell expansion and keyboard-adjustable field/value widths. Format and width survive paging in authenticated session memory. | — | 2 | 3 (shared with F17) | 6 (shared with F17) |
| F6 | One HTTL batch per returned hash page; TTL column, HEXPIRE and HPERSIST; unsupported-command / ACL reasons. Viewers can read TTLs. | 3 | 3 | 3 | 6 |
| F9 | Full single-element read, compact identity-checked page references, exact bounded copy/download, full hash/list/score CAS editing and explicit cap/refusal states. | 8 | 5 | 3 | 6 |
| F18 | Up to 50 entries / 4 MiB; repeatable hash/set/zset/list form, binary input, duplicate and score validation, review, per-replacement CAS, partial-result summary and stop on conflict. | 1 | 3 | 3 | 6 |
| F15 | Inspector-bound groups → consumers → pending, ID/range/consumer lookup and paging, payload inspection, confirmed claim/ACK. Binary group/consumer identities retained. | 2 | 2 | 3 | 6 |
| F17 first slice | Float32 / float64, explicit little/big endian, dimension/alignment errors, negative zero and non-finite numbers; original bytes remain downloadable. | — | 5 | Shared with F3 | Shared with F3 |
| F23 | Deferred: vector-set read inspector is outside this qualified slice. Existing console read policy remains available. | — | — | — | — |

The focused server file has **24 tests**: 22 in the feature rows plus two shared actor-revocation and
viewer/read-only enforcement cases. The web file has **23 tests**. Standard Chromium adds **18 collection
cases + 3 remote read-only cases**; the new route adds four cases to the existing API role matrix.
The feature-row Chromium/live counts overlap for F3/F17 and exclude the cross-feature remote cases.

## Security and behavioral bounds

- Every added Redis read uses fixed read authorization and the scoped actor-checked measured transport, under
  the configured wire cap. Full element reads also honor `maxValueBytes`; a smaller wire cap always wins.
  Revocation during connection acquisition refuses dispatch. A transport overflow destroys that socket.
- Full-value references never address an element by shortened preview bytes. Short field/member identities
  are inline; larger identities use a bounded scan/rank position and SHA-256 identity check. A changed page
  returns 409 and requires refresh. SCAN references can become stale when a collection changes.
- `MATCH` returns the count on the current scan page; it never claims an exact collection-wide match total.
  Exact lookups and score ranges expose exact totals. Reverse order applies to score/rank ranges; ZSCAN has
  scan order. Redis collections remain live while paging.
- Hash/score batch writes each send the existing `expect` CAS contract, including absent expectations for unseen
  elements. List push and set additions use one bounded command. Earlier successes remain if a later operation
  fails; no ambiguous command is automatically retried. Overwrite explicitly resends the conflict's expectation.
- Copy is complete up to the existing 4 MiB browser bound. Downloads contain original bytes even after local inflation, use the static
  filename `redis-value.bin`, and are disabled for previews / values above that bound. Structured formats
  cannot decode a truncated preview. Native paste and downloaded-file SHA-256 verify the full binary fixture.
- Claim uses XCLAIM JUSTID with bounded IDs and a minimum idle time. Both inspector claim and ACK use the
  server's body-bound confirmation flow. Viewer / read-only controls and server refusals are checked separately.
- Redis bytes are inert React text. No Redis values enter URLs, document titles or browser storage. Width/format
  choices are held only in session memory. The Playwright page guards require zero CSP/Trusted Types violations,
  uncaught browser errors and secret leaks. Clipboard tests grant the same browser permissions as the existing
  clipboard qualification, then verify contents by native paste (no clipboard-read API).

## Review (at `960b63b`, fixed in `f04799c`)

The full `bcbc05c..HEAD` diff was reviewed against the plan's rules.

- **CAS on every replacing write: holds.** Full-element edits send `hash.set` / `list.set` / `zset.add` with `expect`
  computed from the loaded full bytes (or the full score text, read with the same double mapping as the CAS probe).
  F18 sends one checked op per hash/score row; unseen or truncated rows are expected absent or refused locally.
  Set additions and list pushes add without replacing. HEXPIRE/HPERSIST change expiry metadata. Claim and
  confirmed ACK use the body-bound confirmation flow.
- **Byte-exact copy/download: holds.** Download uses the original `value` prop, not the inflated or formatted text,
  through a static filename and a local Blob URL. It is disabled for any server preview and above 4 MiB. Hash
  field cells use `fieldTruncated`. Hash value, stream and set flags are conservative: a cut anywhere in the row
  disables the download.
- **Measured transport on every new read: holds.** Every new read uses `detailRead` (fixed read authorization, no
  `readonly` flag), so `dbScope` attaches `stillAllowed` and `measured()` routes it through the capped transport
  under the request's reply budget. `OBJECT ENCODING` / `MEMORY USAGE` now carry the actor check too. Full element
  reads use their own wire budget and a `maxBytes` of min(wire cap, `maxValueBytes` + 64).
- **Read-only enforcement: holds.** `hash.expire`, `hash.persist`, `stream.claim` and `stream.ack` authorize as
  `write`: viewers get 403 and read-only databases get `read_only`. Every new write control is behind
  `canWrite(db)` (`!readOnly && role !== viewer`); `remote-6390` (read-only, `maxRole: viewer`) shows none.
- **Fixed (`f04799c`): exact lookups produced unusable references for identities longer than 64 bytes.**
  HGET / SISMEMBER / ZSCORE reads no page, but those rows still got a `scan`/`rank` reference for the request's
  cursor/offset. **Load full element** then reread an unrelated page and always failed with 409. One example: a 100-byte
  field with an 80 KB value. Exact rows now carry the caller's own identity inline, up to the element route's
  64 KiB identity cap. The 409 identity check still prevents retargeting, so this was a failure, not a leak.
  New server regression test (it fails without the fix), contract note in `CONTRACT-CHANGES.md`, and live
  Chromium checks below.

## Validation (all at `f04799c`)

- `pnpm -r typecheck`: passed (shared, server, web, E2E). Production web build passed.
- Web: **360 passed** / 25 files, including the 23 DETAIL tests.
- Shared: **12 passed** / 3 files.
- Server: **777 passed**, 29 optional topology tests skipped / 59 files. The focused DETAIL file has 24 tests. The
  topology tests are skipped when their optional cluster/Sentinel/mTLS fixtures are absent; no topology/failover
  qualification is claimed. One earlier run failed one test because it overlapped the live run: the r5 SSE test's
  MONITOR stream on 6411 captured live-run traffic, so its "quiet stream" heartbeat expectation did not hold. The
  rerun on a quiet sandbox passed with no change.
- Full `pnpm test:e2e` under `/tmp/rconsole-e2e.lock` (held 12:13:19–12:29:01): **534 passed** (15.7 min), 0 failed,
  0 flaky, 0 retries.
  The suite's workflow owns its disposable Redis on 6431 and read-only proxy on 6430. It includes the 18 DETAIL
  collection cases, the 3 remote read-only cases and the `keyElement` role-matrix row.
- Live production build at `http://localhost:4800` with absolute `RCONSOLE_CONFIG` and data directory
  `/tmp/rc-v021-detail`, provisioned with `node scripts/qa-accounts.mjs http://localhost:4800` (qa-viewer,
  qa-operator, qa-admin with TOTP).
- **39 / 39 live Chromium cases passed**, with 0 failed, 0 flaky and 0 retries:
  - 6 feature cases × viewer/operator/admin × `sandbox-e2e` (6411) / `snapshot` (6412).
  - viewer/operator/admin read-only checks on `remote-6390`.
  - Exercised on real Redis: native copies, full-value CAS conflicts and overwrite, downloaded-byte SHA-256, TTL
    set/remove, batch partial results and confirmed claim/ACK.
  - `remote-6390` stayed read-only throughout. Checked there: hash lookup/format/TTL capability, download and
    effective-viewer controls. No fixtures were created there.
- **6 / 6 extra live Chromium checks of `f04799c`** (viewer/operator/admin × both sandboxes). Each used an exact
  lookup of a 100-byte field holding 80,004 binary bytes, then **Load full element**. Each download matched the
  fixture's SHA-256. **Edit full element** was offered only to operator/admin. The URL had no field data, with 0
  console errors and 0 CSP violations.
- Live config: `tests/e2e/playwright.detail-live.config.ts` (approved sandboxes only; no global setup or flushing).
- Test harness: the role matrix includes `/key/element`. The existing long-key SCAN cap regression follows all
  cursors to the page holding its fixture. The existing TOTP replay scenario allows 120 s because it can need two
  30 s anti-replay windows; its authentication assertions are unchanged.

## Evidence and cleanup

- Logs: `/tmp/rc-v021-detail-qa/{typecheck,build,web,shared,server,e2e-full}.log`,
  `/tmp/rc-v021-detail-qa/live-{viewer,operator,admin}-{sandbox-e2e,snapshot,remote}.log`,
  `/tmp/rc-v021-detail-qa/live-summary.log`, `/tmp/rc-v021-detail-qa/live-exact-long-field.log`,
  `/tmp/rc-v021-detail-qa/cleanup.log`. Live machine-readable results and artifacts are in the gitignored
  `apps/web/qa-results/detail-*` paths. Formatter layout screenshots are
  `apps/web/qa-results/detail-*-artifacts/*/collection-format.png`.
- Earlier evidence (at `e29dfa8`/`4d097fa`): a live gzip check verified 81 original compressed bytes → 11,011
  displayed inflated bytes → 81 downloaded original bytes, with matching SHA-256 and zero CSP violations. Two oversized
  hash fields sharing one 64 KiB preview prefix got distinct, digest-bound rows. See
  `/tmp/rc-detail-inflated-download.{log,png}`.
- Fixture names are scoped to `e2e:scratch:detail:*` (suite prefix from `K.scratchPrefix`) and the server tests'
  `rcsrv:detail:*`. Every live run walks SCAN to completion and unlinks only its own prefix. The final read-only
  cleanup scan (as `rc-viewer`, after the last server and E2E runs) found **zero** `e2e:scratch:detail:*` and `rcsrv:detail:*` keys on both 6411 and 6412.
- The port-4800 server (pnpm PID 59400, node PID 59423) was stopped by PID. The earlier session recorded stopping its own
  PIDs 51959, 74080, 33575 and 73152 by PID. No connection to 6380; no change to port 4000 or the
  owner's `redis-console/data`. The linked `.env` was retained; `scripts/dev-setup.sh` was not run.

Contract record: [DETAIL API changes](../CONTRACT-CHANGES.md); selectors: [TESTIDS](../../apps/web/TESTIDS.md).
