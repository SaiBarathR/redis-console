# Redis Console v0.2.1 — independent frontend review

**Reviewed 24 October 2026, `release/v0.2.1` at `3fa23d1`.** The owner's key-browser complaint is resolved on both requested databases: the full approximately 8,000-key tree opens in **0.83–0.85 seconds**, with useful namespace counts and percentages, without a manual page walk. The release substantially closes the parity backlog. **19 fixes are fixed, six partly fixed, and two remain explicitly deferred.** Two Medium correctness issues and one Low interaction issue were reproduced. No High/Critical issue, Redis-content execution, browser-storage disclosure, CSRF bypass, or CSP violation was observed within this review's coverage.

The material correctness issues are the index wizard mixing a stale sample with a changed prefix, and the new TimeSeries renderer silently hiding series beyond its twelve-series cap. The remaining larger parity gaps are consumer management, the rest of F17's formatters, a profiler file export, and simultaneously visible bottom tools. These are detailed below; a successful feature's presence is not treated as exhaustive qualification of every payload or topology.

## Scope, method, and evidence

- Read-only checkout: `../redis-console-wt/v021-rw1`, clean at `3fa23d1`. No source edit or commit. Read `AGENTS.md`, the audit, parity plan, DESIGN, both `docs/qa/v021-*.md` reports, and the server-review contract changes.
- Redis Insight comparison: local source `<research-dir>/repos/redisinsight`, commit `43bd288ed30dc6d2355723158dad5d7ecf4a280e` (3.8.0). This is a source comparison. **Redis Insight was not launched or timed in this review**; the owner's “instant” observation and the implementation QA's old-version timings are background, not independent measurements here.
- `pnpm install`, production web TypeScript/Vite build: passed. `pnpm --filter @rconsole/web test`: **432 tests in 30 files passed**. No full repository E2E suite or backend/security-suite rerun; the browser checks below used a custom independent Playwright harness under the required E2E lock.
- Dedicated production-build instance: `http://localhost:4700`, isolated data `/tmp/rc-v021-rw1`, server PID 4011. QA accounts provisioned with the prescribed script. Playwright Chromium imported from this checkout's `tests/e2e/node_modules`, isolated viewer/operator/admin contexts.
- A 12-route × 3-role × 3-database tour covered Overview, Keys, Console, Workbench, Import, Tutorials, Slowlog, Pub/Sub, Streams, Search, Analysis, and Profiler availability. Feature actions used sandbox-e2e, with a checked hash edit and analysis on snapshot. All three roles also opened/formatted the live remote hash as effective viewer. The tour verifies availability/access states, not action parity by itself.
- Forty settled base-layout screenshots cover ten views at **1024 and 1440**, **light and dark**, with additional hash, drawer, landing, and Preferences screenshots at all four combinations. Populated workflow screenshots accompany the feature probes. No document-width overflow was measured in those base layouts. Keyboard checks included drawer shortcut/resize, helper insertion, query navigation, dialogs, and existing key-tree behavior; this is not a screen-reader/WCAG certification.
- All writes used `rw1-20261024:*` fixtures on **sandbox-e2e/6411 or snapshot/6412**. Remote was only read through the application; a browser request allowlist blocked anything outside known read routes. No connection to 6380, no action on port 4000 or the main checkout's `data` directory. Existing sandbox data was retained.

Evidence is in [review-v021-web](review-v021-web/). Important machine-readable logs: `timings.json`, `remote-scroll.json`, `detail-results-r3.json`, `clipboard-results.json`, `shell-results.json`, `insight-results.json`, `probes-results.json`, `followup-results.json`, `extra-results.json`, `final-checks-results.json`, `columns-results.json`, `wizard-prefix-results.json`, `tour-settled-results.json`, `tour2-results.json`, and `layouts-final.json`. Not every raw `ok:false` is a product defect: wrong locators, trying to paste into an inert modal background, a hard reload that intentionally cleared session memory, an initially omitted **read-only** `/pubsub/channels` allowlist entry, and an incorrect hypothesis that narrow metrics were hidden were corrected and rerun. Earlier unsettled screenshots/tour observations were discarded. The report's findings are the reproduced product issues only.

Source locations below refer to the reviewed commits. After the requested worktree removal, inspect them with `git show 3fa23d1:<path>` in the main repository. [source-evidence.md](review-v021-web/source-evidence.md) preserves the key comparison excerpts.

## 1. Fix verification, F1–F27

“Fixed” means the audited outcome is delivered in the exercised/common workflow and agrees with the compared RI capability. “Partly fixed” identifies a concrete remaining part or reproduced defect. RI source paths are relative to `redisinsight/ui/src` unless prefixed `api/`; RC paths are relative to `apps/web/src` unless stated otherwise.

| ID | Verdict | Live evidence and current implementation | Redis Insight comparison / residual |
|---|---|---|---|
| **F1 collection lookup** | **Fixed** | Exact unloaded hash field and set member; list index 210; zset score 200–219 descending; page count stays distinct from collection total. Criteria reset page state. `CollectionLookup.tsx:11`, `KeyInspector.tsx:502`; `lookup-format-ttl`, `set-zset-lookup`, `list-jump-stale-editor`. | RI hash `HashDetailsTable.tsx:292`, list `ListDetailsTable.tsx:179`, set `SetDetailsTable.tsx:157`, zset `ZSetDetailsTable.tsx:240`. Explicit exact-byte lookup and honest unknown MATCH total are useful improvements. |
| **F2 folder shares** | **Fixed** | Both full trees show counts, % of matching keys, full glob and precise share in tooltip. Shares match the owner's screenshot; partial memory sums are qualified. `pages/Keys.tsx:112,692,993`. Screenshots `snapshot-tree-1440.png`, `remote-expanded-scrolled.png`. | RI `components/virtual-tree/components/Node/Node.tsx:190`. RC improves denominator and partial-size disclosure. |
| **F3 in-place formatting** | **Fixed** | Hash JSON cells preserve `9007199254740993`; expandable values, shared formatter and keyboard-operable width control. `KeyContent.tsx:66,291,630`; `hash-formatted-1440.png`, four layout hash screenshots. | RI `HashDetailsTable.tsx:395,461,659` formats cells/controls widths. RC now achieves the useful collection-value outcome. Independent field-name codec selection remains an optional refinement, not required for this tested data. |
| **F4 analysis** | **Fixed** | Coverage-qualified recommendations, history, two-report comparison on both sandboxes; cancel on snapshot returned 250 sampled keys and explicit partial coverage. `pages/analysis/AnalysisTool.tsx:42`, server `routes/analysis.ts:167`. `analysis-compare-snapshot.png`, `analysis-cancel-partial.png`. | RI `pages/database-analysis/DatabaseAnalysisPageView.tsx`, `components/recommendations-view/Recommendations.tsx:49`. RC keeps recommendations local and explicitly sample-based; promotional rule breadth is not a parity target. |
| **F5 status metrics** | **Fixed** | CPU after the second reading, ops/s, memory, clients, selected DB keys and freshness persist across pages. All remain visible in the final 1024px drawer screenshot. `StatusBar.tsx:11,108`, `lib/dbstats.ts:51,68`. | RI `components/database-overview` and `components/instance-header/InstanceHeader.tsx`. RC separates server-wide metrics from logical-DB keys. Initial `CPU —` is correctly explained, not a missing metric. Failure/staleness states were source-inspected; prolonged network outage was not simulated. |
| **F6 field TTL** | **Fixed** | Visible HTTL column, 300-second set and HPERSIST round trip; viewers can read TTLs but cannot set them. `KeyContent.tsx:291`, `HashExpiry.tsx:9`; `field-ttl.png`. | RI `HashDetailsTable.tsx:583` TTL column/edit. RC's one-page batch and explicit capability reason match the useful workflow. Unsupported older Redis/ACL variants were source/test-backed, not a new live server matrix. |
| **F7 search wizard/details** | **Partly fixed** | HASH and JSON Make searchable → sample → schema → exact generated FT.CREATE → confirmation → indexed docs passed. Index details include schema/options/memory/errors. Typed drop preserved docs. `MakeSearchable.tsx:16`, `IndexWizard.tsx:88`; screenshots `wizard-review.png`, `json-index-detail.png`, `index-drop-confirm.png`. | RI `pages/vector-search/pages/VectorSearchCreateIndexPage`, index details, and Make searchable. **M1:** a changed prefix can receive the previous prefix's sample/schema. This prevents an unqualified “safe wizard” pass. |
| **F8 search workflow** | **Fixed** | Numeric sort, table/JSON, applied-query pagination after draft changes, open exact document, saved query/results across SPA Back, explain/profile and direct palette destinations. `pages/search/QueryPanel.tsx:124,361`, `QueryEditor.tsx:54`, `lib/insightPalette.ts:9`; `search-session-restored.png`, `search-json-page2.png`, `search-palette.png`. | RI `VectorSearchQueryPage`, query editor, saved-query and result components. Completion/source inspected and unit-tested; not every completion grammar was action-tested. Reload intentionally clears query data under our memory-only policy. |
| **F9 full elements** | **Fixed** | Full 100,007-byte binary hash element download matched raw SHA-256; native Base64 clipboard paste matched all 133,344 characters. Shifted list full-read reference returned 409 and stayed undownloadable. `KeyContent.tsx:565`, `ValueViewer.tsx:184,228`; `full-element-byte-exact.png`, `full-list-stale-reference.png`, `clipboard.json`. | RI bounded collection/value retrieval. RC retains byte identity and refuses moved references; list reference tightening from the server review is effective live. |
| **F10 import** | **Fixed** | File plan runs nothing before confirmation; four lines produced three successes and one WRONGTYPE, with later EXPIRE applied. A blocking import cancellation explicitly reported its running line as uncertain and nine commands not sent. `pages/guided/ImportPanel.tsx:79,96`; `import-outcome.png`, `import-cancel-partial.png`. | RI `api/src/modules/bulk-actions/bulk-import.service.ts:100` batches/import summary. RC exceeds it in policy/confirmation/partial-outcome clarity; unrestricted execution is excluded. |
| **F11 rich Workbench results** | **Partly fixed** | FT.SEARCH table, TS.RANGE chart, FT.PROFILE and EXPLAIN plans all ran against real fixtures. `components/RichReply.tsx:187`, `lib/richReply.ts:193`; `workbench-rich-1440.png`, `search-profile.png`. | RI built-in `packages/redisearch`, `redistimeseries-app`, `ri-explain` visualizations. **M2:** TS.MRANGE silently omits series after twelve. Geo/graph were optional in the plan and remain absent. |
| **F12 tutorials** | **Fixed** | Offline Search/JSON/Streams/TimeSeries recipes and insertion into Workbench without execution. `content/tutorials.ts:29`, `pages/guided/Tutorials.tsx:111`; layout tutorial screenshots and `tutorial-insert-and-palette`. | RI enablement area/query tutorials. Curated offline instruction matches the requested safe subset; arbitrary uploaded/remote tutorial content is not needed. |
| **F13 logical DB context** | **Fixed** | `db 0` in header, drawer, landing and status; selected DB counts differ correctly from server-wide totals when INFO lists db0/db1 on sandbox-e2e. `StatusBar.tsx:90`, `lib/dbstats.ts:68`, server `routes/databases.ts:76`; landing screenshots. | RI instance-header DB selector. Choosing among configured entries remains available; arbitrary SELECT intentionally stays prohibited. All provided targets are configured as db0, so a nonzero configured alias was not newly live-tested. |
| **F14 Tree/List/columns/sort** | **Fixed** | Explicit Tree/List, descending sort and metadata chooser; switching from deep flat-list scroll back to Tree resets scroll. Metadata choices remain available at 1024. `pages/Keys.tsx:181,885,1070`; `key-view-columns-refresh`, `columns-results.json`. | RI `KeyTree`, `KeyList`, `KeyTreeSettings`. Advanced grouping beyond delimiter is optional; present behavior restores the audited daily workflow. |
| **F15 stream inspector** | **Partly fixed** | Groups → consumers → PEL, payload inspection, ID/range/consumer filtering, confirmed XCLAIM and XACK passed. `StreamInspector.tsx:48,61,69`; `stream-pending-payload.png`, `stream-consumer-actions-gap.png`. | RI `stream-tabs/StreamTabs.tsx`, `consumers-view/ConsumersViewWrapper.tsx:79,184` includes consumer deletion. RC inspector has no consumer-delete or group lifecycle controls; group creation/destruction still require separate Diagnostics. **L2**. |
| **F16 inventory freshness** | **Fixed** | Refreshed age and opt-in cadence; a five-second tick issued a new names scan. Source pauses for dialogs, typing, selection and bulk jobs. `pages/Keys.tsx:409,1021`; `key-auto-refresh.png`. | RI browser refresh controls. Explicit list/inspector freshness distinction retained. The full pause permutation matrix was covered by passing existing tests, not separately repeated live. |
| **F17 formatters/export** | **Partly fixed** | Float32 LE live preserved `1.5`, `-0`, Infinity, NaN; float32/64 LE/BE and alignment tests passed. Original-byte download exists. `ValueViewer.tsx:21`, `lib/format.ts:89`; `float-vector.png`. | RI `utils/formatters/valueFormatters.tsx:124–216` includes MsgPack LZ4, PHP, Java, vectors, Protobuf/Pickle, plus other compression choices. Only the promised vector first slice shipped; inert Java/PHP trees, extension/codecs/schema inspection remain absent. **L3**. |
| **F18 multi-add** | **Fixed** | Hash two-entry race stopped at the conflicting second row and preserved the concurrent value; list/set/zset two-entry forms also checked live. `MultiEntryAdd.tsx:12,51`; `multi-add-partial-conflict.png`. | RI repeatable add-row forms. RC preserves per-replacement CAS, bounded form size, sequential partial results. No claim of transaction-wide rollback. |
| **F19 slowlog context** | **Fixed** | Admin threshold/max length matched live CONFIG GET; selectable count and five-second refresh; operator/viewer see reason instead of config. `components/diagnostics/Slowlog.tsx`; `slowlog-admin.png`. | RI `pages/slow-log/components/Actions/Actions.tsx:105`, `SlowLogConfig`. Duration units/freshness and actual read-only configuration now match. CONFIG SET remains intentionally excluded. |
| **F20 pattern-delete job** | **Fixed** | 6,000-key completion; 100,000-key job stopped after **12,018 deleted**, **87,982 retained**, zero failures, honest final partial report. Remaining fixtures removed afterward. `lib/bulkjob.ts:25`, `pages/Keys.tsx:1444`, server `routes/bulkDelete.ts:281`; `bulk-delete-cancelled.png`. | RI bulk-actions progress/stop. RC keeps stronger scope preview/typed confirmation and explicitly says closing is not stopping or rollback. |
| **F21 landing organization** | **Fixed** | Metric sort and reverse/default cycle; schema/source supports configured tags/capability badges; narrow layout hides secondary badges. `pages/Landing.tsx`, `lib/preferences.ts:31`; `landing-sort-1440.png`, four landing layouts. | RI `pages/home/components/databases-list/DatabasesList.tsx` sort/tags. Current dev config has no tags, so configured-tag rendering is source/test-verified, not live visible-tag verification. Operational comparison remains stronger. |
| **F22 Pub/Sub** | **Fixed** | Three topics, subscription/message continuity through Keys, freeze/new-arrival count, lossless JSON and fallback text, clear/stop; publish disabled for viewer/remote. `components/diagnostics/PubSub.tsx:55,185,310`, `lib/live.tsx`; `pubsub-frozen.png`. | RI `pages/pub-sub/components/subscribe-form/SubscribeForm.tsx:90`. RC now supplies the session/control workflow while retaining active-channel counts and bounds. The full 15-minute expiry was not waited out. |
| **F23 vector-set inspector** | **Not fixed — deferred** | Unsupported type fallback remains; float-buffer formatter is not a vector-set inspector. No new VSIM inspection flow. | RI dedicated vector-set details/similarity. Explicitly excluded from this review's fix expectation. |
| **F24 arrays** | **Not fixed — deferred** | No array inspector. Command metadata may document array commands on capable servers; that is not an inspector. | RI feature-gated array details. Explicitly deferred; no array fixture was created. |
| **F25 catalog/profiler controls** | **Partly fixed** | Search/group/policy catalog, profiler pause/clear/stop and bounded native clipboard export passed. `drawer/CommandHelper.tsx:62`, `diagnostics/Profiler.tsx:135`; `profiler-copy-no-file-export.png`. | RI CommandHelper + `monitor/MonitorLog/MonitorLog.tsx:58` file download. **L1** hidden selection mismatch; no explicit bounded profiler **file** export (L4). Clipboard export is present and useful. |
| **F26 Preferences** | **Fixed** | UTC/ISO sample, editor/default formatter/refresh/cleanup preferences, reset and validated presentation-only storage. Scan threshold choices live in the key footer. `pages/Preferences.tsx`, `lib/preferences.ts:72`, `lib/keyscan.ts:51`; four Preferences layouts. | RI Settings/DateTimeFormatter/WorkbenchSettings. Safe requested options are present. Minor copy issue: “Scan sizes … set by the server” should distinguish the hard limit from the user-selectable threshold. |
| **F27 bottom tools** | **Partly fixed** | Drawer available across DB pages, shared Console transcript, database-bound live sessions, keyboard resize, correct profiler gating, risk frame always visible. `drawer/ToolsDrawer.tsx:61,154`; `drawer-1440.png`, four drawer layouts. | RI `components/bottom-group-components/BottomGroupComponents.tsx:34` can render CLI, helper and monitor **simultaneously**. RC uses mutually exclusive tabs. Persistent availability is fixed; simultaneous command/help/observe remains a downgrade (L5), unless explicitly accepted as a product difference. |

## 2. Key browser versus Redis Insight

### Independent timings

Fresh browser-document navigation with warm Redis pools, 1440×900, viewer; timer ends at `key-scan-summary[data-done=true]`, so these figures include app startup and tree construction. Three runs each. SCAN is not an atomic snapshot; live remote key count varied slightly later in the review.

| Measurement | snapshot | remote-6390 | RI comparison |
|---|---:|---:|---|
| Loaded names / full inventory | all / all (about 7.5k) | all / all (about 8k) in timed runs | Owner reported ~8,000 in RI; no contemporaneous RI runtime measurement |
| Full tree times | 837 / 852 / 825 ms | 850 / 833 / 837 ms | Wall-clock speed difference cannot be measured from source |
| Median | **837 ms** | **837 ms** | Names-first architecture now matches RI |
| Names API elapsed time | 13–23 ms | 86–104 ms | RI scanner loops SCAN COUNT ≤2,000; tree requests names without metadata |
| Opening requests | 1 names + 1 metadata | 1 names + 1 metadata | Equivalent keys + get-metadata split |
| Initial metadata leaf keys | 3 | 1 (large folder collapsed) | RI also loads visible/virtual rows lazily |
| Expanded-folder scroll | p95 18.3–18.9 ms, max 19.9 ms | p95 18.9 ms, max 19.6 ms | RI also virtualizes; no RI frame timings obtained |
| DOM rows during deep scroll | ~51 | 50 | Not thousands of mounted rows |
| Metadata while scrolling | ~150 additional keys over ~12.5 screens | 199 keys in four batches over ~15 screens | No all-key metadata waterfall |

The initial remote scroll pass did not expand any folder and was correctly discarded as a scrolling test. The separate expanded pass opened the parent folder, then its largest child, and scrolled 9,660px; its record is `remote-scroll.json`.

**Namespaces:** the folder shares on both databases were checked against exact counts to two decimals. Compact rows show whole percentages, while tooltips retain the precise share/full pattern. A folder that is nearly the whole inventory says `>99%`, avoiding a false 100%. Shares are of matching loaded names, with partial-scan wording when coverage is incomplete. Folder memory initially says `≥ …` plus “sizes of N of M keys loaded”; it does not falsely present a complete byte sum.

RI source: `BrowserPage.tsx:252` chooses tree scan size; `slices/browser/keys.ts:667–683` sends `keysInfo:false`; `api/.../standalone.scanner.strategy.ts:87–115` loops SCAN; `KeyList.tsx:371–405` fetches missing row metadata; `virtual-tree/.../Node.tsx:190` displays shares. RC's `keys/names`, `keys/meta`, trie and virtual-row model restore the capability that matters to the owner. **The 200-key manual paging downgrade is gone on both tested targets.** Metadata sorting or “No TTL” intentionally loads broader metadata with explicit progress, so it has a different cost from opening the names tree.

![Copy namespace tree](review-v021-web/snapshot-tree-1440.png)

![Live remote expanded and scrolled](review-v021-web/remote-expanded-scrolled.png)

## 3. Findings by severity

### M1 — Index wizard can combine a changed source with a stale sample

**Location:** `pages/search/IndexWizard.tsx:88–101`, source controls at `159–177`, spec creation at `81`. **Status: live reproduced with a delayed real response, no response data fabricated.**

1. On sandbox-e2e, seed HASH `rw1-20261024:source-a:1` with `name`, `price`, `category`, and HASH `rw1-20261024:source-b:1` with different fields, `username`, `rating`.
2. Open Search → New index; select HASH / prefix `rw1-20261024:source-a:` and start Sample keys.
3. While the real `/search/sample` response is held in Playwright, change the still-enabled prefix to `rw1-20261024:source-b:`; release the response.
4. Continue to Review, create `idx:rw1-20261024:stale-proof` through the confirmation, and inspect it.

**Observed:** `FT.CREATE idx:rw1-20261024:stale-proof ON HASH PREFIX 1 rw1-20261024:source-b: SCHEMA category TAG name TEXT price NUMERIC`. The sample/schema came from source A, but the command targets source B. Create remains enabled, confirmation succeeds, and the index contains source B's document with **source A's schema**. Source B's `username`/`rating` fields are absent from that schema; searching its value through the stale `name` field returns zero matches. The proof index and both keys were removed. An earlier HASH→JSON variant produced a mismatched preview too, but JSONPath validation disabled Create; that variant alone does **not** demonstrate an executable bad index. The prefix-only reproduction does.

**Expected/impact:** reviewed schema must belong to the source the wizard says it will index. An operator can otherwise create a misleading/ineffective index or index a different namespace than the sampled one; confirmation repeats the mismatched command but does not repair its provenance.

**Minimal fix:** disable source/prefix/folder controls while sampling and invalidate sample/schema when source changes; also capture a source/generation token and discard late responses that no longer match. Merely checking `busy` on Sample is insufficient. Add a delayed-response regression covering both type and prefix changes.

![Stale schema with changed HASH prefix](review-v021-web/finding-wizard-stale-sample.png)

![Created index with stale schema](review-v021-web/finding-wizard-stale-created-index.png)

### M2 — Multi-series Workbench charts silently omit returned series

**Location:** `lib/richReply.ts:193` (`items.slice(0, MAX_SERIES)`; cap declared at `46`), `components/RichReply.tsx` multiSeries rendering. **Status: live reproduced.**

1. Create thirteen two-sample TimeSeries keys labelled `rw1=20261024` on sandbox-e2e.
2. Run `TS.MRANGE - + FILTER rw1=20261024` in Workbench, then Tree / table.
3. Compare the direct Redis result count with `.rich-series` rendered sections and search the rich view text for the last key.

**Observed:** Redis returned 13 series; UI rendered 12, omitted `rw1-20261024:series:12`, with no “12 of 13”/omission notice. The raw reply remains available by switching representation, so this is misleading presentation, not server-side data loss.

**Expected/impact:** a bounded renderer must disclose any dropped series/columns. An incident investigation may miss the anomalous series while trusting a complete-looking chart.

**Minimal fix:** return total/omitted counts from the rich parser and show a persistent cap notice plus raw-view/narrow-query action. Apply the same rule to the forty-column table cap and any other renderer limit. Retain the bound; do not remove it. Add a thirteen-series regression.

![Twelve drawn series without an omission warning](review-v021-web/finding-mrange-twelve.png)

### L1 — Filtering the command catalog retains and inserts a hidden selection

**Location:** `components/drawer/CommandHelper.tsx:62`. **Status: live reproduced.**

1. Open Command helper; search HSET and select its exact result.
2. Replace the search with GET. The visible result list changes to GET matches.
3. Click Insert in Console.

**Observed:** detail remains HSET and the inserted prompt is HSET; no visible list option is selected. The detail does still say HSET and execution requires a separate action, limiting severity.

**Expected/impact:** the selection should remain within the filtered result set or clearly say that it is pinned outside that set. Current behavior invites an unintended command insertion.

**Minimal fix:** find `selected` within the flattened `shown` list, falling back to its first result; reset selection when group/policy filters exclude it. Add filter-after-selection coverage.

![GET filter with HSET detail and insertion target](review-v021-web/finding-helper-stale-selection.png)

### Low-priority remaining capability gaps

These are confirmed UI/source differences rather than security bypasses. Each has a direct reproduction and a small next scope; broad codec implementations are inherently larger than a bug fix.

| ID | Reproduce / observed vs expected | Location and minimal next change | Evidence |
|---|---|---|---|
| **L2 stream consumer actions** | Open fixture stream → groups/consumers. Pending/claim/ACK work; no delete-consumer control. Group lifecycle requires a separate tool/key entry. RI offers consumer deletion here. | `StreamInspector.tsx:61,69`; add a typed, role-gated, confirmed consumer-delete action with pending-count consequences, then inspector-bound group lifecycle controls. Preserve binary identity. | [Stream inspector](review-v021-web/stream-consumer-actions-gap.png); RI `ConsumersViewWrapper.tsx:79,184`. |
| **L3 remaining safe formatter coverage** | Open a value's formats. Float buffers now work; Java/PHP are not decoded as inert trees; MsgPack extensions and additional codecs/schema inspection remain unavailable. Do not equate detection with decoding support. | `ValueViewer.tsx:21`, `lib/format.ts:89`; retain “detected, not decoded” wording and add only bounded inert decoders backed by actual payload fixtures. Never introduce executable deserialization. | [Formatter choices](review-v021-web/float-vector.png); RI `valueFormatters.tsx:124–216`. |
| **L4 profiler file export** | Record and stop a bounded profiler session. Copy shown commands works, but no file Download/Export action exists; RI provides a log download. | `diagnostics/Profiler.tsx:157`; add an explicit local Blob download of the already disclosed bounded buffer, static filename, no expanded capture or permissions. | [Profiler controls](review-v021-web/profiler-copy-no-file-export.png); RI `MonitorLog.tsx:58,104`. |
| **L5 simultaneous bottom tools** | Open helper while the drawer Console is visible. Helper replaces Console; profiler is another mutually exclusive tab. RI can show these components together. | `drawer/ToolsDrawer.tsx:154,220`; either add an optional split for command/help/observe, or explicitly accept the tabbed design as a product difference. Keep the dense default and keyboard resize. | [Tabbed drawer](review-v021-web/layout-1024-dark-drawer.png); RI `BottomGroupComponents.tsx:34`. |

No additional High/Medium issue is asserted from source suspicion alone. In particular, a candidate “CPU/clients hidden at 1024” was disproved in the final build: both metrics are visible, including with the drawer open. The Preferences scan-size wording is a minor copy correction, not a security or functional failure.

## 4. Correctness, data handling, and access checks

| Concern | Verified outcome | Practical limit |
|---|---|---|
| Wrong item/stale save | List editor closes after a concurrent index value change + refresh. Hash stale save returns conflict and retains the other writer's bytes. Multi-add stops on second-row CAS conflict, retaining first-row success and reporting partial outcome. Shifted full-list reference returns 409. | Repeated identical list values have no durable Redis element ID; these checks protect observed value/index semantics, not a snapshot transaction over the whole list. M1 is a separate stale wizard-state defect. |
| Exact display/copy/download | Wide JSON integer retained in table; BOM, CRLF, bidi and HTML-like text remain data. Full binary download's raw SHA-256 matched; Base64 native clipboard paste matched 133,344 chars. Float display preserves negative zero/nonfinite values; raw download remains original bytes. | Textarea paste normalizes CRLF, so raw binary claims use Base64/download hashes. Renderers deliberately bound visual output; M2 shows an undisclosed rich-view bound that must be fixed. |
| Inert Redis data | HTML-like strings remained text; no `img[src=x]` node appeared. Source scan found no Redis-content `dangerouslySetInnerHTML`/`innerHTML`/eval/Function path in app code. | This is not a parser fuzzing certification or a statement about every dependency's internals. |
| URLs/browser storage | Fixture marker absent from navigation URL/title and local/session storage after reading/editing. API requests carry names/queries in POST bodies; fixed `?tab`/`?panel` values only. Download is an opaque Blob URL/static `redis-value.bin`. Storage holds validated presentation options, scan count, theme, and configured DB ID. | Intentional screenshot/report files contain review evidence; those are requested artifacts, not browser-state persistence. |
| CSRF | Missing token, invalid token, and valid token + foreign Origin each returned **403** on sandbox `/ops`; no key was written. Server checks Origin/token before body parsing (`apps/server/src/app.ts:225–249`). | No malicious remote writes were attempted to prove rejection; that would violate the task boundary. |
| Confirmations | Search create, typed index drop, import, pattern deletion, stream claim/ACK all challenged and completed against sandbox fixtures. Reviewed target/commands were visible. | No production writes were attempted. Only the configured dev/test targets were used. |
| Role hiding vs enforcement | Viewer direct `/ops` write returned **403**, with unchanged data. Viewer has no multi-add/write controls. Admin/operator are effective viewer on remote, with no edit/add/delete controls. Import effective-role server gate was inspected after the server review fix. | Server validation was sampled, not a fresh exhaustive route matrix; the 432 web tests and source review supplement it. |
| CSP/runtime errors | **Zero `securitypolicyviolation` events** and zero uncaught application errors in instrumented completed runs. | Expected 401 auth probes, 428 challenges, 409 conflicts, deliberate 403 tests, and harness mistakes are separately recorded. Earlier direct clipboard-read Permissions-Policy violations were caused by review instrumentation, not application behavior; final copy checks used native paste. |
| Cancellation | Import reports an in-flight command as “may have run,” with later commands unsent; analysis reports partial sample; bulk delete reports actual deletions and retained keys. No automatic ambiguous write retry observed. | Cancellation is a boundary between commands/batches, not rollback. |

## 5. UX and DESIGN assessment

The new features largely follow DESIGN: flat ruled panes, restrained semantic colors, legible mono identifiers, visible effective role/logical DB, native dialogs and reviewable commands. At 1024, key toolbars wrap but actions remain reachable; at 1440, the drawer and tool panes use the extra width. Both themes retain risk framing above the drawer. The layouts with the drawer open demonstrate the intended space tradeoff; users can resize it by keyboard or close it. No phone/tablet readiness claim is made.

- **Drawer/catalog/profiler:** useful global availability, shared Console state, discoverable shortcut and keyboard resize. The tabbed design's simultaneous-tool gap and hidden catalog selection are the remaining issues. Bounded profiler copy is verified; file export is absent.
- **Metrics/landing:** meaningful scopes and freshness; all requested metrics visible at the desktop floor. Landing retains useful operational comparison and adds sort without a host editor. Tags are schema-supported but absent from the provided config.
- **Pub/Sub/slowlog/Preferences:** controls and feedback are consistent, readable and role-aware. Pub/Sub freeze preserves the reading position while indicating arrivals. Slowlog shows actual privileged config or an honest reason. Preferences are limited to safe enumerated presentation settings. Clarify its scan-size help text.
- **Collections/full elements/multi-add:** day-to-day lookup/formatting is much more usable. In-place format choices, expansion and exact raw download are meaningful upgrades. At 1024 the hash value column can be narrow because field, TTL and action columns share the inspector; the width slider and maximize affordance provide recovery. A separate field codec and a compact TTL-column option are refinements, not a blocker for the tested workload.
- **Streams:** bound inspection is a large improvement; lifecycle/consumer deletion remains the one material everyday RI capability gap.
- **Search/analysis/results/import/tutorials:** the normal end-to-end workflows are coherent and useful, with actionable sample-qualified analysis and honest import summaries. Fix M1/M2 before treating those feature areas as unqualified parity. Tutorials insert without executing, and module/role explanations remain visible.

## 6. Remaining downgrades, including beyond the original list

1. **F7:** stale-source wizard race (M1); successful normal creation does not make that state transition safe.
2. **F11:** silent rich-renderer caps (M2); twelve-series truncation was reproduced. Forty-column omission has the same source pattern and should be disclosed, but was not separately live-reproduced as a finding.
3. **F15:** consumer deletion and full inspector-bound lifecycle remain behind RI.
4. **F17:** safe decoder/codec/schema breadth remains behind RI; only float vectors and raw export were added in this slice.
5. **F25:** helper hidden selection; profiler file export absent, although clipboard export works.
6. **F27:** persistent drawer matches availability, but RI can display multiple bottom tools simultaneously.
7. **Deferred F23/F24:** still absent by explicit agreement, not a surprise release regression.
8. **Additional RI capabilities outside the fix list:** geo map/heatmap and graph result visualizations, and richer/custom tutorial libraries remain source-visible RI capabilities. They are optional or explicitly outside the curated/inert-content scope; no live superiority or present development need was established. No additional material downgrade in the exercised core workflows was found.

## 7. Final change vs keep

| Redis Insight capability | Current relation | Change vs keep |
|---|---|---|
| Fast names-first full namespace tree | **Match** on both tested targets | **Keep ours**; the original 200-key downgrade is resolved. |
| Namespace counts/shares, lazy metadata, virtual scrolling | **Match; clearer coverage** | Keep precise tooltip/partial-size semantics and binary identity. |
| Tree/List, columns, sorting, pane resize/maximize | **Match** | Keep explicit choices and keyboard equivalent. |
| Collection lookup and bulk additions | **Match; safer replacement handling** | Keep CAS, absent expectations and partial-result summaries. |
| Collection formatters and visible field TTLs | **Match** common JSON/MsgPack/vector/TTL workflows | Keep; widen safe codec support only against real payloads. |
| Full single-element retrieval/export | **Match; safer stale references** | Keep byte hashes, caps and moved-element rejection. |
| String/JSON edit/TTL/rename/delete | **Match; stronger conflict/no-overwrite UX** | Keep ours. |
| Stream groups/consumers/PEL actions | **Partial** | Add confirmed consumer deletion and lifecycle in the inspector. |
| Native TimeSeries inspection | **Exceed** RI browser fallback | Keep ours; separately fix rich multi-series omission reporting. |
| Vector-set / array inspectors | **Deferred difference** | Revisit only under agreed server/use requirements. |
| Operational database landing | **Exceed** for shared operational comparison | Keep ours, plus new sort/tags. |
| Logical-DB context and safe configured selection | **Match** safe subset | Keep explicit scope; arbitrary SELECT stays excluded. |
| Persistent CPU/ops/memory/keys/clients | **Match** | Keep separated logical/server scope and freshness. |
| Search create/details/query/saved workflow | **Partial until M1 fixed** | Keep new workflow; bind schema provenance to source. |
| Workbench table/chart/plan | **Partial until M2 fixed** | Keep trusted built-ins and raw fallback; disclose every bound. |
| Geo/graph plugins | **Optional difference** | Defer based on need; no arbitrary plugin marketplace. |
| Analysis/recommendations/history/compare | **Match useful local subset** | Keep coverage-qualified local rules and cancellable reports. |
| Policy-aware bulk import | **Match workflow; exceed guardrails** | Keep per-line policy/audit, confirmations and honest cancellation. |
| Pattern delete progress/stop | **Match; stronger decision context** | Keep preview, typed scope, actual counts and partial outcomes. |
| Slowlog table/config/refresh | **Match** read workflow | Keep sanitized disclosure; CONFIG SET remains excluded. |
| Pub/Sub topics/messages/continuity | **Match; useful freeze/context** | Keep active channels, bounds and explicit Stop. |
| Command catalog/profiler | **Partial** | Fix hidden selection; add bounded file export. Keep policy labels/timebox. |
| Bottom CLI/helper/monitor together | **Partial** | Keep persistent drawer; decide optional split vs explicit tabbed difference. |
| Offline tutorials/common guided forms | **Match curated subset; safer forms** | Keep offline insertion and generated commands. |
| Safe presentation Preferences | **Match requested subset** | Keep validated storage and policy separation; clarify scan-size copy. |
| Keyboard flow/risk context/conflict UX | **Exceed** for the reviewed internal workflow | Keep ours; this is not universal accessibility certification. |
| User-added hosts, cloud/AI, telemetry, scripting/unrestricted admin, durable Redis-value history | **Intentionally differ** | Keep excluded; these are not parity defects. |

## 8. Cleanup

Completed and verified:

- Review-created prefix `rw1-20261024:*`: **zero keys** on 6411 and 6412 after cleanup; **zero** `idx:rw1-20261024:*` indexes. `cleanup.json` records the final independent scans. Initial fixture cleanup removed 49 remaining keys; subsequent proof fixtures/indexes were also removed and the final scan was empty. The 100,000-key cancellation fixture was removed after its retained-count check.
- Server PID **4011** stopped by PID; parent pnpm process **3987** exited. Port **4700** has no listener. Completed Playwright harnesses closed their own browsers.
- Isolated `/tmp/rc-v021-rw1` removed with a scoped filesystem operation; our E2E lock released. The shell rejected an earlier rm-f style cleanup command before execution.
- Source was clean immediately before removal. The required command `git -C <repo> worktree remove --force ../redis-console-wt/v021-rw1` completed successfully; the directory is absent.
- Port 4000, the owner's shared data directory, other checkouts/processes, and pre-existing sandbox keys were left alone. Remote was never sent a write; port 6380 was never connected.
- Report, screenshots, synthetic fixture bytes, source excerpts, and non-secret review scripts/logs remain under `<research-dir>`. Scripts refer to the now-removed review checkout and require recreating a suitable checkout/dependencies/accounts to rerun; they are evidence, not an installed application.
