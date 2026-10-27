# Stable frontend controls

All selectors use `data-testid`. Accessible names are also maintained. Database IDs always come from server configuration.

## Authentication

- `login-sso`: same-origin OIDC start link
- `login-username`, `login-password`, `login-submit`: local login
- `totp-code`, `totp-submit`: second-factor login
- `current-password`, `new-password`, `password-change-submit`: forced or account password change
- `account-about`, `about-notices`: Account's About section and its link to `/THIRD-PARTY-NOTICES.txt` (opens in a new tab)
- `totp-enroll`, `totp-qr`, `totp-enroll-code`, `totp-enroll-confirm`: local enrollment

## Shell

- `database-landing`: explicit picker, including when production was last opened
- `database-switcher`: native select (`sandbox-main`, `sandbox-e2e`, `remote-6390`)
- `nav-overview`, `nav-keys`, `nav-console`, `nav-workbench`, `nav-guided`, `nav-diagnostics`
- `nav-audit`, `nav-users`: visible to global admins only
- `theme-toggle`, `account-link`, `logout`
- `command-palette-open`, `command-palette`, `command-palette-search`

## Universal confirmation (every 428)

- `confirmation-dialog`: native dialog; above any originating modal
- `confirmation-typed`: only for `level=typed`
- `confirmation-reason`: only when `reasonRequired`
- `confirmation-submit`: disabled until required fields match
- `confirmation-target`: database name, environment badge (prod is loud) and effective role
- `confirmation-preview` (scrollable, focusable region), `confirmation-command` (one per listed command), `confirmation-total`, `confirmation-more` ("+N more commands")
- `confirmation-bulk` (pattern/type), `confirmation-impact` (count and sample), `confirmation-note` (optional client context)
- Dialog Close or Escape cancels the promise and sends no retry.

## Session

- `session-ended`: on the sign-in page after any 401 (expiry, sign-out elsewhere, account change), with the reason

## Keys

- `key-pattern`, `key-type-filter`, `key-delimiter`, `key-scan`, `key-load-more`
- `key-scan-changed`: notice (with a Rescan button) when the loaded list is older than the database: keys were written on another page after the scan, or a key added or renamed in the browser may not fit the pattern or type filter (it opens in the inspector but is not inserted into a filtered list)
- `key-list`, `key-row`: virtual rows (`role="tree"` / `role="treeitem"`); select by key name within the list. A row shows the key without its folder path, but its text content (and accessible name) is the full key. When more than 150 keys are listed, folders start collapsed (single-child chains open): use `key-view-list` for a flat list, or click folders open. `key-list` has `data-meta-pending="true"` while metadata for rows on screen is loading.
- v0.2.1 key browser:
  - `key-scan-summary`: "Results N · Scanned X / DBSIZE" (or "exact key lookup"), with `data-done` (`true` once the cursor returned to 0), `data-results`, `data-scanned`, `data-total`.
  - `key-row` has `data-meta="pending|loaded"`; until metadata arrives it shows placeholders (type "type loading", an empty fuse, no size).
  - `key-folder`: folder rows (class `key-folder`, `aria-expanded`, `aria-label` "<folder> N keys, P% of matching keys|loaded matches", `title` with the full pattern and the precise share); cells `.folder-count`, `.folder-share`, `.folder-bytes` (`.partial` while some sizes are missing). Hover actions `folder-filter` (also key F) and `folder-delete` (writers only; also the Delete key) pre-fill the pattern.
  - `key-share-note`: "folder % of matching keys" (complete scan) or "folder % of loaded matches" (partial).
  - `key-view-tree`, `key-view-list` (`aria-pressed`); `key-delimiter` shows in tree view only and keeps its value.
  - Column headers `key-sort-type`, `key-sort-name`, `key-sort-ttl`, `key-sort-size` (`aria-pressed` on the active one; pressing it again reverses); `key-columns` opens the chooser with `key-column-type`, `key-column-ttl`, `key-column-size` (session memory).
  - `key-load-more` ("Scan more" / "Scan complete"), `key-scan-all` ("Scan to end"), `key-scan-stop`, `key-scan-count` ("Keys to scan" select; localStorage `rconsole.keyScanCount`, a number only).
  - `key-last-refresh` (age of the list), `key-refresh`, `key-auto-refresh` (select: 0 = off, else seconds).
  - Delete by pattern runs as a job: `bulk-job` (`data-state` running|done|cancelled|stopped|failed), `bulk-job-deleted`, `bulk-job-stop`; outside the dialog `bulk-job-status` shows a running or finished job.
- `key-detail`: the inspector; its single `h2` text equals the key name
- `inspector-wide`: toggle (`aria-pressed`) that hides the key list so the inspector takes the full width; session memory only, and only while a key is open
- `key-value`, `value-cell-open`, `value-inspector-dialog`, `value-inflate`, `key-explain`, `key-load-full`, `key-next-page` (only rendered when a next page exists or you are past the first page)
- `value-format`: formatter `tablist`; tabs are named `Text`, `JSON`, `Tree`, `Hex`, `Base64`, `MsgPack` (e2e helper `selectFormat(scope, 'hex')` in `tests/e2e/lib/ui.ts`). Structured tabs are disabled on truncated previews. Values detected as serialized PHP or Java also get `PHP` / `Java` tabs (review v0.2.1 web L3): inert structure views, with `value-serialized-note`; MsgPack names uninterpreted extension types in `value-msgpack-ext`.
- Selection: list header checkbox "Select all loaded keys"; the `Selected keys` region replaces the header with Set TTL, `selection-delete` (server confirmation), Copy names and Clear. Viewers get Copy names only.
- `key-add`, `key-editor-dialog`, `key-create-type`, `key-create-name`, `key-create-encoding`, `key-save`
- `key-edit`, `key-edit-field`, `key-edit-value`, `key-edit-score`, `key-edit-encoding`, `key-edit-ttl`
- `key-ttl`, `key-ttl-dialog`, `key-ttl-input`, `key-ttl-submit`
- `key-rename`, `key-rename-dialog`, `key-rename-input`, `key-rename-submit`
- `key-delete`: immediately requests the single server confirmation; no preliminary delete dialog
- `bulk-delete`, `bulk-delete-dialog`, `bulk-delete-pattern`, `bulk-delete-preview` (read-only SCAN sample), `bulk-delete-review` (separate server impact challenge)

## Console / workbench

- `console-editor`, `console-editor-input` (contenteditable CodeMirror), `console-run`
- `workbench-editor`, `workbench-editor-input`, `workbench-run`, `workbench-policy` (command count, class summary or the first blocked line)
- `policy-badge`, `command-docs` (the assist line above the prompt while the command is recognised: signature and summary), `console-results` (contains only result `section`s, run headers and the running block), `console-clear`
- `workbench-line-status` (visually hidden list: every command line's policy and run status, for assistive technology; the CodeMirror gutter is `aria-hidden`), `workbench-cursor-line` (the cursor line's status, part of the editor's accessible description)
- `result-explanation` (quiet note under conventional replies: `(nil)`, TTL -1/-2, `TYPE` none, empty `XINFO GROUPS`)
- Workbench gutter markers (`.console-line-marker`) carry `aria-label`s starting with `pending`, `running`, `success`, `error`, `not run`, `may have run` (the line in flight when a script was cancelled) or `unknown` (cancelled before the server answered)
- Set editor text with locator `.fill()` or keyboard select-all. Commands use Enter, scripts Mod+Enter.
- Argument-role classes (`.console-token-command|subcommand|key|value|number|flag`) also appear in the assist signature and in result command echoes; scope token locators to `console-editor-input`.

## Guided mode

- `guided-find`, `guided-inspect`, `guided-edit`, `guided-ttl`, `guided-stream`, `guided-publish`, `guided-counter`, `guided-set`, `guided-zset`
- `guided-key`, `guided-field`, `guided-value`, `guided-number`, `guided-command`, `guided-run`
- `guided-continue-keys`: after Find, opens the key browser scanning the pattern that ran (handed over in session memory, not the URL)

## Diagnostics

- `diagnostics-slowlog`, `diagnostics-analysis`, `diagnostics-pubsub`, `diagnostics-streams`, `diagnostics-clients`, `diagnostics-profiler`, `diagnostics-search`, `diagnostics-timeseries`
- Restricted admin/module tools have disabled explanatory cards; their routes remain gated.
- `slowlog-reset`, `client-kill`, `analysis-pattern`, `analysis-run`, `analysis-report`
- `pubsub-channel`, `pubsub-pattern`, `pubsub-subscribe`, `pubsub-stop`, `publish-channel`, `publish-message`, `pubsub-publish`
- `stream-key`, `stream-inspect`, `stream-group-name`, `stream-group-create`, `stream-ack-ids`, `stream-ack`
- `profiler-seconds`, `profiler-start`, `profiler-stop`
- `search-index` (a select of `FT._LIST` results; a text input when the role may not list indexes), `search-query`, `search-run`, `search-doc-truncated` (per-document notice when `docs[].truncated`, with an "Open in key browser" button), `timeseries-key`, `timeseries-run`. Search paging (Previous/Next 20) pages the last executed index/query; editing the form does not change it.

## v0.2.1 Insight (search, analysis, rich results, import, tutorials)

- Search tool sub-views (`?panel=` holds only `indexes` or `create`): `search-panel-query`, `search-panel-indexes`, `search-panel-create`.
- Query: `search-index`, `search-mode` (Search / Aggregate), `search-query` (combobox textarea; `@` lists fields, Ctrl+Space
  lists syntax; completions `search-query-completions`), `search-pipeline` (aggregate steps), `search-sort`,
  `search-sort-order`, `search-limit`, `search-dialect`, `search-return` (fieldset of RETURN checkboxes), `search-command`
  (the exact command), `search-run`, `search-explain`, `search-profile`, `search-workbench`, `search-save-name`, `search-save`,
  `search-saved` (session-memory list), `search-recent`, `search-results`, `search-view` (Table / JSON tabs), `search-open-doc`
  (every document; exact id bytes), `search-doc-truncated`, `search-doc-id-withheld`.
- Indexes: `search-new-index`, `search-index-detail`, `search-index-docs`, `search-index-query`, `search-index-drop` (admins),
  `search-drop-dd`.
- Index wizard: `index-wizard`, `wizard-on-hash`, `wizard-on-json`, `wizard-prefix`, `wizard-sample`, `wizard-sampled`,
  `wizard-field-row` (controls labelled `Index <field>`, `Alias of <field>`, `Type of <field>`, `Sortable`…), `wizard-add-name`,
  `wizard-next`, `wizard-back`, `wizard-index-name`, `wizard-command` (exact FT.CREATE), `wizard-problems`, `wizard-create`.
- Key inspector: `make-searchable` (hash and JSON keys, when the database has the search module).
- Analysis: `analysis-pattern`, `analysis-sample`, `analysis-run`, `analysis-progress`, `analysis-cancel`, `analysis-history`,
  `analysis-report-select`, `analysis-compare`, `analysis-comparison`, `analysis-report`, `analysis-coverage`,
  `analysis-recommendations`, `analysis-recommendation` (`data-rule` = rule id, `data-severity`), `analysis-make-searchable`.
- Console / workbench results: `result-rich-toggle` (per result: Table|Chart|Plan|Profile vs Reply/Tree), `result-rich`
  (`data-kind` = search | aggregate | series | multiSeries | explain | profile | geo), `rich-table`, `plan-tree`.
- Geo map (v0.4, `data-kind="geo"`): `geo-map`, `geo-count`, `geo-fit`, `geo-world`, `geo-land` (the bundled outline),
  `geo-point` (focusable, `aria-pressed` when selected), `geo-table`, `geo-row`.
- Guided mode tabs (`?tab=` holds only `tutorials` or `import`): `guided-tab-tasks`, `guided-tab-tutorials`, `guided-tab-import`;
  `workbench-tutorials` (workbench link).
- Tutorials: `tutorial-<id>` (search, json, streams, timeseries, spring-cache, node-cache), `tutorial`, `tutorial-step`,
  `tutorial-script`, `tutorial-insert` (appends to the workbench draft and opens the workbench).
- Import: `import-panel`, `import-file`, `import-text`, `import-check`, `import-plan`, `import-stop-on-error`,
  `import-skip-blocked`, `import-start`, `import-status` (`data-state`), `import-counts`, `import-cancel`.

## Admin

- `audit-user-filter`, `audit-database-filter`, `audit-action-filter`, `audit-outcome-filter`, `audit-filter`, `audit-next`
- `user-add`, `user-edit`, `user-editor-dialog`, `user-username`, `user-display-name`, `user-role`, `user-password`, `user-disabled`, `user-reset-totp`, `user-save`

## Safety

No tests may write to `remote-6390`. It is production/read-only with effective viewer permissions. Use `sandbox-e2e` for test writes, and namespace test keys to avoid collisions. No browser values or command history are persisted. Preferences persist only `rconsole.theme`, `rconsole.database` (ID only) and `rconsole.preferences` (enumerated presentation settings, see below; never Redis data or server policy).

No tests may write to `remote-6390`. It is production/read-only with effective viewer permissions. Use `sandbox-e2e` for test writes, and namespace test keys to avoid collisions. No browser values or command history are persisted. Preferences persist only `rconsole.theme`, `rconsole.database` (ID only) and `rconsole.keyScanCount` (a number).

## v0.2 Console keyboard interface

- `console-prompt` (Console dock and Workbench pane head): database id, environment badge, effective role, `read-only`; `data-environment`, `data-readonly`
- `console-docs-open` (Docs key hint), `command-docs-dialog` (F1 / Mod+/; its content is `command-docs-full` with grammar, complexity, group and the policy here), `command-signature` (grammar with `mark[aria-current]` on the argument at the cursor)
- `history-search`: combobox `Search command history`, listbox of matches (newest first, matched text in `mark`), status `N of M matches`
- `shortcut-help`: registry-generated groups, the current view's first (`this view`), and a `Key labels` macOS / Windows-Linux toggle
- `console-running` (the running block in the transcript: command, elapsed time, Cancel), `console-cancel` (Console dock key hint `clear line` / `cancel request`; Workbench foot button while running), `console-announcement` (visually hidden polite live status; the idle assist line shows it too)
- `console-result`: focusable `section`, `data-status=success|error|cancelled`; actions with accessible names Collapse/Expand, Copy result, Copy JSON, Copy as code, Re-run (rechecks policy and confirmation); key links `Open key <name>`; SCAN `Continue scan`; WRONGTYPE `Check its type`; long replies `Show all …`. Workbench results carry `line N` and sit under a `.run-header` per run (newest run first).
- `command-suggestions`, `keys-guidance` (its button puts the bounded SCAN on the prompt)
- `console-clear` clears only results; separate Clear history control removes history.
- Key hints (`.key-hint`) are the visible controls for shortcuts; history arrows are named `Previous command in history` / `Next command in history`; result navigation `Previous result` / `Next result`; `Copy last result`.
- Workbench policy gutter: `.console-policy-gutter`; markers `.console-line-marker.tone-{read|write|admin|danger|blocked}` before a run and `.status-{pending|running|success|error|not-run|cancelled}`; policy/status/reason in `aria-label` and `title`.

- `reply-view-terminal`, `reply-view-tree`: visible view toggle buttons, with `aria-pressed` indicating the selected result view.

## Round 2 edit safety and context

- Existing string editor: accessible checkbox `Keep current expiry (SET KEEPTTL)` starts checked; `key-edit-ttl` is disabled until unchecked. No selector IDs changed.
- Values containing CR / CRLF open in Base64 mode; existing encoding/value selectors remain stable.
- List edit panels close with a visible `role=status` notice when their indexed value changes on refresh.
- Collection cells show raw numeric text plus a secondary `Timestamp hint`.
- Document titles include the static view and configured database name/environment; Redis data is excluded.
- Bulk TTL/delete counts and disabled TTL batch limits are visible status text.

## Round 3 compare-and-set edits

- `edit-conflict` (`role=alert`): "This value changed since you opened it." (key-level: "This key changed since you read it."), shown instead of saving when the server answers 409 or a refresh shows the editor's snapshot is out of date. Inside: `edit-conflict-current` (the value now, escaped text), `edit-conflict-diff` (line diff, only for short UTF-8 values), `edit-conflict-reload`, `edit-conflict-overwrite` (labelled "Overwrite anyway", "Delete anyway" or "Rename anyway"; absent when the type changed or the value cannot be compared). It appears in the inline row editor, the key editor dialog, the inspector header (delete) and the rename dialog. While it shows, `key-save` / the row's Save are disabled.
- Inline hash, list and score editors close with a `role=status` notice ("This field changed…", "This list changed…", "This member's score changed…") when a read shows other bytes for their element.
- Value inspector (`value-inspector-dialog`) of a truncated element: a "Truncated preview" notice, structured tabs disabled, and the copy button is named `Copy preview`. Formatter views end capped output with "… N more characters/bytes not shown"; `Copy value` copies the whole representation.
- Key editor JSON path picker: options for paths through property names with line breaks are disabled and labelled "(not addressable here)"; option labels escape control characters.

## Final web review byte fidelity

- Console transcript commands and invisible/binary key names use redis-cli-compatible `\xHH` quoting.
  `Copy result`, inspector `Copy CLI`, history selection and `Re-run` retain executable byte fidelity.
- Text `Copy value` copies exact complete UTF-8 characters; display controls remain escaped. Base64/Hex
  are explicit binary representations. `Copy preview` remains labelled for incomplete/oversize values.
- A missing key shows only the missing-key notice, with no stale value or mutation buttons. An expiry race
  reports the missing key through the form or the refreshed inspector rather than claiming success.
- Binary Text offers `Copy as redis-cli` and shows the same quoted byte argument. The regression also checks
  this copy by native paste into Console and a SET/readback, before checking the Base64 copy separately.

## v0.2.1 shell (drawer, status, landing, tools, preferences)

- Tools drawer (every database page): `tools-drawer` (`data-open="true|false"`), tabs `drawer-tab-console`, `drawer-tab-helper`, `drawer-tab-profiler` (only where `features.profiler`; `role=tab`, `aria-selected`), `drawer-toggle` (Tools / Hide, `aria-expanded`; also `Ctrl+\``), `drawer-panel` (`role=tabpanel`), `drawer-resizer` (`role=separator`, `aria-valuenow` px; ArrowUp/ArrowDown ±24, Shift ±96, Home/End), `drawer-pubsub-live` (link back to a running Pub/Sub session, with its message count). `drawer-split` (Side by side, `aria-pressed`; review v0.2.1 web L5): the Console beside the Command helper or Profiler, in `drawer-pane-console` and `drawer-pane-helper` / `drawer-pane-profiler` (each `role=tabpanel`, inside `drawer-panel`; on the Console page only the second tool). Off by default; remembered as the `drawerSplit` preference.
- Docked Console (same in-memory draft, history and results as the Console page): `drawer-console-editor`, `drawer-console-editor-input`, `drawer-console-run`, `drawer-console-results`, `drawer-console-meta`. On the Console page the drawer shows a note instead of a second editor.
- Command helper: `command-helper`, `command-helper-search`, `command-helper-group`, `command-helper-policy` (`all|allowed|not-allowed`), `command-helper-count`, `command-helper-item` (`role=option`), `command-helper-detail`, `command-helper-insert` (puts the command on the Console prompt; disabled when not allowed).
- Profiler (Diagnostics page / drawer prefix `drawer-`): `profiler-seconds`, `profiler-start`, `profiler-stop`, `profiler-pause` (view only; recording continues), `profiler-clear`, `profiler-count`, `profiler-download` (Download shown commands: the same lines as Copy, saved locally as `redis-profiler.log`); Copy button named `Copy shown commands`. The session belongs to the database layout and keeps recording across that database's pages.
- Header and status bar: `db-index` (header badge `db N`), `status-keys` (`db N` + keys of the configured logical database), `status-metrics` (server-wide: `status-cpu`, `status-ops`, `status-memory`, `status-clients`), `status-freshness` (`live`, `N s ago`, `stale · …`, `reading…` or `unavailable`).
- Landing: `landing-sort-name|keys|memory|ops|hitRate|clients|uptime` (header buttons; `th[aria-sort]`; third click restores last-used order), `landing-keys`, `landing-db-index`, `db-tag` (config display tags), `db-capability` (modules / allowed tools; hidden below 1280 px).
- Pub/Sub: `pubsub-add-channel`, `pubsub-add-pattern`, `pubsub-topics` (chips; up to 10), `pubsub-status`, `pubsub-count`, `pubsub-format` (`text|json|msgpack|hex`), `pubsub-freeze` (`aria-pressed`), `pubsub-frozen`, `pubsub-clear`; Copy button named `Copy shown messages`. The session continues while you use the database's other pages.
- Slow log: `slowlog-meta`, `slowlog-freshness`, `slowlog-count` (10–1000), `slowlog-refresh` (manual, 5–60 s), `slowlog-config` (admins: real `slowlog-log-slower-than` / `slowlog-max-len`) or `slowlog-config-unavailable` (reason).
- Preferences (`/preferences`, `nav-preferences`): `preferences`, `pref-timeZone`, `pref-hourCycle`, `pref-dateStyle`, `pref-valueFormat`, `pref-toolRefreshSeconds`, `pref-editorFontSize`, `pref-clearWorkbenchAfterRun`, `pref-drawerOpen`, `pref-drawerSplit`, `pref-server-policy` (server limits vs the user's own Keys to scan), `pref-time-sample`, `pref-reset`.

## v0.2.1 DETAIL parity

- `collection-lookup`: form bound to the current key; `Collection lookup mode` select (MATCH / Exact / List index /
  Score range / Entry ID-range), `Collection lookup`, `Lookup encoding`, `List index`, `Minimum score`,
  `Maximum score`, `Start entry ID`, `End entry ID`; Apply/Reset lookup reset paging. `collection-filter-count`
  labels page matches, exact total matches only when known, and the whole-collection total separately.
- `Collection value format` applies safe formatters in place; each cell has `Expand value`. `Field column width`,
  `Index column width`, etc. are keyboard-operable range controls. Format and width choices survive paging in
  session memory. Float32/64 LE/BE tabs show byte order, dimensions and alignment errors.
- Hash rows have a `Field TTL` column, batched by the server. `Field TTL for <field>` opens Seconds / Set field TTL /
  Remove field expiry; unsupported servers have a disabled action naming the reason.
- `element-load-full` in `value-inspector-dialog`: fetch full collection bytes under the server cap, retaining
  preview state on refusal; full hash/list/score values offer `Edit full element` with CAS. `value-download`
  saves exact raw bytes as `redis-value.bin`, disabled for previews and values over the 4 MiB browser cap.
- `collection-add`, `multi-entry-dialog`: repeatable fields/values/score/encoding, Add another entry, Review entries,
  Apply entries. `multi-entry-summary` counts completed and uncompleted commands. A conflict stops later entries;
  `edit-conflict-overwrite` explicitly overwrites that one state and continues.
- `stream-inspector`: disclosure for groups, consumers and pending. `Inspector consumer group`, `Pending for consumer N`,
  `Pending start ID`, `Pending end ID`, Find pending IDs / Next pending page / All consumers. Selection checkboxes are
  `Select pending <id>`. `Claim target consumer`, `Claim minimum idle milliseconds`, Claim selected (confirm) and
  Acknowledge selected (confirm) are writer-only, both using server confirmation.
  Writer-only lifecycle (review v0.2.1 web L2): `stream-consumer-delete` per consumer row (`Delete… (N pending)`,
  XGROUP DELCONSUMER by bytes, server confirmation whose note names the pending count), `stream-group-destroy` (selected
  group, confirmed), and the create form `stream-new-group-name`, `stream-new-group-start` (`$` | `0` | `id`),
  `stream-new-group-id`, `stream-new-group-mkstream`, `stream-new-group-create`, `stream-new-group-command` (the exact
  XGROUP CREATE). Results land in `stream-lifecycle-outcome`.
- Vector-set inspector (v0.4): `vset-detail`, `vset-summary`, `vset-tabs`; members: `vset-prefix`, `vset-prefix-apply`,
  `vset-prefix-clear`, `vset-show-attributes`, `vset-members`, `vset-member-open`, `vset-attr-cell`, `vset-remove`
  (operator+), `vset-first-page`, `vset-prev-page`, `vset-next-page`, `vset-page-note`; similarity search:
  `vset-search-form`, `vset-search-by-member`, `vset-search-by-vector`, `vset-search-member` (`vset-search-member-empty` when the chosen member is the empty name), `vset-search-vector`,
  `vset-search-count`, `vset-search-ef`, `vset-search-filter`, `vset-search-filter-ef`, `vset-search-attributes`,
  `vset-search-command`, `vset-search-submit`, `vset-search-results`, `vset-result-open`; member panel
  `vset-element-dialog`: `vset-element-name`, `vset-find-similar`, `vset-element-remove` (operator+), `vset-attributes`,
  `vset-attr-edit` (operator+), `vset-embedding`, `vset-links`.

## v0.4 arrays

- `array-detail`: the array inspector inside `key-detail` (Redis 8.8+ arrays, `TYPE` = `array`; type glyph `arr`).
  `key-edit` is not rendered for arrays: their edits live here. `array-summary` holds `array-count` (ARCOUNT),
  `array-length` (ARLEN: highest index + 1, grouped digits) and `array-next-insert` (ARNEXT, the insert cursor).
- Paging toolbar (`role=toolbar`, "Array pages"): `array-first`, `array-last` (from the highest index down),
  `array-prev` (back through the pages visited), `array-next` (disabled when the range is exhausted),
  `array-jump-input` + `array-jump` (any index 0…18446744073709551614; bad input shows an alert and sends nothing),
  `array-page-size` (25 / 100 / 500 / 1000). `array-page-note` names the indices shown and where the next page starts.
- `array-table` with `array-row` per existing element (first cell: the exact index in `code`; value cells are the
  collection cell `value-cell-open` with `Expand value`) and `array-gap` rows between non-adjacent indices
  ("⋯ N empty positions: a–b"). `array-empty-page` when a page holds no element.
- Writer-only row actions: `array-row-edit` ("Edit index N", inline editor labelled "Value at index N", compare-and-set
  with the usual `edit-conflict`; hidden for truncated previews) and `array-row-delete` ("Delete index N", server
  confirmation with ARDEL). The value inspector offers `Edit full element` for array elements after
  `element-load-full`.
- `array-search` (disclosure "Search values"; matched on the server with ARGREP's meanings): `array-search-start`, `array-search-end`, one
  `array-search-kind` (Equals (EXACT) / Contains (MATCH) / Glob pattern (GLOB); no RE) and `array-search-value` per
  condition, `array-search-add` (up to 8), `array-search-combine` (or / and), `array-search-nocase`,
  `array-search-submit`. Results: `array-search-results`, `array-search-summary` (matches, searched indices,
  elements searched, where the rest starts), `array-search-skipped` (indices of values larger than one search reads),
  `array-search-match` rows (the index button opens the page at it), `array-search-continue`.
- `array-aggregate` (disclosure "Aggregate a range (AROP)"): `array-aggregate-start`, `array-aggregate-end`,
  `array-aggregate-op`, `array-aggregate-value` (MATCH only), `array-aggregate-submit`, `array-aggregate-result`.
- Writer-only forms: `array-append` (ARINSERT at the cursor; `array-append-values` one value per line,
  `array-append-submit`; the server's refusal when the cursor points at existing elements shows as an alert),
  `array-set` (`array-set-index`, defaulting to the length until edited; `array-set-value`, `array-set-submit`;
  conflicts use `edit-conflict`), `array-delete-range` (`array-delete-range-start`, `array-delete-range-end`,
  `array-delete-range-submit`; the confirmation's `confirmation-note` carries the counted elements).
- Create form: `key-create-type` has `array`; `key-edit-value` takes the initial values one per line. Creating an
  existing key shows "This key already exists" and writes nothing.
- Landing `db-capability` shows "Arrays" for servers reporting Redis 8.8 or later.

## v0.4 graph results

- `result-rich[data-kind="graph"]`: verbose FalkorDB result table, SVG diagram and statistics.
- `graph-view`, `graph-count`: bounded diagram and received/omitted entity counts.
- `graph-node`: SVG node button (`aria-pressed`). The diagram is one tab stop (roving `tabindex`: the focused/selected node is 0, the others -1); arrow keys, Home and End move between nodes, Enter/Space selects its details.
- `graph-edge`: directed SVG edge (text title includes ID, relationship type and endpoints).
- `graph-selection`: selected node labels, ID and text properties (or endpoint-placeholder explanation).
- `graph-edges`, `graph-edge-item`: relationships of the selected node (type, other endpoint, direction); each item is a button (`aria-pressed`) that opens `graph-edge-detail`, the edge's ID, endpoints and properties as text.
- `graph-statistics`: execution statistics as inert text.
- `result-rich[data-kind="graphPlan"]` with existing `plan-tree`: GRAPH.EXPLAIN/PROFILE indentation plan.
- Existing `rich-table` contains the table labelled `Graph result table`; terminal/raw toggles use existing IDs.
