# Redis Console v0.2 — independent web review

Reviewed on 2026-10-23, detached release commit **1984f93**. Recommendation: **fix the two High data-loss paths and the Medium findings before shipping**. No Critical finding was established.

Source scope: `apps/web` excluding Console/Workbench internals, `tests/e2e/specs/ui`, `docs/DESIGN.md`, and `docs/qa/v02-ui-live.md`. Read `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/V0.2-PLAN.md`, and `packages/shared/src/api.ts` as the specification. Incidental server reads below establish permission enforcement, not a full backend security audit.

All source references are relative to the repository at that commit. All screenshot paths below are under **`<research-dir>/review-w1/`**; evidence JSON files are in the same directory. No source files were edited and no commits were made.

## Verification and boundaries

- Created the requested detached worktree at `../redis-console-wt/review-w1`, linked the root `.env`, ran `pnpm install`, and successfully ran `pnpm --filter @rconsole/web build`.
- Started the built SPA and server on **4700**, with `RCONSOLE_DATA_DIR=/tmp/rc-review-w1` and the supplied dev config. Provisioned local QA accounts with the supplied script.
- Used **Playwright Chromium from `tests/e2e/node_modules`**, as requested. Ran a fresh 240-entry page/role/database/theme/width matrix: viewer/operator/admin; four requested databases; light/dark; 1440×900 and 1024×900; database landing, Overview, Keys, Guided, Diagnostics, Account, Audit and Local users. Unauthorized admin pages were checked for their denied state. See `matrix.json`.
- Completed another **93 diagnostics/auth/admin checks**, including memory analysis, pub/sub listen and publish, stream group creation, search/module states, TimeSeries, clients, short profiler sessions, SSO no-group refusal, local sign-in including admin TOTP, user creation/role change/disable, and audit filters/pagination. These are a tour-completion count, not proof that the targeted failure cases below pass. See `feature-results.json`.
- Ran **107 frontend unit/component tests: all passed**. The repository E2E specs were reviewed, but the stock E2E suite was not run: its global setup manages a shared-named Redis container and its own server/config. Independent browser scripts exercised this isolated 4700 instance instead.
- Additional targeted reproductions are in `targeted-results.json`, `extra-results.json`, `tree-results.json`, `search-results.json`, `search-pagination-results.json`, and `focus-results.json`. `search-results.json` includes a genuine normal-click failure caused by M1; its cleanup still ran.
- Writes used only review-prefixed scratch keys on `sandbox-e2e`, `sandbox-main`, and `snapshot`. The remote database was guarded at the browser request layer: only GETs and explicitly enumerated read POSTs were permitted. **No remote write request was sent**, and no connection to 6380 was made. Port 4000 and the main checkout's `data/` were not used.
- Read-only UI behavior was tested live. Server refusal on `remote-6390` was verified from the authorization path rather than by sending a real write to shared data: typed ops call `authorize` before execution (`apps/server/src/routes/keys.ts:354`); role and read-only rejection occur in `apps/server/src/policy/policy.ts:179` and `:185`. This distinguishes the live UI evidence from the code evidence.
- This is Chromium qualification. No screen reader, Firefox, Safari, or exhaustive WCAG audit was performed. Reduced-motion behavior and important keyboard paths were exercised directly.

## Findings by severity

### Critical

None established in this review.

### High

#### H1 — Cached collection paging retargets an open editor and overwrites another element

**Locations:** `apps/web/src/components/KeyContent.tsx:59`, `:138`, `:294`; `apps/web/src/components/InlineEdit.tsx:18`; `apps/web/src/components/KeyInspector.tsx:448`.

**Exact repro, operator on sandbox-e2e:**

1. Create a list containing `item-0` through `item-204`.
2. Inspect it, visit Next page once, then First page. This warms the second-page query cache.
3. Open **Edit list index 0**. Leave the draft as `item-0`.
4. Click **Next page** again while the page is cached.
5. The open editor now says **Value at index 100**, but its textarea still contains `item-0`. Click Save.

**Observed:** a fresh API read proved index 100 changed from `item-100` to `item-0`. The panel is identified by page-relative row index, rows are keyed by ordinal, and `InlineEdit` retains its initial draft while its save callback acquires the new item. A cold-page test can miss this because loading unmounts the content. The hash and zset editors share the same identity pattern, although the destructive live reproduction was on a list.

**Expected:** paging closes/cancels the editor, or the draft remains bound to the exact original element. Saving an editor must never silently change its target.

**Minimal fix:** bind panel identity to key + page + element identity, clear it when the page changes, and key the editor by that identity. Do not fix only the textarea: the target and draft must move together.

**Evidence:** `finding-list-editor-cross-page.png`; `targeted-results.json` → `list-editor-cross-page`.

**Missing regression:** warm page 2, return to page 1, open an editor, revisit page 2 and assert no draft migration or unintended write. Existing pagination coverage in `tests/e2e/specs/ui/keys.spec.ts:241` only checks reading the next page.

#### H2 — “Create key” silently overwrites existing non-string data

**Locations:** `apps/web/src/components/KeyOperations.tsx:137`–`:184`, especially `:146` and `:182`.

**Exact repro, operator/admin on sandbox-e2e:** create a JSON key containing `{"important":"must survive","version":1}`. Open **Add key**, select JSON, enter that same name and `{"new":true}`, then press **Create key**. Also reproducible with an existing hash and an existing field name.

**Observed:** the JSON document was entirely replaced with `{"new":true}`; the hash field was replaced with `OVERWRITTEN-BY-CREATE`. No collision warning or change of intent was shown. New strings use `NX`, but JSON and collection creation reuse ordinary mutation operations. List/set/stream creation can likewise change an existing collection instead of creating one.

**Expected:** a create action rejects an existing key, consistently across types. Replacing/editing existing data should be an explicit action on that key.

**Minimal fix:** separate create-only operations from edits and reject collisions server-side. Use an atomic create-only primitive where available, such as `JSON.SET ... NX`; collection creation needs an explicit server-side create contract or a deliberate existing-key edit flow. A frontend-only existence check is insufficient under concurrency.

**Evidence:** `finding-create-json-overwrites-document.png`, `finding-create-existing-hash.png`; `extra-results.json` → `create-json-collision`; `targeted-results.json` → `create-existing-hash`.

**Missing regression:** attempt Add/Create against existing keys of every creatable type; verify the original contents survive. Current add tests use only fresh names (`tests/e2e/specs/ui/keys.spec.ts:62`).

### Medium

#### M1 — Global `.tree-row` CSS breaks JSON Tree views and lets data cover controls

**Locations:** `apps/web/src/styles/keys.css:174`; `apps/web/src/styles/base.css:618`; `apps/web/src/components/ui.tsx:399`.

**Repro:** inspect a normal JSON-shaped snapshot string and select **Tree**. Independently, run a Search query that returns a hash with a long text field.

**Observed:** JSON rows inherit the key browser's `position:absolute; top:0; left:0; width:100%; height:26px`. Several inspected rows all had the same screen top coordinate, **40px**, rather than flowing inside the value pane. In Search, a 4 KiB field sprawled over the tool list and form; an ordinary click on **Run search** timed out because the result's `<code>` intercepted pointer events. This is inert text, not HTML execution, but the UI is unreadable and controls become unusable.

**Expected:** structured data remains inside its own scrollable pane/table and never covers navigation or form controls.

**Minimal fix:** scope virtual key-row rules to `.key-list` or rename the key-browser and JSON row classes. Give JSON rows their own wrapping/layout rules.

**Evidence:** `finding-json-tree-global-css.png`, `finding-search-truncation-unmarked.png`; `tree-results.json` records computed positioning; `search-results.json` records the intercepted click.

**Missing regression:** Tree-tab and Search-result layout checks with short, nested and long values; assert result bounds and that adjacent controls remain normally clickable. Text-content/XSS assertions do not catch this collision.

#### M2 — Inflated content survives a value refresh and displays obsolete data

**Locations:** `apps/web/src/components/ValueViewer.tsx:57`–`:60`, `:129`.

**Repro:** inspect a gzip string containing `OLD-INFLATED-CONTENT`, click Inflate, change that same scratch key to plain `NEW-CONTENT`, and click **Refresh key**.

**Observed:** the inspector's metadata changed to the new 11-byte value, but the value pane and Copy value continued to use `OLD-INFLATED-CONTENT`, labelled “Inflated locally”. An independent read returned `NEW-CONTENT`.

**Expected:** a fresh source value invalidates any transformation of the previous bytes.

**Minimal fix:** associate inflated output with its source bytes/version, clear stale transformation/error state on a source change, and ignore late inflation completions for a superseded source.

**Evidence:** `finding-stale-inflated-value.png`; `targeted-results.json` → `stale-inflated`.

**Missing regression:** inflate, mutate and refresh the same selected key, then verify displayed and copied values. Existing gzip tests stop immediately after inflation (`tests/e2e/specs/ui/keys.spec.ts:208`).

#### M3 — Local scan patches ignore the active filter and leave database counts stale

**Locations:** `apps/web/src/pages/Keys.tsx:889`–`:897`, `:380`–`:384`; `apps/web/src/lib/keyscan.ts:195`–`:202`.

**Repro:** scan a scoped pattern such as `rc-review-w1:<run>:guided*`. Use Add key to create `rc-review-w1:<run>:outside-filter`. Separately, compare the scan's total before/after creating a matching new key.

**Observed:** the outside-filter key was appended to the list and counted as a “match”. One count check changed from `1 match ... of 266 keys` to `2 matches ... of 266 keys`, while a fresh scan reported **267**. The patch updates only `items`, never `dbSize`; rename also keeps the renamed item without rechecking the current scope. A later Select all therefore includes rows that do not satisfy the visible search.

**Expected:** filter membership remains true after local changes, and counts either remain accurate or explicitly identify themselves as snapshot counts.

**Minimal fix:** reconcile confirmed changes against the active match/type scope, and update/refresh the count or mark it stale. A bounded rescan of the current scope is safer than implementing a different glob matcher in the browser. The created key may remain open in the inspector without being inserted into unrelated results.

**Evidence:** `finding-filter-mismatch-after-add.png`; `targeted-results.json` → `add-outside-filter`; `extra-results.json` → `count-after-create`.

**Missing regression:** add/rename across pattern and type boundaries, inspect counts, then Select all and verify exactly which keys would be affected.

#### M4 — Guided writes leave an apparently complete key scan silently out of date

**Locations:** `apps/web/src/pages/Keys.tsx:157`; `apps/web/src/lib/keyscan.ts:62`; `apps/web/src/App.tsx:143`–`:154`; `apps/web/src/pages/Guided.tsx:218`.

**Repro:** scan a review namespace to completion in Keys, navigate within the SPA to Guided mode, create another matching key, then use the Key browser navigation link to return.

**Observed:** the new key was absent (`newRow: 0`), the old match count remained, and the scan footer still said complete. There was no dirty/stale indicator. Editing the already-selected string through Guided did refresh its inspector, so this is specifically the separate scan snapshot, not a blanket query invalidation failure.

**Expected:** the developer can distinguish “this is the old scan” from “the write failed” or “this is the current complete result”.

**Minimal fix:** track a database mutation generation in session memory. Mark older scans as changed and offer a clear Rescan action; optionally reconcile known key mutations. Preserve the explicit, bounded scan design rather than automatically replaying every page after every write.

**Evidence:** `finding-guided-create-stale-list.png`; `targeted-results.json` → `cross-page-create-stale-list`.

**Missing regression:** scan → Guided create/delete → return without a document reload, with an explicit stale signal or reconciled results. `docs/DESIGN.md:184` describes the snapshot choice, but does not make this silent inconsistency acceptable.

#### M5 — Search ignores the API's per-document truncation flag

**Locations:** `apps/web/src/pages/Diagnostics.tsx:1815`–`:1817`; contract `packages/shared/src/api.ts:451`–`:455`.

**Repro:** create a scratch search index over a hash field longer than 4,096 characters; query its document through Diagnostics → Search.

**Observed:** the response set `docs[0].truncated: true` and returned a 4,097-character field preview, but the UI had no truncation/cap/load-full warning. The contract also permits empty fields when the shared reply budget is exhausted, which this UI would present like genuinely empty fields. This remains a correctness problem after M1's layout fix.

**Expected:** bounded previews are unmistakably identified, with a route to inspect the underlying key.

**Minimal fix:** render a per-document truncation notice and an **Open in key browser** action using session-memory key selection. Keep key names out of URLs.

**Evidence:** `finding-search-truncation-unmarked.png`; `search-results.json` → `search-truncation` (`truncatedDocs` nonempty; `uiTruncationWarning` empty).

**Missing regression:** both a shortened field and an exhausted-budget document with `{}` fields; assert the warning and inspect action. Current Search tests assert the presence of a small expected value only.

#### M6 — Search pagination applies unsubmitted draft filters at the old offset

**Locations:** `apps/web/src/pages/Diagnostics.tsx:1596`–`:1604`, `:1728`, `:1793`–`:1805`.

**Repro:** query an index with 26 documents using `*`. Change the Query input to another query without pressing Run search. Press **Next 20** on the existing results.

**Observed:** the request used the newly typed query with `offset:20`, even though that query had never been run. The first 20 matches of the new query are skipped, and the displayed result set changes under a paging action. Changing Index has the same state coupling.

**Expected:** pagination belongs to the last executed index/query. An explicit new search starts at offset 0.

**Minimal fix:** separate draft form state from an applied search descriptor; page only the applied descriptor, or clear/disable the old result pager whenever drafts change. Also disable paging while its request is in flight.

**Evidence:** `finding-search-pagination-uses-draft.png`; `search-pagination-results.json` → `search-draft-pagination`, showing the new query and offset 20 together.

**Missing regression:** edit query/index without submitting, then use Next/Previous and verify the executed descriptor and offsets.

#### M7 — Command palette shortcut opens with focus on Close, so immediate typing is lost

**Locations:** `apps/web/src/components/ui.tsx:341`–`:364`; `apps/web/src/App.tsx:714`–`:716`.

**Repro:** on Overview, use Cmd+K (Ctrl+K on the other shortcut path), then type `keys`, without clicking or tabbing.

**Observed in Chromium:** focus was `BUTTON`, accessible name **Close dialog**; the search field remained empty. The input's React `autoFocus` does not establish the intended focus after the shared modal's `showModal()` sequence. The same initial Close focus was observed when checking the palette from Keys.

**Expected:** opening a command palette puts focus in Search commands, so its main keyboard workflow works immediately.

**Minimal fix:** let Modal accept an initial-focus ref and focus it after `showModal()`, or explicitly focus the palette input at that point. Keep the safe initial focus policy for destructive confirmations separate.

**Evidence:** `finding-palette-focus-close-button.png`; `focus-results.json` → `palette-keyboard`.

**Missing regression:** shortcut → actual keyboard typing → Enter navigation, with no `locator.fill()` or explicit focus. The existing shell test uses `fill()` (`tests/e2e/specs/ui/pages.spec.ts:40`), which hides the failure.

### Low

No additional Low defect is promoted separately. The improvements below are ranked product/design suggestions rather than additional release blockers.

## UX improvements, ranked by impact

1. **Keep audit outcomes visible at 1024.** In `settled-light-1024-adminaudit.png`, the visible area ends in the command column; Outcome and Reason are off to the right. Prioritize Time/User/Outcome/Action, bound command width, and make the horizontal continuation obvious. These are the fields an admin uses to distinguish a refusal from a successful operation.
2. **Provide a temporary full-width inspector.** At 1024 the JSON inspector is around half the usable width and real development documents wrap heavily. A keyboard-accessible “maximize inspector / return to split” action would improve this primary debugging task without abandoning the dense list. See `settled-dark-1024-key-inspector.png`.
3. **Make Guided Find → Keys a concrete continuation.** Add an explicit action that transfers the applied pattern/type and opens the key browser; do not make the user reconstruct the search after reading “Continue in the key browser”. Carry state in memory, not query parameters.
4. **Add compact explanations for type glyphs and the TTL scale.** The consistent type colors and visible countdowns work well; a discoverable legend and one-line explanation that fuse length is logarithmic would help Spring/Node developers interpret them without guessing.
5. **Use platform-appropriate shortcut labels in the shell.** The static `⌘ K` cue and Mac-style rail labels should reflect Ctrl on Windows/Linux when the global registry is merged. Keep the current concise, visible equivalents.
6. **Clarify metric time windows.** Overview combines 15-second INFO totals with 2-second samples. Explain whether a hit rate is cumulative or from the latest interval, especially when no recent requests exist; otherwise it can appear to change drastically without a corresponding cache event.

The core visual direction is already coherent: restrained green-grey surfaces, distinguishable self-hosted typography, flat dense tables, type hues with meaning, persistent environment context, and no repeated decorative dashboard cards. The issues above are specific behavior/layout gaps rather than a request for another redesign.

## Tests that need stronger coverage

The nine findings each name a focused regression. Prioritize H1/H2 first, then M1/M2 and the keyboard flow. Additional gaps in `tests/e2e/specs/ui`:

- The all-pages smoke in `pages.spec.ts:13` verifies a nonempty main area, not that its final data state is loaded or positioned correctly. Assert a meaningful ready state per page before checking screenshots.
- Automated coverage should include the 1024 layouts in both themes with populated inspectors/results, not only empty panes. Check inner overflow and control hit testing as well as document width.
- The v0.2 tour covers many of these flows in `apps/web/qa`, but that does not make them part of the standard UI suite. Preserve reusable regressions in `tests/e2e/specs/ui` rather than depending solely on the live record.
- Announcements and focus should be checked after scan completion, selection, errors, dialog cancellation, and navigation. Native dialogs trap focus and Escape worked in this run, but passing content tests does not prove the intended initial focus.
- Keep safe read-only transport guards in any real-remote tour. Test actual write refusal behind a read-only proxy or isolated simulation rather than sending a valid mutation to shared data.

## Checked and fine

These statements are bounded to the tested commit and paths; they do not cancel the findings above.

- **Build and frontend tests:** production SPA build passed; 107 unit/component tests passed.
- **SCAN completeness and speed:** on snapshot, a fresh full scan loaded **every key (unique names = DBSIZE)**, in **3,813 ms**, across 20 captured responses. The UI count matched. No missing/duplicate key was observed in that run (`snapshot-full-scan.png`, `targeted-results.json`). Counts changed later while scratch fixtures existed, so this is the measured run, not a permanent database size.
- **Bounded rendering:** key rows were virtualized; large namespaces opened in a useful collapsed outline. Continue scan/Scan to end exposed progress and completion. No whole-document horizontal overflow appeared in the 240-entry matrix. Audit has intentional internal horizontal scrolling; see the improvement above.
- **Data stays inert:** a hostile key name containing `<img ...>` and a JSON string containing `<script>` were exercised through Text/JSON/Tree/Hex/Base64/MsgPack. No executable DOM nodes or payload execution appeared. Pub/sub messages containing an HTML payload also remained text. M1 is a layout collision, not a successful XSS.
- **Browser metadata/persistence:** inspected storage contained only `rconsole.theme` and `rconsole.database`; sessionStorage was empty. The title remained `Redis Console`; URLs contained the route/database id, not the hostile key or value. No Redis credential or arbitrary Redis endpoint input was exposed in the reviewed frontend code. Raw data navigation uses session memory.
- **CSRF and permission boundaries:** observed authenticated change requests carried `X-CSRF-Token`. Independent viewer requests to sandbox writes, audit, and users returned **403** despite bypassing UI hiding. A delete without a confirmation token returned **428**; an invalid confirmation was rejected. Cancel/Escape left scratch data unchanged.
- **Bulk actions:** selected-key TTL set to 600 seconds; canceled bulk delete preserved keys; confirmed delete removed them. Selection worked via keyboard Space, and Escape cleared it. The filter membership bug in M3 must be fixed before relying on Select all under active filters.
- **Read-only context:** remote-6390 displayed the hatched edge and read-only labels, with effective viewer role for every global role. Add/edit/delete and write-task controls were absent or disabled. Admin-only diagnostics were refused/hidden. No remote mutation request was sent; server refusal evidence is the code path described above.
- **Auth/admin:** all three SSO role accounts signed in; `nogroup1` was refused with a useful explanation. Local viewer/operator and admin+TOTP sign-ins worked. Local Account displayed the password/authenticator controls; SSO Account explained that these are managed by the provider. Review-user create/role change/disable and audit filter/older-page navigation worked; audit command arguments were redacted.
- **Diagnostics:** sampled memory reports worked on every target and role; pub/sub round trips worked for writers on the three sandboxes, listeners worked for viewers and remote, scratch consumer groups were inspectable, TimeSeries read its scratch sample where the module was available, and clients/profiler were available only in their permitted contexts. A deliberately nonexistent remote stream gave an API error rather than fabricated data. No destructive client kill/reset was performed against shared data.
- **CSP/logs:** no CSP/Trusted Types violation or unexpected browser console/page error was recorded by the browser guards across these tours. Expected API admission/errors were handled as data states. The failures in this report generally occur without a console error, which is why a green CSP/error smoke is insufficient.
- **Keyboard/reduced motion:** landing initial focus, arrows and Enter navigation worked; `/` focused the key pattern; tree selection and formatter arrow navigation worked; dialog Escape worked. Reduced-motion emulation produced **0s** transition and animation durations on the fuse in both themes at both widths. Palette initial focus fails as recorded in M7.

## Design and QA documentation

`docs/DESIGN.md` is a useful, specific brief and explains the implemented compromises. The logical-database count limitation and omitted landing type-mix are documented rather than disguised. Keep those explanations.

`docs/qa/v02-ui-live.md` is a dated record of the author's run, not evidence that later release integrations are correct. Its broad “all fixed”/passed claims did not cover cached-editor identity, inflation after refresh, non-string create collisions, JSON Tree layout, truncation flags, or shortcut-first focus. Append these regressions and rerun them when fixed. Its discussion of server scan truncation and the 400-key workaround should also be updated after the release's scan fix (`1984f93`), so an obsolete workaround is not treated as a current server guarantee.

## Cleanup

Review keys and search indexes were checked across the three writable sandboxes. Any remaining review-prefixed keys were removed through the confirmation-protected API, followed by another scan. See `cleanup.json` for the final zero-leftover check. Test users lived only in the isolated server's data directory. The port-4700 server was stopped and the detached review worktree was removed after evidence collection; final cleanup verification is recorded in `cleanup-final.txt`.
