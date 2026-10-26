# v0.2 Console and Workbench qualification

Worktree `../redis-console-wt/v02-console`, branch `feat/v02-console`. QA date: 2026-10-23. No push. The GPT console agent built the keymap, registry, key-spec argument roles, result blocks, cancellation and reply views; the Claude console agent audited them against the brief, reshaped the Console after using it on snapshot, and ran the live matrix below.

## What changed after using it on real data

Using the Console as a developer on snapshot (several thousand JSON cache values) showed these problems, each now fixed:

| Saw | Changed |
|---|---|
| The prompt sat at the top and the transcript below it scrolled inside a scrolling page, so the newest result was below the fold after a 20-key SCAN | Terminal shape: the transcript fills the view and scrolls; the prompt is docked under the newest result, as in redis-cli, DevTools and VS Code terminals. Workbench keeps the editor on top with the newest run directly under it. |
| SCAN printed the keys, then repeated all 20 as "Open key" buttons | SCAN keys are rendered once, in key anatomy, and each is the key-browser link. *Continue scan* puts the next `SCAN <cursor> …` on the prompt (never runs it). |
| Every result block carried a row of five text buttons | One header line: status glyph, command (role-highlighted), time, Redis duration, size, class, then quiet Copy / JSON / Code / Re-run actions. Collapsed blocks keep a one-line summary. |
| `INFO keyspace` printed as `"# Keyspace\r\ndb0:…"` | INFO, CLIENT LIST/INFO, CLUSTER INFO/NODES, MEMORY/LATENCY DOCTOR and LOLWUT print raw, like redis-cli. |
| HGETALL on a metadata key failed with WRONGTYPE and no next step | WRONGTYPE results offer *Check its type* (puts `TYPE <key>` on the prompt). |
| Large cached JSON payloads became 100 wrapped lines | Transcript folds replies over 6,000 characters (or 40 lines); the tree view shows a JSON string as a JSON tree. |
| `XREAD STREAMS a b 0-0 1-0` highlighted the IDs as keys and linked them | Redis 8.10 marks XREAD's key spec *incomplete*, so the server omits it. The grammar fallback now splits parallel lists evenly. |
| Key completion only knew keys seen in the key browser | Keys returned by Console SCANs also complete (session memory only). |
| Did-you-mean appeared while still typing `HGETA` | Only once the command word is finished or no command starts with it. |
| `KEYS user:*` → "Use SCAN" replaced the pattern with `*` | The suggestion keeps the pattern: `SCAN 0 MATCH user:* COUNT 100`. |
| Esc and Ctrl+C in the Workbench cleared the whole script | They never clear a script; Esc only dismisses, an idle Ctrl+C falls through. |
| Ctrl+C on Windows/Linux would clear the line instead of copying selected text | With a selection, Ctrl+C copies (Windows Terminal / VS Code convention); otherwise it cancels or clears. |
| Numbers were red (red means danger here) and keys were always green (green means *string*) | Numbers use the warning hue; keys take the type hue of their command's group (HGETALL violet, ZADD magenta, XADD teal, GET green, DEL/EXPIRE neutral ink), per DESIGN's "one hue per type, used everywhere". |
| Destructive gutter marker drew as a solid red block | The marker's tone class collided with the global `.danger` button style; tone classes are now `tone-*`. |
| A binary key in sandbox-e2e (`rcsrv:bin:…:\xff\x00\xfe\n`) made every binary key link read "binary key" (found when the live SCAN case happened to open it) | Key links carry the escaped bytes, as the inspector heading does. |
| The `?` overlay was one long column with ragged key columns | Two columns of context groups, this view's contexts first, key caps per key, and a macOS / Windows-Linux label toggle. |

Found outside the console's ownership, flagged for the UI branch rather than changed here:

- The key browser's virtualised `.tree-row` rule in `styles/keys.css` also matches the shared `JsonTree` rows from `components/ui.tsx`, so the key inspector's **Tree** formatter stacks every JSON row at the same position (verified on a large JSON cache value: all rows `position: absolute` at one offset). The Console keeps its own JSON rows in flow locally.
- `apps/web/qa/contract.browser.spec.ts` (`pnpm --filter @rconsole/web test:browser:contract`, last changed in v0.1) fails 2 of 6 before reaching its console steps, on `Understand this key` and `diagnostics-slowlog`, which the v0.2 key browser and Diagnostics no longer render. It also expects the console's command docs to show the complexity, which the assist line keeps (`O(1)`).

## Benchmarks

Public primary documentation and source, read 2026-10-23:

| Benchmark | Evidence | Adapted behaviour |
|---|---|---|
| redis-cli | [Redis CLI](https://redis.io/docs/latest/develop/tools/cli/) | History, reverse search, completion and hints; target in the prompt (`host:port>` → `db-id env role ›`); raw INFO output. |
| iredis | [README](https://github.com/laixintao/iredis) | Argument-role colouring and inline command documentation. |
| Chrome DevTools | [Keyboard shortcuts](https://developer.chrome.com/docs/devtools/shortcuts) | Enter runs, Shift+Enter continues, ↑/↓ history at the edges, Ctrl+L clears, input docked under the output. |
| VS Code | [Terminal shell integration](https://code.visualstudio.com/docs/terminal/shell-integration) | Move between command blocks, command status in a gutter, Ctrl+C copies a selection. |
| Warp | [Block basics](https://docs.warp.dev/terminal/blocks/block-basics) | Command/output blocks with copy, collapse and per-block navigation. |
| psql | [Manual](https://www.postgresql.org/docs/current/app-psql.html) | Database-aware prompt. History deliberately stays in memory. |
| DataGrip | [Running queries](https://lp.jetbrains.com/datagrip/running-queries/) | Run selection or current line vs whole script; unsafe-statement cues before running. |
| TablePlus | [Editor basics](https://tableplus.com/docs/query-editor/editor-basics) | Current-line execution, cancel, foldable results. |
| Redis Insight Workbench | [Docs](https://redis.io/docs/latest/develop/tools/insight/), [release notes](https://redis.io/docs/latest/develop/tools/insight/release-notes/v2.0/) | Multi-command scripts with per-command results grouped per run. UX only; no security equivalence implied. |

## Shortcut catalogue

One catalogue (`apps/web/src/lib/keyboard/registry.ts`) drives dispatch, the kbd hints on screen and the `?` overlay. `Ctrl` is the literal Control key on every platform (terminal chords); `⌘` / `Ctrl` is the platform modifier.

| Context | Action | macOS | Windows / Linux | Visible control |
|---|---|---|---|---|
| Global | Command palette | ⌘K | Ctrl+K | Jump to… |
| Global | Keyboard shortcuts (outside text fields) | ? | ? | rail Shortcuts, palette entry |
| Global | Open the key browser | Option+1 | Alt+1 | rail, palette hint |
| Global | Open the Console | Option+2 | Alt+2 | rail, palette hint |
| Console prompt | Run (accepts the highlighted completion first, but only when that changes the command) | Enter | Enter | Run |
| Console prompt | Continue the command on a new line | Shift+Enter | Shift+Enter | `newline` hint |
| Console prompt | Previous / next command (first / last line only) | ↑ / ↓ | ↑ / ↓ | `history` hints |
| Console prompt | Search history; again for older | Ctrl+R | Ctrl+R | `search` hint |
| Editors | Show completions: commands; known keys at a key argument (also an empty one); the command's unused options elsewhere | Ctrl+Space | Ctrl+Space | `complete` hint |
| Editors | Accept completion or grey suggestion | Tab / → | Tab / → | `accept` hint; ghost shows a Tab cap |
| Editors | Dismiss; Console then clears the line | Esc | Esc | `dismiss / clear` hint |
| Editors | Documentation for the command at the cursor | F1 / ⌘/ | F1 / Ctrl+/ | Docs |
| Workbench editor | Run the whole script | ⌘Enter | Ctrl+Enter | Run script |
| Workbench editor | Run the selection or current line | Shift+Enter | Shift+Enter | Run line / selection |
| Console and Workbench | Clear the screen (history kept) | Ctrl+L | Ctrl+L | Clear screen |
| Console and Workbench | Cancel a running request (Workbench: the server stops before the next line and reports what ran); Console: clear line; Win/Linux with selection: copy | Ctrl+C | Ctrl+C | `clear line` / `cancel request`, Cancel in the running block |
| Console and Workbench | Previous / next result (past the newest: back to the editor) | Option+↑ / Option+↓ | Alt+↑ / Alt+↓ | `previous` / `next` |
| Console and Workbench | Copy the last result | ⌘⇧C | Ctrl+Shift+C | `copy last` |
| Result block | Reach collapse, copy, re-run, key links | Tab | Tab | the actions themselves |
| Result block | Move between the keys of a SCAN reply (one Tab stop) | ↑ / ↓, Home / End | same | the key links |
| Result block | Back to the editor (from the block or any action in it) | Esc | Esc | — |
| History search | Use the match (does not run it) / choose newer, older / close | Enter / ↑↓ / Esc | Enter / ↑↓ / Esc | `use`, `older`, `close` |
| Key browser | Move / open-close namespace / inspect / select / pattern | ↑↓ / →← / Enter / Space / `/` | same | page controls (UI branch) |
| Databases | Choose / open / open by position | ↑↓ / Enter / 1–9 | same | rows (UI branch) |
| Dialogs | Close or cancel | Esc | Esc | Close |

No dispatched chord is shared within a context set on either platform (unit-tested). Global shortcuts never fire in inputs, selects, textareas or contenteditables; page shortcuts fire only inside CodeMirror editors of their own page; dialog content cannot trigger page shortcuts behind it.

## Visual cues

- **Prompt**: `db-id [env] role [read-only] ›` left of the caret; a 3 px environment edge (5 px on production) in the environment hue; the caret turns red for destructive or production writes. The editor's accessible description is the prompt plus the policy.
- **Argument roles**: command and subcommand in the signal colour, option tokens in bold graphite, keys underlined in their command's type hue, values in ink, numbers in the warning hue; a wavy red underline for a finished unknown command or a non-numeric number argument; comments italic graphite.
- **Assist line** above the prompt (one thing at a time): did-you-mean, KEYS→SCAN, multi-line note with *Open in Workbench*, or the redis.io-style signature with the argument at the cursor marked, plus the summary; idle, the last status.
- **Ghost suggestion** from history in graphite with a Tab key cap.
- **Policy badge** under the prompt: Ready / read / write / admin, `· destructive`, `· blocked` or `· needs confirmation`, and the reason.
- **Danger state** before running: red strip naming what follows (confirmation, or typing the database name for FLUSHDB; on production every change needs a reason), red caret, red `Run…` (the ellipsis means a dialog follows). Not shown when the command is blocked anyway.
- **Running**: a block at the newest edge with the command, `Running… 1.3 s` and its own Cancel; the dock hint becomes `cancel request`.
- **Results**: 3 px status gutter plus ✓ / ! / ■ glyph (not colour alone), time, Redis duration (round trip in the tooltip), size, class; key names as key anatomy links; a quiet explanation under conventional replies (`(nil)`, TTL -1/-2, `TYPE` none, empty `XINFO GROUPS`); Workbench `line N` and a run header (`Run at … · 4 commands · all succeeded / 1 error · 2 not run / cancelled · 1 finished · line 2 may have run · 2 not run`).
- **Workbench gutter**: ● read (graphite), ● write/admin (warning), ▲ destructive and × blocked (danger) before a run; ✓ / ! / … / – / ■ after it, and ? for a line that may have run (in flight when the script was cancelled, or unknown when the server could not be told); full policy in the tooltip. The gutter is `aria-hidden` (CodeMirror), so the same text is the editor's description for the cursor line and a visually hidden list of every line (review round 1, M4).
- **Empty state**: a plain explanation of where commands run and what is safe, examples that fill the prompt (PING, DBSIZE, SCAN, INFO keyspace; a `SCAN 0 MATCH <namespace>:*`, TYPE and TTL for the last inspected key), and the memory-only note.
- **Announcements**: one polite live region for results (`Completed in 0.42 ms: (integer) <n>`), errors, cancellation, copy and clearing.
- **Arrival**: opening the Console or Workbench with nothing focused (Option+2 from another view, the palette, a page load) puts the caret in the editor; a rail link that was used keeps its focus, so Option+1/2 keep working from there.
- **Narrow screens** (below 1280 px): the toolbar keeps its labels; the dock keeps `search` and `clear line` / `cancel request`, and the other hints are key caps with tooltips and accessible names.
- **While a view loads**: only the view shows "Opening view…"; the rail and top bar stay usable.

## Live matrix

Real Chromium against the production bundle on the real Fastify server at :4300 (`config/rconsole.dev.json`), exact CSP and Trusted Types headers, QA local accounts. Every case runs under the guarded harness: any CSP or Trusted Types violation, console error, unexpected dialog or secret in a response fails it. Keyboard flows use key presses, not clicks. remote-6390 cases also fail if anything but an audited read (`PING GET DBSIZE SCAN TYPE TTL INFO`) is sent to it.

Final run: 2026-10-23 after console review round 1 (`feat/v02-consolefix`, build of `3d96727`), `RC_CONSOLE_LIVE=1 pnpm exec playwright test -c console-live.config.ts`, 2.0 min, one worker. Cases 1–42 are the original matrix, unchanged except that the Tab helper now waits for its target to be visible (case 41 failed for the reviewer on that race, see `docs/REVIEW-LOG.md`, round 1 – console, L2); cases 43–49 were added for the round's findings.

| # | Case | Role | Database | Result |
|---|---|---|---|---|
| 1 | all read shortcuts, policy cues and memory isolation | viewer | snapshot | pass (2.8 s) |
| 2 | SCAN key links, continue scan and key browser | viewer | snapshot | pass (1.0 s) |
| 3 | Workbench line, selection, all, policy and error gutter | viewer | snapshot | pass (2.9 s) |
| 4 | all read shortcuts, policy cues and memory isolation | viewer | sandbox-main | pass (2.7 s) |
| 5 | SCAN key links, continue scan and key browser | viewer | sandbox-main | pass (1.0 s) |
| 6 | Workbench line, selection, all, policy and error gutter | viewer | sandbox-main | pass (2.9 s) |
| 7 | all read shortcuts, policy cues and memory isolation | viewer | sandbox-e2e | pass (2.7 s) |
| 8 | SCAN key links, continue scan and key browser | viewer | sandbox-e2e | pass (0.9 s) |
| 9 | Workbench line, selection, all, policy and error gutter | viewer | sandbox-e2e | pass (2.9 s) |
| 10 | all read shortcuts, policy cues and memory isolation | viewer | remote-6390 | pass (2.7 s) |
| 11 | SCAN key links, continue scan and key browser | viewer | remote-6390 | pass (2.2 s) |
| 12 | Workbench line, selection, all, policy and error gutter | viewer | remote-6390 | pass (2.9 s) |
| 13 | all read shortcuts, policy cues and memory isolation | operator | snapshot | pass (2.8 s) |
| 14 | SCAN key links, continue scan and key browser | operator | snapshot | pass (1.0 s) |
| 15 | Workbench line, selection, all, policy and error gutter | operator | snapshot | pass (2.9 s) |
| 16 | all read shortcuts, policy cues and memory isolation | operator | sandbox-main | pass (2.7 s) |
| 17 | SCAN key links, continue scan and key browser | operator | sandbox-main | pass (1.0 s) |
| 18 | Workbench line, selection, all, policy and error gutter | operator | sandbox-main | pass (2.9 s) |
| 19 | all read shortcuts, policy cues and memory isolation | operator | sandbox-e2e | pass (2.7 s) |
| 20 | SCAN key links, continue scan and key browser | operator | sandbox-e2e | pass (0.9 s) |
| 21 | Workbench line, selection, all, policy and error gutter | operator | sandbox-e2e | pass (2.9 s) |
| 22 | all read shortcuts, policy cues and memory isolation | operator | remote-6390 | pass (2.7 s) |
| 23 | SCAN key links, continue scan and key browser | operator | remote-6390 | pass (2.2 s) |
| 24 | Workbench line, selection, all, policy and error gutter | operator | remote-6390 | pass (2.9 s) |
| 25 | all read shortcuts, policy cues and memory isolation | admin | snapshot | pass (2.8 s) |
| 26 | SCAN key links, continue scan and key browser | admin | snapshot | pass (1.0 s) |
| 27 | Workbench line, selection, all, policy and error gutter | admin | snapshot | pass (2.9 s) |
| 28 | all read shortcuts, policy cues and memory isolation | admin | sandbox-main | pass (2.7 s) |
| 29 | SCAN key links, continue scan and key browser | admin | sandbox-main | pass (1.0 s) |
| 30 | Workbench line, selection, all, policy and error gutter | admin | sandbox-main | pass (2.9 s) |
| 31 | all read shortcuts, policy cues and memory isolation | admin | sandbox-e2e | pass (2.8 s) |
| 32 | SCAN key links, continue scan and key browser | admin | sandbox-e2e | pass (1.0 s) |
| 33 | Workbench line, selection, all, policy and error gutter | admin | sandbox-e2e | pass (2.9 s) |
| 34 | all read shortcuts, policy cues and memory isolation | admin | remote-6390 | pass (2.7 s) |
| 35 | SCAN key links, continue scan and key browser | admin | remote-6390 | pass (2.2 s) |
| 36 | Workbench line, selection, all, policy and error gutter | admin | remote-6390 | pass (2.9 s) |
| 37 | keyboard-only DEL confirmation cancellation, acceptance and safe rerun | operator | sandbox-e2e | pass (0.8 s) |
| 38 | Ctrl+C aborts a real blocking fetch and reports cancellation | operator | sandbox-e2e | pass (0.7 s) |
| 39 | safe example, tree view and key-browser result action | viewer | sandbox-e2e | pass (0.8 s) |
| 40 | FLUSHDB typed-name challenge is keyboard-operable and cancelled before execution | admin | sandbox-e2e | pass (0.6 s) |
| 41 | light and dark Console/Workbench at 1024, 1280, 1440 and 1920 | operator | snapshot | pass (16.2 s) |
| 42 | native select-all replacement updates policy and replaces the whole Workbench draft | operator | sandbox-e2e | pass (1.4 s) |
| 43 | Workbench Ctrl+C stops the script before its next line and says which lines ran (H1) | operator | sandbox-e2e | pass (4.1 s) |
| 44 | if the server cannot be told, Workbench cancel closes the request, says it is unknown what ran, and the server still stops (H1) | operator | sandbox-e2e | pass (4.0 s) |
| 45 | empty key argument: signature, Ctrl+Space keys and options; Enter runs a complete command; numeric cues (M2, L1) | operator | sandbox-e2e | pass (1.1 s) |
| 46 | Esc from a result's actions returns to the editor, in the Console and the Workbench (M3) | operator | sandbox-e2e | pass (2.1 s) |
| 47 | a SCAN reply's keys are one Tab stop with arrow-key movement (UX 3) | operator | sandbox-e2e | pass (0.7 s) |
| 48 | Workbench line policy and status are in the accessibility tree (M4) | operator | sandbox-e2e | pass (1.1 s) |
| 49 | the shell stays usable while a view's code loads (L2) | operator | sandbox-e2e | pass (0.5 s) |

49 of 49 cases passed (the pre-review run was 42 of 42; the reviewer's rerun 41 of 42).

What each repeated case covers:

- **All read shortcuts, policy cues and memory isolation**: prompt (database, role, read-only), visible kbd hints for every shortcut, palette from the editor with its hints, `?` typed in the editor stays text, Ctrl+Space / Tab / → completion, argument roles from COMMAND DOCS and key specs (XREAD, ZUNION, MSET) and type hues (stream, zset, hash), invalid number mark, run with status gutter, time, duration and size, live announcement, ghost suggestion (Esc dismisses, → accepts), Esc clears, ↑/↓ history with the draft restored, Ctrl+R (incremental, older, arrows, matched text, Enter fills without running, Esc keeps the draft), Shift+Enter continuation and its note, ↑/↓ inside a multi-line draft, signature with the active argument, F1 and ⌘/ docs with the policy, ⌘⇧C verified by native paste, Option+↑/↓ through results and back to the prompt, Esc from a result, collapse/expand with summary by keyboard, `?` overlay (this view first, Windows/Linux labels), did-you-mean, KEYS → SCAN with the pattern, write and destructive cues (viewers: blocked, no confirmation promise), admin class and subcommand, Ctrl+L keeps history, nothing in local or session storage, reload clears.
- **SCAN key links**: key-anatomy links in the reply, *Continue scan* puts the next cursor on the prompt and runs by Enter, a key link opens the key browser on that key, Option+2 returns with results kept.
- **Workbench**: Esc and idle Ctrl+C keep the script, Shift+Enter runs the current line and the selection, ⌘Enter runs all, line numbers, run header, newest run first, Option+↓ / Option+↑ between editor and results, error gutter and `1 error`, blocked line disables the run and is named, destructive line marker and strip (writers on writable databases).

- **Review round 1 cases** (operator, sandbox-e2e; writes only under `webqa:20261023:console:` with `EX 60`, and the cancelled writes never ran): Workbench Ctrl+C on `PING / BLPOP … 2 / SET … / GET …` sends the cancel, shows `cancelled · 1 finished · line 2 may have run · 2 not run`, and `GET` after the BLPOP timeout is `(nil)`; the same with the cancel request failing (the page closes the request, the run says which lines ran is unknown, the key is still absent); `GET ` / `TYPE ` / `MEMORY USAGE ` mark the key, Ctrl+Space lists the key from a SCAN and SET's options, typing the space opens nothing, `EXPIRE … 1.5` is underlined and `ZADD … +inf` is not, PING typed character by character runs on the first Enter; Esc from Collapse, Copy, Re-run and a key link (Console) and from Collapse (Workbench) returns to the editor; a SCAN reply's keys are one Tab stop with ↑/↓/Home/End; the Workbench line list and the cursor line's description are in the accessibility tree before and after a run with an error; with the Console chunk held back, the shell and theme toggle stay usable and only the view shows "Opening view…".

Isolated suite (`pnpm test:e2e`, own server on :4400 with disposable Redis): see *Test totals*.

Screenshots from the visual case (snapshot, operator; nothing in them was run except reads) were reviewed but are not published: they show the private development dataset.

Manual sessions in the same browser before the automated run (operator on snapshot, viewer on remote-6390 in dark theme at 1024 px): the cases in *What changed* above, the 20-key and MATCH SCANs, completion from SCAN keys, WRONGTYPE → TYPE, the JSON tree on a JSON cache value, and a viewer `SET` on remote-6390 (blocked before sending; the only request was `DBSIZE`). A `securitypolicyviolation` listener installed in those sessions recorded none; the automated cases assert it on every page.

## Test totals

| Suite | Result |
|---|---|
| `pnpm -r typecheck` | shared, server, web, e2e: clean |
| `pnpm --filter @rconsole/web test` | 202 of 202 (18 files, after the web review merge). Review round 1 added 9: language (empty key argument with real key specs 4, numeric cues by type 3), console (reply explanations, cancelled-run summary) |
| `pnpm --filter @rconsole/web build` | built |
| `pnpm --filter @rconsole/server test` | 627 passed, 16 skipped without the cluster/sentinel topology (5 new: Workbench cancellation and client disconnect, bulk delete disconnect) |
| `pnpm test:e2e` (isolated, :4400, under the lock) | 479 of 479 in 13.3 min (includes 21 isolated console keyboard cases, 7 of them new) |
| Live console matrix (:4300, under the lock) | 49 of 49 (42 original + 7 for review round 1) |

## Reproduce

1. `pnpm --filter @rconsole/web build`
2. Source `.env` without printing it, then `RCONSOLE_CONFIG=$PWD/config/rconsole.dev.json RCONSOLE_PORT=4300 RCONSOLE_PUBLIC_URL=http://localhost:4300 RCONSOLE_DATA_DIR=/tmp/rc-v02-console-data pnpm --filter @rconsole/server start` (absolute config path: filtered scripts run from `apps/server`).
3. `node scripts/qa-accounts.mjs http://localhost:4300` (credentials stay in gitignored `.qa/accounts.json`, mode 600; the owner's `admin` is never used).
4. From `tests/e2e`: `node scripts/console-live-session.ts`, then, under the machine-wide lock, `RC_CONSOLE_LIVE=1 pnpm exec playwright test -c console-live.config.ts`.
5. `pnpm -r typecheck`, `pnpm --filter @rconsole/web test`, `pnpm --filter @rconsole/web build`, and `pnpm test:e2e` under the lock.

## Safety

- Writes in live tests happen only on sandbox-e2e under `webqa:20261023:console:` keys (SET then DEL through the confirmation dialog); the blocking test uses an absent `…:empty:<time>` list. The review round 1 cases add `SET … EX 60` keys under the same prefix (they expire within a minute) and BLPOP on absent `…:empty` lists; the writes after a cancelled line are asserted never to run. FLUSHDB is cancelled at the typed challenge (the test asserts only the challenge request was sent). snapshot, sandbox-main and remote-6390 receive reads only; destructive drafts there are typed, never run.
- No connection to 127.0.0.1:6380; nothing but audited reads to 6390.
- History, results, snippets, drafts and SCAN keys for completion live in the authenticated session's memory store; localStorage and sessionStorage hold only the theme and database id (asserted after each flow), and reload clears everything.
- Redis data is rendered only as React text nodes (spans, `pre`, the shared JSON tree); JSON strings are parsed with `JSON.parse` as data. CodeMirror receives the CSP nonce; its widgets set `textContent` only.

## Limits and known gaps

- Console cancellation aborts the browser request; Redis may still finish the command it already received, and the result says so. Workbench cancellation asks the server to stop before the next line; the line that was running may still finish (shown as "may have run"), earlier lines stay applied, later lines are never sent. If the server cannot be told within 2 s the request is closed instead; the server also stops when its client goes away, and the run says which lines ran is unknown.
- Argument roles follow COMMAND DOCS and complete key specs. Where Redis marks a spec incomplete (XREAD on 8.10) the grammar fallback decides; it is an editing aid, never authorization.
- Qualified in Chromium on macOS. Windows/Linux chords and labels are unit-tested (including Ctrl+C copying a selection), not run on those systems. On Windows/Linux Chrome, Ctrl+Shift+C is also DevTools' inspect shortcut when DevTools is open. Safari, Firefox, mobile and real IME input are not qualified.
- No production database is configured locally. The production prompt marking and the badge's `needs confirmation` for every write are unit-tested, and the server's production confirmation has its own E2E; the red caret and the "every change needs a reason" strip use the same condition but were not seen against a live production database.
- The key browser's and landing's shortcuts are listed in the overlay from the catalogue but dispatched by those pages (UI branch); the overlay cannot detect if they change.
