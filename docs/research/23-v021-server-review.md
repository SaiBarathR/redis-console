# v0.2.1 server review (rs1)

Reviewer: Claude (independent), 2026-10-24. Checkout: `release/v0.2.1` @ 1188224 (read-only worktree `v021-rs1`).
Scope: `git diff main..release/v0.2.1 -- apps/server packages/shared`. Live instance: port 4500, sandbox 6411 (rs1:* keys only).

Status: COMPLETE. 5 confirmed findings (F1 Medium, F2 Low–Medium, F3–F5 Low) + info notes. No authorization, policy or redaction bypass found.
Repro scripts were in `/tmp/rs1/*.mjs` (temporary); each finding states the requests used.

## Confirmed findings (live, port 4500)

### F1 (Medium) Import plan: a viewer can stall the event loop, hold ~90 MB per plan and lock imports for everyone
`apps/server/src/routes/import.ts:110-193` (route `dbScope(ctx, req)` = viewer+, `MAX_JOBS` check at :124, synchronous `lines.map(... prepare ...)` at :131).
- Any viewer can `POST /databases/:db/import` with a 4 MiB / 10,000-line script. All 10,000 lines are tokenized, classified,
  audit-redacted and (if allowed) previewed **synchronously** in one tick, and the per-line `Item`s (argv Buffers, redacted
  `base` with one `<n bytes>` string per token, preview) are kept until the plan expires (10 min).
- Measured (10,000 × `HSET rs1:x a a … a` (190 tokens), 3.9 MB): one plan = **~0.7 s event-loop stall** (`/api/v1/health` latency 682 ms for a viewer plan, 694 ms operator) and
  **~90 MB RSS** retained (RSS 301 MB → 1151 MB after 10 viewer plans, so ≈1.4 GB at the 16-plan cap; all lines were *refused* for the viewer, so the
  memory is held for a plan that can never run anything).
- The global cap counts plans: 16 planned-or-running server-wide, one per (session, database). One viewer with 6 sessions × 3
  databases held all 16; an operator then got `429 Too many imports are planned or running on this server` (repro
  `/tmp/rs1/c1.mjs`). Plans can be renewed every 10 min (rate 2/s per user), so imports stay unavailable.
- Impact: low-privilege availability attack on the whole server (event loop) plus feature lockout of an operator/admin feature.
- Minimal fix: require operator+ to plan (a viewer import can only run reads; drop or gate it), cap plans per **user** (1–2),
  refuse a plan with zero runnable lines without storing it, keep only counts for refused lines (not per-line `base`),
  chunk planning with `await setImmediate()` every ~200 lines, and budget the held plan bytes globally (as analysis does).

### F2 (Low–Medium) Analysis job table: one viewer locks out analysis jobs server-wide for 10 minutes
`apps/server/src/routes/analysis.ts:472-482` (`MAX_JOBS_PER_SESSION = 5`, `MAX_JOBS = 64`, no `rateLimit`, finished jobs
kept `ANALYSIS_JOB_RETAIN_MS` = 10 min).
- Per-session (not per-user) retention, finished jobs count toward the global 64, and the start route has no rate limit. A
  viewer with 13 sessions ran 64 trivially short jobs (`match: 'rs1:none:*'`, ~3 ms each) in ~3 s; afterwards qa-operator and
  qa-admin2 got `429 Too many analysis jobs are held; try again shortly.` (repro `/tmp/rs1/c2.mjs`, audit shows 64
  `analysis.run` by qa-viewer). Renewable every 10 min.
- Fix: count retained jobs per user (e.g. 5), and when the table is full evict the oldest *finished* job of anyone instead
  of refusing (finished reports are only a polling cache, already evicted by the 32 MiB budget); add `rateLimit(…,'analysis-job',1,3)`.

### F3 (Low) Full list-element reads are not identity-checked: a concurrent LPUSH returns another element as "the full value"
`apps/server/src/routes/keyDetail.ts:51`, refs built at `apps/server/src/routes/keys.ts` list case (`ref: { kind: 'list', index }`).
- Hash/set/zset refs are inline identities or scan/rank refs with a SHA-256 digest that is re-verified (409 on change); list refs
  carry only the index. Repro (`/tmp/rs1/c3.mjs`): `rs1:list = [70000×'X', 'secret-B']`, viewer reads the page (row 0
  truncated, `ref {kind:'list',index:0}`), another client `LPUSH rs1:list INSERTED-OTHER`, then `POST key/element` with
  row 0's ref → **200 `INSERTED-OTHER`** (14 bytes) instead of 409.
- Impact: the "load full value" of a truncated list row shows a different element; a following `list.set` with `expect`
  computed from that loaded value passes CAS and overwrites the element that is now at that index, not the row the user saw.
  Contradicts "identity checks on full reads" (CONTRACT-CHANGES DETAIL: "refuses a moved identity with 409").
- Fix: add `identity` (SHA-256 of the previewed prefix plus total length, or of the full element when it is short) to list refs
  and compare after `LINDEX` (bounded read already in place) → 409 `conflict` on mismatch.

### F4 (Low) Imports run blocking commands for up to 15 minutes (workbench: 30 s), also for viewers
`apps/server/src/routes/import.ts:43` (`IMPORT_MAX_MS` 15 min), :302-351 (no blocking-command rule), `MAX_RUNNING_IMPORTS` 4 at :46.
- `prepare` allows capped blocking reads (XREAD BLOCK ≤5 s) exactly like the workbench, but the workbench is limited to 100
  lines and `workbenchBudgetMs` (30 s); an import may hold them for 15 min. Repro (`/tmp/rs1/c6.mjs`): qa-viewer plans 200 ×
  `XREAD BLOCK 0 STREAMS rs1:nostream $` (plan: 200 reads, confirmation `none`), starts it → after 11 s only 2 lines were
  processed; the import holds one pooled viewer-tier socket and one global command slot (`maxInflightCommands` 16) for ~1000 s.
  Four such imports (four users) hold every running-import slot (`MAX_RUNNING_IMPORTS`) and a quarter of the server's command
  slots for 15 min. Cancel works (verified).
- Fix: refuse `blocking` lines in import plans (they make no sense in a bulk load), or charge them against a short budget;
  with F1, restrict imports to operator+.

### F5 (Low) Cluster delete job: audited/reported `deleted` misses UNLINKs that finish after a revocation stop
`apps/server/src/routes/bulkDelete.ts:299-312` with `inSlotOrder` (:41-58).
- When one worker's UNLINK is refused (revoked), `Promise.all` rejects, `runJob` ends the job and the final audit is written
  while up to three other workers' UNLINKs are still in flight; they complete and increment `v.deleted` afterwards.
  Live on the topology cluster (50,000 `rs1:{bd}:*` keys, logout 1.5 s after start): audit `keyCount 46014 … stopped
  (session)`, but 50,000 − 3,983 remaining = **46,017** keys were deleted (3 unaccounted; the job view keeps changing after
  `finishedAt`). The sync `bulkDelete` has the same pattern.
- Fix: in `inSlotOrder`, wait for all workers to settle (`Promise.allSettled`, then rethrow the first error) before returning.

## Info / doc notes (not defects in enforcement)

- **Shutdown audit gaps**: bulk-delete jobs are awaited in `preClose` and audit their outcome; imports and analysis jobs are only
  aborted (`ctx.streams`) and skip their final audit when `shuttingDown`. Live SIGTERM during an import: exit in 102 ms, the
  in-flight line audited as `error` “cancelled while in flight” although it **did** run (1,943 keys vs 1,942 `allowed`),
  no `import.finish`. Per-line audit keeps the trail mostly reconstructible; consider a preClose wait like the delete jobs.
- **Prod index drop** asks the admin to type the *index* name (+ reason), not the database name used by every other prod
  write. Documented in CONTRACT-CHANGES, but it departs from ARCHITECTURE's prod rule; the summary does name the database.
- **Doc drift**: `keyMetaMemorySamples` default is 5 in `config.ts`, but the field comment in `config.ts`, the
  `keysMetadata` comment in `keys.ts` and one CONTRACT-CHANGES paragraph still say “0 (the default)”.
- Finished delete jobs are swept only when a new job starts (`bulkDelete.ts:172`); a finished report stays readable past
  10 min until then (tiny, session-bound).

## Sound (verified)

- **Job revocation**: an import stops at the next line when the session ends (live: logout after 712 ms → `import.finish`
  `failed: succeeded=4228 … skipped=5772`, no further SET). Bulk-delete jobs carry `actorCheck` on every UNLINK/SCAN
  (measured transport) plus `stillValid` between pages; analysis jobs check `sessionStillValid` between SCAN pages
  (reads only). All job lookups are bound to session hash + database (404 otherwise).
- **Audit/redaction**: after ~4,300 audited events with `rs1:*` keys, the server log/audit stream contains no key name
  (`grep rs1` = 0). key.names/key.meta/import/bulk-delete/search events carry counts, `<n bytes>` and key tags only.

## Sound (by code reading)

- FT.DROPINDEX: admin+typed in rule; `DD` refused by `argumentRule` everywhere; `FT._DROPIFX` / `FT._DROPINDEXIFX` / `FT.DROP` all blocked (verified live as operator: 403).
- New typed ops (hash.expire/persist, stream.claim, stream.ack confirmAck) go through `/ops`: fixed `write` class (operator+), read-only refusal, prod typed+reason via `confirmationFor(…, true, …)`; HEXPIRE ttl must be positive (no ttl=0 delete bypass of HDEL's confirm).
- Search drop: admin + typed; DD gated by `searchDropDeletesDocuments`; audit redacts index name.
- Search create: classified from COMMAND INFO (fails closed without table), confirmation always, actor-checked measured send, argv built server-side from a strict schema.
- Slowlog config: admin-class verdict, exactly two parameters.
- **Role × route** (live): viewer → 403 on `hash.persist`, `stream.claim`, delete jobs (operator gate), index drop (admin gate,
  operator 403); operator index create → Redis NOPERM → 403; admin create/info/drop works and drop keeps documents.
  Prod (sentinel DB marked prod): hash.expire, stream.claim, stream.ack (even without `confirmAck`), delete job, import start
  all 428 `typed` + `reasonRequired`. Read-only is enforced by the same `authorize` (`isMutating`) on every new write path.
- **Import ≡ workbench policy**: same `prepare` (classify → authorize → caps → confirmSpec) per line, same `execute`
  (measured, role ACL user, actor check, per-line audit); refused lines need explicit `skipBlocked` and are audited as denied;
  one confirmation that is at least `confirm` for any change and inherits stronger line rules (`STRONGER`); slots checked
  before the token is spent; token bound to `import-start:<id>` + body.
- **keys/names**: threshold clamped to `keyScanThresholdMax`; COUNT ≤ 2000; stops on time (`scanBudgetMs`) and on kept bytes
  (half of `maxReadReplyBytes`), each SCAN reply also on the request's cumulative budget; exact lookups via one measured TYPE.
- **keys/meta**: ≤500 keys, deduplicated, one pipelined batch per node (≤4 nodes at once, one deadline), every reply measured
  (4 KiB + cumulative budget), actor checked with the batch write, `MEMORY USAGE … SAMPLES 5` by default; MOVED re-sent once
  to known primaries (topology test passes).
- **Full element reads** for hash/set/zset (inline identity or scan/rank + SHA-256, 409 on change), bounded HGET/LINDEX
  reads (`maxValueBytes`), 413 over cap; stream refs are ID-addressed (immutable). (List: see F3.)
- **Search**: sample bounded (1.5 s SCAN, ≤50 keys, 256 KiB per key, skipped not cut); query options positional/validated;
  FT.SEARCH ids read as bytes; FT.CREATE fails closed when the module/COMMAND INFO is missing (cluster/sentinel test: 403).
- **Analysis**: per-user 1 / global 4 slots, `analysisMaxMs`, kept key-name bytes capped at `maxReadReplyBytes` per report,
  finished reports ≤32 MiB server-wide, cancel returns a partial report, session + database bound.
- **Cluster/sentinel** (topology up, `topology.test.ts` 36/36 pass): live import across slots (CROSSSLOT reported per line),
  names/meta, sample, analysis job, zset element read, delete job with revocation stop — all correct on the cluster.
- **Hash field TTL**: HEXPIRE/HPERSIST typed ops; page HTTL batched for returned fields; `hashFieldExpiry` reported; verified live.
- **Stream inspector**: pending (binary group/consumer), XCLAIM JUSTID with confirmation, XACK with `confirmAck` → confirm;
  verified live.
