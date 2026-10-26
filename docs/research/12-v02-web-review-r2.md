# v0.2 web review, round 2 (Claude Opus 5.5)

**Snapshot.** `release/v0.2` at `7a47aa0`, read-only worktree.

**Instance.** My own server on :4500 (`config/rconsole.dev.json`, data dir `/tmp/rc-review-w2`) with the QA local accounts `qa-viewer`, `qa-operator`, `qa-admin` (TOTP) and `qa-admin2`.

**Browser.** Playwright Chromium from `tests/e2e/node_modules`. Every session recorded:
- CSP violations, through a `securitypolicyviolation` listener;
- console errors;
- every API request, with whether it carried `X-CSRF-Token`.

**Read-only guard.** A route guard aborted any request to `remote-6390` that was not a read. It aborted **0 requests**, so the UI never attempted a write there.

**Writes.** These went only to `sandbox-e2e`, using `rcw2:*` fixtures shaped like Spring Session, JSON cache entries, a stream with a consumer group and a Bull list. All fixtures are removed: 0 `rcw2`/`bull` keys remain on 6410, 6411 and 6412.

**Other databases.** I only read `snapshot`, `sandbox-main` and `remote-6390`. I never connected to 6380 and did not touch port 4000.

**Screenshots.** `review-w2/` (cited as `[NN]` below).

**Code audit.** Two code-reading passes (Console/Workbench, and the rest of `apps/web`) ran beside the live session. I checked every finding below live, except those marked *(code-verified)*.

---

## Summary

The product is in good shape where security is concerned:
- zero CSP or Trusted Types violations on every page, in both themes, at 1024, 1440 and 1920;
- no Redis data in URLs, the title or storage;
- CSRF is enforced, and the server refuses everything that the UI hides;
- confirmations are accurate and cannot be skipped.

The weak spot is **data fidelity in the browser**. The inspector and the console show values that differ from what Redis stores:
- JSON numbers above 2^53 are rounded;
- numbers that look like epoch times are swapped for ISO dates;
- CRLF becomes LF on edit;
- a key whose name starts with a UTF-8 BOM collapses into the same name without it.

In three cases the wrong value or the wrong element is then written back:
- JSON path picker → rounded numbers saved;
- list editor after a refresh → a different element overwritten;
- string edit → TTL silently removed.

None of these were in round 1. All are reproducible in under a minute.

| Severity | Count |
|---|---|
| High | 3 |
| Medium | 7 |
| Low | 13 |

---

## High

### H1. JSON numbers above 2^53 are shown, copied and saved rounded (data loss through the path picker)

**Where:**
- `apps/web/src/lib/format.ts:109-116`: the JSON tab is `JSON.stringify(JSON.parse(…))`.
- `apps/web/src/components/ValueViewer.tsx`: Copy value copies that text.
- `apps/web/src/components/ConsoleResult.tsx:254`: console Tree/table mode uses `JSON.parse`.
- `apps/web/src/components/KeyOperations.tsx`: the "Pick a JSON path" option refills the editor from the parsed document.

**Repro (operator, sandbox-e2e):**
1. `JSON.SET p $ '{"id":5002,"name":"Widget 2b","big":9007199254740993}'` (a Java `Long` / Snowflake ID).
2. Open the key in the key browser. It opens on the JSON tab, which shows `"big": 9007199254740992` [10, 11].
3. Copy value puts `…992` on the clipboard.
4. Edit value → Pick a JSON path → `$`. The textarea is refilled with `…992` [60].
5. Change `name` to `Widget 2c` and Save.
6. `JSON.GET p` returns `{"id":5002,"name":"Widget 2c",…,"big":9007199254740992,…}`. **The ID changed in Redis.**

**The same display loss elsewhere:**
- Any string holding JSON, which is the normal Spring/Jackson cache shape: `{"orderId":1234567890123456789,"total":10.0}` is shown as `1234567890123456800` and `10` [12].
- The console's Tree/table mode: `GET` and `JSON.GET` results [28].
- 12345678901234567890 is shown as …567000 [07].

**Observed vs expected:**
- *Observed:* a developer looking up an order or user ID gets a different ID with no hint, and one editor path writes it back.
- *Expected:* the bytes Redis returned, pretty-printed losslessly; at minimum, a visible "rounded" warning, and never a write from parsed numbers.

**What already works:** Edit value without the picker keeps the raw text, and saving that path preserved `…993`.

**Minimal fix:**
- Pretty-print by re-indenting the raw JSON text with a small tokenizer that copies number tokens verbatim, instead of `JSON.parse`/`stringify`.
- Fill the path picker from `JSON.GET key <path>` (raw text), not from `JSON.stringify` of the parsed tree.
- In `JsonTree`, render number nodes from their source text, or flag `!Number.isSafeInteger` integers.

**Tests:** unit tests with 9007199254740993, `1.0`, `1.5e3` and `-0` through the JSON tab, Copy value, the path picker and the console tree; an E2E test that saves through the picker and compares `JSON.GET`.

### H2. A list editor stays on its index after a refresh, so Save overwrites a different element

**Where:** `apps/web/src/components/KeyContent.tsx:289-291` keys the panel by index (`index:${item.index}`). `InlineEdit` keeps its draft. `KeyContent` remounts only on page changes (the round 1 H1 fix), not on a refetch of the same page.

**Refetches come from:**
- the Refresh button;
- Auto refresh (5/15/30 s);
- every `rconsole:database-updated` event.

**Repro (operator, sandbox-e2e):**
1. `RPUSH l A0 A1 A2 A3 A4 A5`.
2. Open `l` and click edit on index 3 (`A3`). Type `EDITED-A3`.
3. From another client: `LPUSH l X`.
4. Click Refresh in the inspector. The editor now sits under row 3, which holds `A2`, and still says "Value at index 3" [37].
5. Save.
6. Redis: `X A0 A1 EDITED-A3 A3 A4 A5`. **`A2` is gone. The element the user edited (`A3`) is untouched.**

Auto refresh does the same with no click. Any app pushing to a queue makes this likely during a live debugging session.

**Minimal fix:**
- Store the `Bin` the editor opened with.
- When `details` changes, close the panel (with a "This list changed; reopen to edit" note) if `items[index].value` differs.
- Before `LSET`, verify `LINDEX` server-side. A `list.set` op with an `expected` value checked in `MULTI`/`WATCH` would close the race; that is a contract change.

**Same root cause, Low:** `list.remove` (`KeyContent.tsx` ~295) sends `LREM key 1 value`. With duplicate values it removes the *first* equal element, not the clicked row. *(code-verified)*

**Test:** E2E: open the index 3 editor, `LPUSH` externally, Refresh, Save; assert that index 3's old value is unchanged or that the panel closed.

### H3. Keys whose name starts with a UTF-8 BOM collapse into the same name without it (wrong key read and deleted)

**Where:** `packages/shared/src/bin.ts:3`: `new TextDecoder('utf-8', { fatal: true })` drops a leading BOM by default. The browser is told the key is `{enc:"utf8", data:"rcw2:bom:k"}`.

This lives in the shared package, but it breaks every web flow that names a key:
- the list and `keyscan.merge` dedupe;
- the inspector;
- Delete and Rename;
- console key links.

**Repro:**
1. `SET "\xef\xbb\xbfrcw2:bom:k" BOMKEY` and `SET rcw2:bom:k plain`.
2. Key browser, pattern `*rcw2:bom:*`: **"1 match"**, and one row with the BOM key's size (48 B).
3. Opening it shows `plain` (40 B), which is the other key [35]. Delete would remove `rcw2:bom:k`.
4. Console `SCAN 0 MATCH *rcw2:bom:*` lists two identical `rcw2:bom:k` rows. Both key links open the BOM-less key [36].

**Likelihood:** rare, because BOMs leak into keys from Windows-edited config or CSV imports. **Impact:** high, because it breaks the "binary-safe, exact bytes" promise and is a wrong-item write.

**Minimal fix:** `new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`, plus a round-trip test in `packages/shared`. Values that start with a BOM are fixed by the same change.

---

## Medium

### M1. Editing a string removes its expiry by default

**Where:** `KeyOperations.tsx:116` (`ttl` starts as `""`) and `:172-178` (no `ttl`, so a plain `SET`).

**Repro:**
1. Take a key with TTL 3600 (`rcw2:crlf:k`).
2. Edit value, change one character, Save.
3. `TTL` is now `-1` [39].

The hint ("An empty TTL removes the current expiry…") is accurate, but the default is the destructive choice. Session and cache entries edited during debugging become permanent and leak memory.

**Fix:**
- Prefill the field with the current remaining TTL, or add a "Keep current TTL (42m)" checkbox, checked by default.
- Better: `keepTtl` → `SET … KEEPTTL` (a contract change).

### M2. Editing text that contains CRLF silently converts every `\r\n` to `\n`

**Where:**
- `KeyOperations.tsx` (string/JSON editor) and `InlineEdit.tsx` (hash values, list items): `textarea.value` normalises line endings.
- The text tab also shows nothing for `\r` ("control characters are escaped" is not true for CR).

**Repro:**
1. `SET k "a\r\nb\r\nc"`.
2. Edit value, change one letter, Save.
3. `GET k | xxd` returns `…0a620a63` with no `0d` (verified).

**Fix:**
- Escape `\r` in the display.
- If the original bytes contain `\r`, open the editor in Base64 mode, or show "This value has CRLF line endings; editing as text will convert them" and keep CRLF when the edited text only differs by line endings.

### M3. Numbers that look like epoch times are replaced by ISO dates, and the raw value is hidden

**Where:** `KeyContent.tsx:161-164` (hash, list and set cells) and `:352` (zset scores). They render `epochLabel(x) ?? raw`; `format.ts:250-257` matches any 10- or 13-digit number between 2000 and 2100.

**Repro:** `HSET u id 1234567890 phone 9123456789 orderTotal 1700000000`.

The table shows:
- `id` → `2009-02-13T23:31:30.000Z`;
- `phone` → `9123456789` (only because 2259 is out of range);
- `orderTotal` → `2023-11-14T22:13:20.000Z` [58].

Spring Session's `creationTime` is shown as an ISO date [05], with no way to see the stored millis in the table. Zset scores get a `title` with the raw value; cells get none. The edit textarea is correct (raw), so this is display only, but it misleads and makes values impossible to copy from the table.

**Fix:**
- Always render the raw value.
- Put the date beside it as secondary text, as the stream table already does (`1792755467476-0` + `2026-10-23T…` underneath).

### M4. Background polling keeps an idle session alive forever

**Where:**
- Server: `apps/server/src/app.ts:230` calls `sessions.touch(s)` on every authenticated request.
- Web polls every 15–30 s:
  - `App.tsx:294` (database list, 30 s);
  - `dbstats.ts:55` (status bar, 30 s);
  - `Dashboard.tsx:34` (15 s);
  - `Diagnostics.tsx:887` (15 s).

**Repro:**
1. Sign in as `qa-admin2`, open Overview, then no input at all.
2. In my data dir's `sessions` table, `last_seen_at` moved from 11:53:23 to 11:55:09 within 100 s.
3. The status bar always reads "Session 59m 5xs".

**Impact:** an unattended workstation with this tab open never reaches `sessionIdleMinutes`. Only the absolute timeout (8 h here) ends it. For a tool whose selling point is security, idle timeout is a control auditors check.

**Fix:**
- Send `X-RC-Background: 1` on polling requests (TanStack `meta`), and have the server skip `touch()` for them.
- Alternatively, stop polling after N minutes without pointer or keyboard input.

### M5. Dialogs put initial focus on "Close dialog" and do not return focus to the trigger

**Where:** `components/ui.tsx:341-345`: `showModal()` runs in an effect after React's `autoFocus`, so the dialog focuses its first focusable element, the X button.

**Repro (keyboard):**
- Inspector → Rename, TTL; Keys → Delete by pattern, Add key; Admin → Create user. In every case `document.activeElement` was `BUTTON "Close dialog"`.
- Typing does nothing, and Enter/Space closes the dialog.
- After Esc, focus is on `<body>`, not the button that opened the dialog.

The round 1 palette fix (`App.tsx:299`) worked around the same cause in one place.

**Fix:**
- In `Modal`, after `showModal()`, focus `[autofocus], [data-autofocus]` or the first form control.
- Remember `document.activeElement` before opening and restore it in cleanup.

**Test:** `toBeFocused` on the first field for each dialog, and on the trigger after Esc.

### M6. Leaving the Workbench or Console mid-run erases the run from the transcript

**Where:** `pages/Console.tsx:436-439` (unmount aborts) and the `!mounted` early returns at `:616` and `:705`.

**Repro:**
1. Workbench: `BLPOP rcw2:wb:q 3` / `INCR rcw2:wb:c`, then Cmd+Enter.
2. While it blocks, click Keys in the rail, then come back.
3. The transcript shows only earlier runs [34]. There is no "cancelled / unknown" entry.

The server stops on the disconnect (INCR did not run), but line 1 may have run. A user who re-runs a non-idempotent script cannot tell what happened. The round 1 H1 fix handles exactly this for Ctrl+C, but not for navigation.

**Fix:** `setResults` writes to session memory and still works after unmount. In the `!mounted` branches, record the same "which lines ran is unknown" block used for the cancel fallback (`:715`).

### M7. Placeholders look like entered values (Guided mode runs a different command than the field appears to say)

**Where:** `styles/base.css:214-215`: placeholders use `--graphite`, the same mono face as values, with contrast 6.3:1.

**Repro:**
1. Guided → Find keys. The Key pattern field shows `session:*`, but it is a placeholder.
2. The preview below says `SCAN 0 MATCH * COUNT 200`, and that is what runs [50].
3. Audit filters show `username`, `database id` and `cli.exec` as if set [47].

A user who "doesn't know redis-cli", the audience of Guided mode, will believe they searched `session:*`.

**Fix:**
- Give placeholders a lighter style (`--delim`, italic or the UI face) and an `e.g.` prefix.
- In Guided, prefill sensible defaults as real values, or make the preview state "matches every key".

---

## Low

1. **Workbench Re-run marks whatever line now has that number.** `Console.tsx:1169-1171`.
   - Repro: run `SET a 1` / `GET a`, change line 2 to `DEL a`, then click Re-run on the old GET block.
   - The accessibility list says "Line 2, DEL rcw2:wb:a: success" [32], although DEL never ran.
   - Fix: update `lineStatuses` only if the line text still equals the re-run command.
2. **A request-level failure marks every line "error".** `Console.tsx:740-748`.
   - Repro: two tabs; run a blocking script in one and any script in the other. The 429 gives all three lines `error` in the gutter and the accessibility list, while the header says "1 error · 2 not run" [61]. Nothing ran.
   - The message also repeats itself: "…wait for it to finish. Too many requests at once. Wait a moment, then try again."
   - Fix: for `RequestError` with status < 500, mark lines `not run`. Skip the generic `rate_limited` guidance when the server message already says what to do.
3. **Guided results go stale and are not explained.**
   - After a run, changing the key or seconds leaves "✓ Done · Result 0" from the previous command beside the new preview [52].
   - `EXPIRE` on a missing key returns a bare `0`.
   - Fix: clear the result when inputs change, and reuse the console's "explain empty replies" ("0: the key does not exist; nothing changed").
4. **The examined count exceeds the total.** "1 match · 599 examined of 465 keys" [03]. `Keys.tsx:405` sums SCAN's per-page counts.
   - Fix: say "SCAN steps" or cap the count at `dbSize`.
5. **The read-only database write badge blames the role.**
   - On `remote-6390`, `SET` shows "SET requires the operator role on this database (you have viewer)" [53].
   - The real reason is that the database is read-only for everyone. Operators see the same "you have viewer".
   - Fix: when `db.readOnly`, say "This database is read-only. Writes are refused for every role."
6. **Esc and Ctrl+C clear the Console line with no undo.** `Editor.tsx`: `history()` is enabled only in multiline mode.
   - Verified: type a long `HSET …`, press Esc twice, Cmd+Z: nothing comes back, and ↑ has nothing because it never ran.
   - Fix: enable `history()` in both modes.
7. **The Shift-range anchor is a row index.** `Keys.tsx:149, 263, 271, 314` *(code-verified)*.
   - After Continue scan, a folder toggle or a re-sort, Shift+click selects a range from a different row than the one the user anchored on.
   - Fix: store the anchor as a key id.
8. **Batch Set TTL over 100 keys is disabled with only a `title` tooltip.** Not visible, and not announced for keyboard or screen reader users.
   - The 3600 input has no visible unit, and success gives no message.
9. **Time formats differ by page:**
   - inspector: ISO UTC;
   - slow log: local 24 h ("Oct 23, 17:08:47");
   - console: 12 h ("05:12:12 PM");
   - admin: "10/23/2026, 17:19:15";
   - Overview "Average TTL 772.5h" against the fuse's "32d 4h".
10. **The policy badge repeats itself:** "blocked · blocked" for `KEYS` and for unknown or partially typed commands. While typing `HGETAL`, the badge says "unavailable for your role or database", which is wrong for an unknown command.
11. **The KEYS→SCAN suggestion re-encodes the pattern.** `ConsoleAssist.tsx:137-142` uses `JSON.stringify` of the lexed text, so `\xHH` bytes become different UTF-8 *(code-verified)*.
12. **More issues found by reading the code** *(code-verified, not reproduced live)*:
    - Ctrl+R in the Workbench reloads the page on Windows/Linux and loses the script.
    - Enter on the history-search "older" or "close" buttons picks the match instead.
    - The confirmation dialog survives browser Back.
    - The inspector's "Close and rescan" invalidates a query key that no longer exists, so it does not rescan.
    - `pubsub/publish`, `slowlog/reset` and `clients/kill` count as key writes in `api.ts:137` (false "Keys were changed" banner).
    - `/?error=constructor` prints `function Object()…` on sign-in (`Auth.tsx:68`; use `Object.hasOwn`).
    - Chart y-range inverts for flat negative series (`Chart.tsx:93-99`).
13. **Accessibility details:**
    - `CopyAction` mounts its `role=status` already filled (often not announced).
    - Each console result is a `<section aria-label>`, which adds up to 100 landmarks.
    - The key tree's `aria-activedescendant` can point at a virtual row that was unrendered by wheel scrolling.

---

## UX improvements (ranked)

1. **Show the stored bytes first, interpretations second.**
   - Lossless JSON pretty-printing (H1).
   - Raw value plus a secondary epoch hint (M3).
   - A small "≈ rounded" / "CRLF" / "BOM" marker when a view is not byte-exact.
   - For a debugging instrument, trust in what is on screen is the product.
2. **Keep TTL on edit by default** and say so: "Keeps current expiry (42m)". This is the most common accidental change for cache and session work.
3. **Streams: connect the inspector to the queue view.**
   - The stream inspector shows "Consumer groups 1" as plain text.
   - Make it a link to Diagnostics → Streams with the key filled in, and show pending/lag per group inline.
   - Pending entries: ack by row checkboxes instead of typing IDs [16].
4. **Make Guided mode teach.**
   - Explain every result in a sentence.
   - Clear stale results.
   - Offer key-name completion from keys already scanned.
   - Show TTL inputs with units and a human preview ("3600 s = 1 h").
5. **Per-tab document title:** `Keys · snapshot (copy) [dev] — Redis Console`. This uses configuration names, not Redis data. Today every tab is "Redis Console", which is risky when a prod tab and a dev tab are open side by side.
6. **Dialog focus** (M5): focus the first field, return focus on close. Keyboard-only users feel this on every rename or TTL change.
7. **Bulk actions feedback:**
   - "TTL set on 11 keys" and "Deleted 150 keys" status lines in the selection bar.
   - A visible note when Set TTL is disabled (>100 keys) instead of a tooltip.
8. **Audit log readability:**
   - Collapse bursts ("key.scan ×20 · scan to end").
   - Make Action a select of known actions.
   - At 1024 the Reason column is off-screen and denied rows wrap into tall blank rows [47].
9. **Overview first paint:** two large empty "Collecting live samples" boxes [m-overview-light-1440]. Draw the first point immediately, or shrink the boxes until data arrives.
10. **One time format everywhere** (local, 24 h, with UTC in the tooltip), and TTL-style durations (`32d 4h`) for averages.
11. **Visual polish:**
    - The Overview readout strip is still seven equal boxed tiles, close to the "identical cards" tell that DESIGN.md §8 says was removed.
    - Diagnostics' Streams view has three filled primary buttons on one screen.
    - The rest is distinctive: the key anatomy, the TTL fuse, the hatched read-only edge and the console prompt with its database, environment and role read as a purpose-built instrument [26, 43].

---

## Checked and fine

**Security in the browser**
- **CSP / Trusted Types:** 0 violations.
  - Matrix: Overview, Keys with an open inspector, Console with results and completion, and Diagnostics; in light 1440, dark 1024, dark 1920 and light 1024 [m-*].
  - Also the Workbench, Guided, Admin users, the audit log, the palette and the `?` overlay.
  - The only console error was the expected 401 from `/auth/me` before sign-in.
- **Storage and URLs:**
  - `localStorage` holds only `rconsole.theme` and `rconsole.database`.
  - sessionStorage, IndexedDB and service workers are empty, and `document.cookie` is empty (HttpOnly).
  - The title is constant.
  - Opening a key from a console result navigates to `/db/sandbox-e2e/keys`, with no key in the URL.
  - Bidi and space keys render escaped (`bidi‮txt.exe`).
- **CSRF:** every captured non-GET carried `X-CSRF-Token`. A scan POST without it got `403 csrf`.
- **Role hiding is cosmetic only.** As viewer, through `fetch`, on a writable database:
  - `bulk-delete` → 403;
  - workbench `SET` → forbidden per line (and audited);
  - `/admin/users` and `/admin/audit` → 403.
- **remote-6390:**
  - hatched top edge "Read-only database · All writes are disabled", plus Read-only in the context bar and the status bar [43];
  - no write controls for the viewer, and the console badge blocks `SET`;
  - the guard saw 0 write attempts.

**Correctness**
- **Bulk delete by pattern:**
  - editing the pattern clears the preview;
  - the confirmation names the database, environment and role, and lists the exact `SCAN` + `UNLINK` with all 11 keys and the typed name [23];
  - Esc → "Action cancelled. No changes were made." (11 keys still present in Redis);
  - Confirm → "Deleted 11 of 11", 0 left.
- **Selection:**
  - cleared on rescan or pattern change [19];
  - select-all is capped at 1,000 with "(limit 1000)";
  - deleting 150 selected keys confirmed with an `UNLINK` preview, and all 150 were removed.
- **Edits without the path picker:**
  - the hash field editor and Edit value prefill the raw stored text (epoch millis, `1.5e3`, `…993`);
  - saving a JSON document that way kept the big integer and the TTL.
- **Streams tool:** groups, consumers, pending, lag and last-delivered match `XINFO`/`XPENDING` [15, 16]. The inspector's Older entries is disabled at the end.
- **Spring session lookup:** pattern `…index:user7*` → the index key → UUID → the session hash, in four steps, with the TTL fuse burning live [03-05].

**Performance on 7.5k keys (snapshot, viewer)**
- Scan to end completed within the 60 s wait. I did not get a precise figure, because the script errored before printing it.
- Measured round trips:
  - expanding the top-level folder took 67 ms;
  - expanding the largest folder (several thousand keys) took 100 ms;
  - sorting by size took 50 ms;
  - select-all of 1,000 keys took 113 ms.
- The DOM stayed at about 1.1k nodes (virtualised).

**Round 1 fixes that held**
- JSON tree rows flow normally in the inspector and the console [11, 28].
- Alt+2 lands the caret in the console editor.
- Enter runs a typed command exactly.
- Option+↑ focuses the last result; Tab reaches Collapse → Copy → JSON.
- Cmd+Shift+C copies the last result.
- Esc from a result's action returns to the editor.
- The `?` overlay lists every binding with platform labels.
- The palette opens with Cmd+K.
- Landing `1` opens the first database.
- The console's empty-reply explanations work.

---

## Test gaps

**No tests for:**
- **Data fidelity:** JSON integers above 2^53 through the JSON tab, Copy value, the path picker and the console tree (H1); BOM key and value round trips (H3); CRLF through both editors (M2).
- **List editing:** the list editor plus a refetch at the same page (H2); `list.remove` with duplicate values.
- **TTL and display:** TTL kept or removed on a string edit (M1); epoch display keeping the raw value (M3).
- **Idle session:** the idle timeout with an Overview tab open (M4). This needs a server test with polling requests.
- **Keyboard and focus:**
  - initial focus and focus return for each dialog (M5; round 1 also noted this);
  - Esc/undo on the console prompt (L6);
  - Enter on the history-search buttons.
- **Workbench:**
  - navigating away mid-run, in Console and Workbench (M6);
  - Re-run after an edit (L1);
  - the 429 / expired-confirmation paths (L2);
  - declining a destructive script with Esc ("nothing ran", gutter "not run", key unchanged).
- **Guided:** stale results (L3).

**Live coverage gaps (also not covered by me):**
- Prod and staging framing: the dev config has no prod or staging database, so the red frame, the reason field and the typed-name rules on prod were not exercised live.
- Windows/Linux keyboards, where Ctrl+R reloads, Ctrl+Shift+C is DevTools and Ctrl+Space switches input sources.
- A screen reader session.
- The Keycloak SSO users: I used the local QA accounts.
- I did not run the E2E suite. There was no code change to validate, and running it would have required the shared lock.
