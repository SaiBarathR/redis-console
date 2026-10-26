# Redis Console v0.2 — independent Console / Workbench / keyboard review

Reviewed 2026-10-23, detached `release/v0.2` at **65c7568**, using a separate production build and Fastify instance at `http://localhost:4900`, with `/tmp/rc-review-c1` as its data directory. No source files were edited and no commits were made.

**Verdict: changes required.** The terminal layout, policy cues and confirmation flow are strong. The main blocker is Workbench cancellation: commands after the currently running command can still change Redis after the UI marks the entire script cancelled. There are also three medium issues in completion, keyboard focus and accessibility, plus two low findings.

## Findings by severity

### 1. High — cancelling Workbench does not stop subsequent commands, but marks every line cancelled

**Locations:** `apps/web/src/pages/Console.tsx:453`, `:624`, `:641`, `:652`; `apps/web/src/components/ConsoleResult.tsx:64`. The integration cause is in `apps/server/src/routes/cli.ts:230`–`:251`: the sequential loop checks budgets and session validity but has no client-disconnect/cancellation check before sending the next command.

**Repro, operator, sandbox-e2e only:**

1. In Workbench enter the following, substituting a new unique suffix:

   ```redis
   BLPOP review:c1:cancel-proof:<suffix>:empty 2
   SET review:c1:cancel-proof:<suffix> after-cancel EX 60
   ```

2. Run with Cmd+Enter. While the first command is blocked, press Ctrl+C after about 200 ms.
3. Observe the cancelled block and both gutter markers becoming `cancelled`.
4. Wait over two seconds. In Console run `GET review:c1:cancel-proof:<suffix>`.

**Observed:** reproduced twice. In the recorded repeat the fetch failed with `net::ERR_ABORTED` at approximately **213 ms**, both lines were labelled cancelled, and the later GET returned **`"after-cancel"`**. The SET was after the blocking command, so it was not the command already submitted to Redis when cancellation happened. The warning only says Redis may complete “a command it already received”, which understates what happens to the remaining script.

**Expected:** stop dispatching further script lines after cancellation. Already submitted commands can have an unknown outcome; unsent commands should be marked not run. The interface must not mark every line cancelled when later writes continue.

**Minimal fix:** propagate cancellation/disconnect to the Workbench execution loop and check it immediately before each Redis send. Distinguish completed, already submitted/unknown and not-run lines in the UI. Until cancellation is implemented end to end, explicitly describe this control as stopping the wait and warn that the *whole script may continue*, rather than marking all its lines cancelled.

**Evidence:** [cancelled script](review-c1/workbench-cancel-confirmed.png), [write observed afterwards](review-c1/write-after-workbench-cancel-confirmed.png), [timings and statuses](review-c1/supplement-evidence.json). Add an end-to-end test that checks the later key remains absent; the current cancellation test at `tests/e2e/specs/ui/console-keyboard.spec.ts:499` checks only `/cli` fetch abortion.

### 2. Medium — an empty key argument loses its signature highlight and cannot offer known-key completion

**Locations:** `apps/web/src/lib/console/language.ts:104`; `apps/web/src/lib/console/keySpecs.ts:25`; `apps/web/src/components/Editor.tsx:339`.

**Repro, viewer/operator, snapshot:** run `SCAN 0 COUNT 20`, then enter **`GET `** with its trailing space and press Ctrl+Space. Compare with **`GET hel`**, then Ctrl+Space.

**Observed:** `GET ` had no active signature argument and no completion popup. `GET hel` highlighted `key` and offered 20 keys from the preceding scan. Reproduced independently on sandbox-e2e too.

**Cause:** complete key specs describe positions of tokens that exist. For the missing next token they produce an empty set. The grammar walker returns at line 104 before recording the required key as `next`, and the completion source therefore sees no key argument.

**Expected:** the empty `GET` key position should highlight `key` and allow Ctrl+Space to list already known keys. No extra Redis scan is needed.

**Minimal fix:** distinguish a missing next argument from an existing token that key specs exclude. Preserve the grammar's next-key argument at end of input while retaining key specs for existing-token roles. Test against real-shaped key specs, rather than only simplified grammar fixtures. Cover `GET `, `TYPE `, `MEMORY USAGE ` and repeated key positions.

**Evidence:** [empty-key completion](review-c1/empty-key-completion.png), [repeat](review-c1/empty-key-completion-stable.png), [DOM observations](review-c1/supplement-evidence.json).

### 3. Medium — Esc stops returning to the editor after Tab reaches a result action

**Location:** `apps/web/src/pages/Console.tsx:1016`–`:1025`.

**Repro:** run `PING`; press Option+Up to focus its result; press Tab to focus Collapse; press Esc. Also applies to result Copy/Re-run/key-link descendants.

**Observed:** focus remains on the Collapse button. Esc works when the result section itself has focus. This makes the advertised “Tab to result actions / Esc back to editor” sequence fail at the point where users actually use those actions. Long SCAN transcripts magnify the problem because tabbing out can involve many key links.

**Expected:** Esc from any ordinary action inside a result block returns to the editor, unless a nested interactive control has already consumed the event.

**Minimal fix:** identify the containing result with `closest('[data-testid="console-result"]')` instead of requiring the event target itself to be the section. Keep the `defaultPrevented` guard. Test Esc from Collapse, Copy, Re-run and a key link, in both Console and Workbench.

**Evidence:** [stable focused action after Esc](review-c1/result-action-escape-stable.png), [focus observation](review-c1/supplement-evidence.json).

### 4. Medium — Workbench gutter policy/status labels are hidden from the accessibility tree

**Locations:** `apps/web/src/components/Editor.tsx:79`–`:84`, `:504`–`:521`.

**Repro:** enter `PING`, `SET review:c1:preview value`, `DEL review:c1:preview`, and `FLUSHALL` on separate Workbench lines. Inspect the marker ancestry and Playwright accessibility snapshot.

**Observed:** every marker has an `aria-label`, but all are children of CodeMirror's `.cm-gutters[aria-hidden="true"]`. Their labels are absent from the accessibility snapshot. The same applies to success/error/not-run/cancelled markers. The aggregate policy text and result announcements are useful, but do not expose each cursor line's policy or every line's execution state.

**Expected:** the per-line information claimed in `v02-console-live.md` should be available to assistive technology, including lines skipped after an error.

**Minimal fix:** expose the current line's policy/status through an accessible description or polite status region outside the hidden gutter, and/or provide an accessible per-line status list. Avoid simply exposing all visual line-number gutters and creating duplicate announcements. Assert accessibility-tree visibility, not just presence of an `aria-label` attribute.

**Evidence:** [visual markers](review-c1/gutter-hidden-accessibility.png), [hidden ancestors and absent accessibility text](review-c1/supplement-evidence.json). This is a verified DOM/accessibility-tree defect; I did not run a VoiceOver session.

### 5. Low — numeric validation cues disagree with Redis for integer and infinite-score arguments

**Locations:** `apps/web/src/lib/console/language.ts:70`, `:203`–`:205`.

**Repro, sandbox-e2e:** `EXPIRE <own-test-key> 1.5` and `ZADD <own-test-zset> +inf member`.

**Observed:** `1.5` is displayed as a valid number, but Redis returns `ERR value is not an integer or out of range`. Conversely, `+inf` gets the invalid-number underline, but Redis successfully inserts it. Both were executed on uniquely named review fixtures with short TTLs.

**Expected:** integer arguments reject fractional syntax; supported double-score infinities are not marked invalid.

**Minimal fix:** validate according to the argument type, with Redis-compatible integer/double syntax, rather than one generic decimal regex. Keep these cues advisory; the server remains authoritative.

**Evidence:** [incorrect infinity cue](review-c1/numeric-inf.png), [token classes and actual Redis replies](review-c1/numeric-evidence.json).

### 6. Low — the claimed 42/42 live matrix did not reproduce; its visual case fails before dark coverage

**Locations:** `tests/e2e/specs/ui/console-keyboard.spec.ts:31`, `:621`–`:624`; `tests/e2e/lib/ui.ts:10`.

**Observed:** the unmodified spec, configured externally for port 4900, finished **41 passed / 1 failed in 1.9 minutes**. The visual case failed at `tabTo(page, "theme-toggle")` with **`Control is not reachable using Tab`**. Running that case alone failed again at the same location. It produced the four light-width captures, then failed before dark-width captures; the failure snapshot shows only **“Opening workspace…”**.

This evidence does **not** establish that the theme button itself is inaccessible. The helper waits for the shell/main, then uses a fixed Tab-attempt count; a view-readiness/focus race is a plausible cause, but not proven here.

**Expected:** a reliable qualification test that reaches both themes at every documented width, or a qualification record that states the failure.

**Minimal fix:** wait for the target view/editor and theme control to be ready before traversing focus; diagnose the failure with the focused element and readiness state, then rerun and update the record. Do not convert this into a direct `.focus()` or click that bypasses the keyboard path being tested.

**Evidence:** [full matrix log](review-c1/live-run.log), [isolated rerun log](review-c1/visual-rerun.log), [failure screenshot](review-c1/live-artifacts/console-keyboard-Console-v-f34d3--at-1024-1280-1440-and-1920/test-failed-1.png). Separate review automation waited for the editor and captured dark Console/Workbench at 1024, 1280, 1440 and 1920 successfully.

## Ranked UX improvements

1. **Put the caret in the editor after keyboard navigation to Console/Workbench.** Opening a terminal-like view should make it ready to type. Existing tests always traverse to the editor, which conceals the navigation cost. Preserve deliberate focus restoration when returning from dialogs/results.
2. **Make completion useful at the first empty argument.** Fix finding 2, then offer applicable option tokens and better quoted-key completion. Keep known-key suggestions in memory and require an explicit action for network discovery.
3. **Reduce the transcript's Tab cost.** A scan with hundreds of keys creates hundreds of stops; JSON trees add more. Provide a clear way to enter/leave a result's actions and a keyboard list-navigation pattern for scan keys. Fix descendant Esc first.
4. **Make exact-command execution feel immediate.** Ordinary character typing of `PING` opens an autocomplete list even when the typed command is complete, so Enter first accepts it. The behaviour is documented, but surprises redis-cli users. Consider running exact unambiguous commands on Enter and reserving Tab/Right for completion, with explicit tests for partial commands.
5. **Explain empty results in domain terms.** `(nil)`, TTL `-1`/`-2` and an empty `XINFO GROUPS` are recognisable to Redis users but opaque to newcomers. Add quiet explanations such as “key absent”, “no expiry” and “no consumer groups”, preserving the raw reply and copy action.
6. **Improve narrow-screen discoverability.** At 1024 px, several action labels disappear and leave shortcut caps. The layout remains usable, but a developer unfamiliar with the shortcuts must rely on tooltips/accessibility names. Keep concise labels for the most useful actions and keep lesser-used actions in a labelled menu.

## Checked and fine

- **Build and tests:** `pnpm install` completed; the production web build passed TypeScript and Vite. Web Vitest: **177/177 tests, 15 files**. Existing live keyboard matrix: **41/42**, with the visual-case exception above. The other 41 cases passed, including viewer/operator/admin on snapshot, sandbox-e2e and remote-6390; the original matrix additionally exercised sandbox-main reads. I did not run the unrelated full 461-case suite.
- **Shortcut catalogue:** exercised Enter, Shift+Enter, edge-only history arrows, Ctrl+R and its accept/move/close paths, Ctrl+Space, Tab/Right accept, Esc dismissal/clearing, Ctrl+L, Ctrl+C, result navigation, copy-last, both documentation chords, the palette and `?`. Workbench current-line/selection/all execution and script preservation passed. Result-container Esc works; descendant Esc is finding 3.
- **Other table entries:** a separate viewer keyboard flow exercised landing arrows/Enter and positions 1–4 (four configured databases), key-tree arrows, namespace navigation, Space selection, `/` pattern focus, Enter inspection, and Alt+1/Alt+2. [Evidence](review-c1/peripheral-evidence.json).
- **Unrelated fields:** palette typing was left intact by Alt+1/2, Ctrl+L/R/C/Space, F1, Cmd+/, Shift+Enter, result-navigation chords and copy-last. `?` stays text in the editor. Confirmation text fields do not trigger page actions. The palette itself opens from the editor as documented.
- **History:** draft restoration, reverse substring search, older/newer matches, use-without-running, dismiss-without-losing-draft, clear-screen retaining history, and reload clearing history/results passed. No command/result material was found in local/session storage.
- **Visual cues:** database/environment/effective role/read-only prompt; command/subcommand/key/value/number/flag colouring; ghost history; active signature for populated arguments; live policy badge; destructive strip/red caret/Run…; running duration and Cancel; status glyph/gutter; result time/Redis duration/size/class; collapse/copy/JSON/code/re-run; did-you-mean; KEYS→SCAN retaining the pattern; empty-state examples; Workbench policy/result markers; overlay and palette were all exercised. Findings 2, 4 and 5 qualify the relevant cues.
- **Representative grammar:** inspected SET flags, HSET repeated field/value pairs, ZADD options/scores, SCAN MATCH/COUNT/TYPE, XINFO GROUPS, XREAD/XREADGROUP parallel key/ID lists, SORT source/destination, JSON.SET and MSET. Keys and stream IDs were distinguished correctly in the exercised populated commands.
- **Confirmation:** on sandbox-e2e, SET → EXPIRE → DEL cancel → GET preserved the value; a later DEL required a fresh confirmation retry and deleted exactly the test key; GET then returned nil. Re-run prompted again. Admin FLUSHDB typed-name challenge rejected wrong input and was cancelled before execution. No destructive confirmation bypass was observed. [Dialog](review-c1/delete-confirmation.png).
- **Read-only:** remote-6390 is visibly read-only in the prompt/shell and has effective viewer permissions. Typing SET and pressing Enter produced a blocked policy and announcement, a disabled Run button, **zero command requests**, and no trigger of the safety route guard. No write was sent to the remote. [Screenshot](review-c1/remote-readonly.png).
- **Real data tasks:** scanned the full snapshot keyspace; inspected an existing large JSON cache entry and its usable JSON tree. I created explicitly named, expiring `review:c1:` session/stream fixtures on the copy, located the session by SCAN, read its JSON, set and verified a 120-second TTL, and ran XINFO GROUPS (correctly empty). No existing application key was modified. Deletion tests were confined to sandbox-e2e.
- **Data safety:** React/text-node rendering and inert JSON parsing in the reviewed surfaces; no Redis-derived navigation URL. A hostile `<img … onerror=…>` reply/key remained text, injected no image and executed nothing. Opening its key-browser action used the fixed `/db/sandbox-e2e/keys` URL. Page title stayed `Redis Console`; local storage contained only theme/database preference and session storage was empty. [Evidence](review-c1/supplement-evidence.json), [screenshot](review-c1/inert-data.png).
- **Logs and CSP:** the guarded passing tests reported no CSP/Trusted Types violations or secret-response leaks. Supplemental pages also recorded zero violations and zero uncaught page errors. Expected HTTP 428 confirmation responses generated ordinary resource-error messages. Inspected server output used redacted argv; the review value sentinels and inspected cache key were absent from the captured log. This is scoped evidence from these runs, not a whole-product logging audit.
- **Themes and platforms:** inspected light and dark at all four widths, including danger, search, gutter and help/palette states. macOS dispatch used the host's `MacIntel` platform. A separate `Win32` platform override verified Ctrl+K, Ctrl+Enter, displayed Ctrl labels and selection-preserving Ctrl+C; the overlay's Windows/Linux label toggle also worked. [Non-mac log](review-c1/nonmac.log), [Workbench](review-c1/workbench-windows-dispatch.png). Windows/Linux were **simulated in Chromium on macOS**, not tested on those operating systems. These Playwright runs do not qualify OS-reserved input-source chords, browser-chrome interception or physical screen-reader interaction.

## Coverage to add

The important missing checks are Workbench cancellation followed by pending writes; completion at an empty key argument with actual key specs; Esc from result descendants; accessible gutter information; argument-type-specific numeric cues; ordinary character-by-character completion timing; actual non-macOS execution; and stable view readiness in the visual matrix. The existing `typeCommand` helper inserts an entire command and dismisses/reinserts it, which deliberately avoids the auto-popup timing encountered by a person typing.

## Cleanup

The review server and browser processes were stopped, port 4900 was released, and the detached review worktree was removed after checking its source diff was empty. Port 4000 and the main checkout's data directory were not used. No connection was made to port 6380. Review fixtures used unique names and short expiries; no database flush was executed. Screenshots, external review drivers and logs remain under `review-c1/`.
