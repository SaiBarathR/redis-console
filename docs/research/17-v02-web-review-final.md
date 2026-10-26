# Redis Console v0.2 — final web convergence review (round 4)

Reviewed `release/v0.2` @ **`b379a6b`** (detached worktree `redis-console-wt/review-w4`), 23 October 2026. Source unchanged; no commits.
**Result: 0 High, 2 Medium, 2 Low.** Compare-and-set editing is sound. I attacked every editor and type as qa-operator and qa-admin on sandbox-e2e and snapshot, and every case either wrote exactly the bytes the user saw or wrote nothing and showed an accurate conflict. The remaining defects are copy/display fidelity outside the editors (M1, M2) and two small stale-state issues (L1, L2).

## Method
- Prior reports read: 09, 10, 12, 14; `docs/REVIEW-LOG.md` (round 3 web verdicts and CAS design).
- Server :4700, `config/rconsole.dev.json`, data dir `/tmp/rc-review-w4`; QA accounts via `scripts/qa-accounts.mjs`.
- Writes only to sandbox-e2e (6411) and snapshot (6412) under prefix `rcw4:` (plus one BOM-prefixed `rcw4:` key). Removed afterwards: 46 keys on 6411 and 40 on 6412, then 0 matching `*rcw4:*` (`review-w4/cleanup.json`). Remote-6390 was only read through the app: GET overview, POST key scan. A Playwright route guard aborted any other request, and none was attempted. No connection to 6380, no use of port 4000 or the main checkout's `data/`. The server was stopped by its PIDs (20662, wrapper 20579), and the worktree was removed. No source edits, no commits, no E2E run (the fixers' 502/502 run stands; I did not take the lock).
- Build passed. `pnpm --filter @rconsole/web test` passed: **272/272** (23 files).
- Drivers (no credentials embedded; they need the worktree recreated to rerun) are in `review-w4/drivers/`, with outputs as `review-w4/*.json` and screenshots as `review-w4/*.png`. The second session for "change the key" was a direct guarded connection to 6411/6412, and the Console readbacks are in `console-*.json`. Several first driver runs failed on my own selectors or timing (`*-fail.png`). Each was fixed and rerun, and none is a product finding.

## Verification notes
- Own inline saves (hash field, list index, zset score) close cleanly with no spurious "changed" notice — sound.
- Copy value (Text tab) copies the escaped display text, not the value: CR → `\u000d`, NUL, BOM, bidi, ZWSP likewise (`review-w4/probe1.json`). See M-findings.
- A UTF-8 string `﻿{"a":1}` opens on the JSON tab with "Invalid JSON at character 0." and Copy disabled (`review-w4/b-bom-json.png`).

- Edit matrix as qa-operator on sandbox-e2e (`review-w4/matrix-operator-sandbox-e2e*.json`): string (unobserved 409 → Overwrite; observed via 5 s refresh; CRLF Base64 → Reload reopens on new bytes, Base64 kept; ABA same bytes saves; binary FF 00 0D 0A 80 round-trips), main-editor hash (on page and off page: "It has a value now that you have not seen"), list LSET -1 after RPUSH, zset score after ZINCRBY, JSON subpath after unrelated JSON.SET (Overwrite writes only `$["a"]`), JSON with 2^64-range int/-0.0/emoji/`\/` saves without a false conflict, inline hash/list/zset (changed, deleted field, removed member, inf/1e+21/0.1 scores no false conflict), type change under a row editor (no Overwrite offered, no write), delete and rename of a changed key (Delete/Rename anyway), key deleted under the editor (Reload closes). **All wrote exactly the expected bytes or nothing.**


## Findings

No High findings. Every compare-and-set path I exercised wrote exactly what the editor showed, or nothing.

### M1: Console shows and copies invisible characters as `\uXXXX`, but the Console reads that back as a different key

**Source:** `apps/web/src/components/Reply.tsx:82` (`visibleText(cliBin(reply.v))`), `apps/web/src/lib/format.ts:10` (`visibleText` turns U+FEFF, U+200B–U+200F, U+202A–U+202E, U+2060–U+2069 and U+061C into `\uXXXX`) and `:172` (`cliQuote` leaves those code points raw). The shared tokenizer `packages/shared/src/commands.ts:264` has no `\u` escape, so `\u` becomes the letter `u` (redis-cli does the same).

**Repro (qa-operator, sandbox-e2e, Console, keyboard only):**
1. `SET "\xef\xbb\xbfrcw4:kb:bom" v` → `"OK"`; the key link reads `\ufeffrcw4:kb:bom`.
2. `SCAN 0 MATCH *rcw4:kb:bom* COUNT 10000` → `1) \ufeffrcw4:kb:bom`. Press Cmd+Shift+C (copy last result) and paste: `2) 1) "\ufeffrcw4:kb:bom"`.
3. Run what the reply shows: `TYPE "\ufeffrcw4:kb:bom"` → `"none"`, "The key does not exist.". The result's own key link now reads **`ufeffrcw4:kb:bom`**.
4. `EXISTS "\xef\xbb\xbfrcw4:kb:bom"` → `(integer) 1`.

**Observed:** the reply and Copy result use a notation that neither this Console nor redis-cli parses. Re-running it addresses `ufeff…`, a different key. A pasted `DEL`/`SET` would write to that other key. **Expected:** the shown and copied form round-trips to the same bytes, as it already does for CR/LF (`"a\r\nb"`) and binary (`\xHH`).
**Evidence:** `review-w4/c-operator-light-1440-confirm.png` (transcript behind the dialog shows the SET, SCAN, TYPE→none and EXISTS→1 rows), `review-w4/console-operator-light-1440.json` (`bom-key`).
**Minimal fix:** in `cliQuote`, write these invisible and bidirectional code points as their UTF-8 bytes (`\xEF\xBB\xBF` for U+FEFF) before `visibleText` sees them. The text stays visible and parses back to the same key in both the Console and redis-cli. Add a round-trip test: for each code point `visibleText` escapes, `tokenizeCommandLineBytes(cliBin(x))` must equal the bytes of x.

### M2: "Copy value" on the Text tab copies the escaped display text, not the value

**Source:** `apps/web/src/components/ValueViewer.tsx:121` (`copyText` → `formatValue(displayed, "text", Infinity)`) → `apps/web/src/lib/format.ts:16` `displayBin` → `visibleText`.

**Repro (qa-operator, sandbox-e2e):** create strings `line1\r\nline2`, `a\u0000b`, `abc\u202edef`, `a\u200bb` (and `\ufeff{"a":1}` on the Text tab). Open each one in Keys, then click **Copy value** (the default Text tab). Paste with a native paste into a plain textarea.

**Observed** (`review-w4/probe1.json`): the clipboard holds `line1\u000d\nline2`, `a\u0000b`, `abc\u202edef` and `a\u200bb` as literal backslash sequences, and `\ufeff{"a":1}` as 12 ASCII characters. Only TAB and LF round-trip. The button is labelled "Copy value", and nothing says the copy is escaped. A developer copying a CRLF payload (HTTP, CSV, mail) into a test or ticket gets different text. **Expected:** Copy value on the Text tab copies the stored text exactly (the clipboard is not a rendering surface), or the button says "Copy as shown (escaped)" and an exact copy is one click away. Hex and Base64 copies are already exact; JSON/MsgPack copies stay valid JSON because `\uXXXX` is a JSON escape there.
**Minimal fix:** for `format === "text"` and a UTF-8 value, copy `displayed.data` itself. Keep the escaping for display. If raw bidi characters in the clipboard are a concern, label the copy "Copy escaped text" instead, and add "Copy exact" (e.g. Base64 / `\xHH` CLI form).

### L1: A BOM-prefixed JSON string opens on a failing JSON tab and shows nothing

**Source:** `apps/web/src/components/ValueViewer.tsx:30`. `looksLikeJson` calls `trim()`, which strips U+FEFF, so detection succeeds. The view then parses with `parseValue` (`format.ts`, `ignoreBOM: true`), which keeps the BOM and fails.
**Repro:** `SET rcw4:copy:bom "\xef\xbb\xbf{\"a\":1}"`, then open it in Keys. **Observed:** the JSON tab is selected and shows "Invalid JSON at character 0."; the value area is empty and Copy value is disabled (`review-w4/b-bom-json.png`). **Expected:** it opens on Text (showing `\ufeff{"a":1}`), or on JSON with a "starts with a BOM" note.
**Fix:** `looksLikeJson` should strip only JSON whitespace (`/^[ \t\r\n]+/`), or call `parseValue` so detection and rendering agree.

### L2: After a key is deleted, the inspector keeps its old value and live actions; "Set expiry" then closes as if it worked

**Source:** `apps/web/src/components/KeyInspector.tsx:257`–`:300`. When the read returns 404, `missing` renders the notice, but `data` (React Query keeps the last success) still renders the header, value and action bar. `apps/web/src/lib/operations.ts:23`–`:37` checks a RENAMENX 0 but not an EXPIRE reply of `(integer) 0` (no such key), so `KeyInspector.tsx:625` closes the dialog as if it succeeded.
**Repro (operator):** open `rcw4:gone2`, delete it from another client, click **Refresh key**. **Observed:** "This key no longer exists." sits above the old value `v`, with Edit value / TTL / Rename / Delete enabled (`review-w4/b-stale-after-delete.png`). Submitting **TTL** 100 closes the dialog with no message, but nothing was set (EXPIRE returned 0; key absent) (`review-w4/b-stale-ttl.png`, `stale.json`). Edit value correctly gets the 409 "The key no longer exists".
**Expected:** a missing key shows no live value or write actions (or only a dimmed "last read" copy), and an EXPIRE reply of 0 is reported as "This key no longer exists". PERSIST 0 is ambiguous (no TTL), so leave it.
**Fix:** render the `data` block only when `!missing`. In `keyOperation`, throw "This key no longer exists" for `key.expire` with an int reply of 0.


## Ranked UX list (not defects)

1. **Name what each copy is.** After M1/M2, make the copy labels state their format, for example "Copy value (exact)", "Copy as redis-cli" and "Copy escaped text". This product has six copy surfaces, and users cannot tell which are exact.
2. **Diff for collection elements in the main editor.** The row editors show "Changes since you opened it" for hash, list and score conflicts. The main "Set a hash field" / "Add or update a sorted set member" dialog shows only the current value (`hash-main`, `zset-main` cases), because `opened` is passed only for string/JSON (`KeyOperations.tsx`, `ConflictNotice opened=`). Pass the element bytes found by `elementExpect`.
3. **Partial command names read as "blocked".** Typing `HGETA` in the Console shows a red "blocked · blocked: This command is unavailable for your role or database" while the completion offers `HGETALL` (`review-w4/v-dark-1440-console.png`). Show a neutral "unknown command" or nothing until the token matches or the line runs.
4. **Guided "Set a string value" drops TTL and replaces any type.** It runs a plain `SET` and shows the exact command, which is honest. The key editor, by contrast, defaults to KEEPTTL and guards type changes. A one-line hint ("replaces the value and removes any expiry; an existing hash/list is replaced") would match the key editor's care.
5. **1024 px hash table.** Long field names wrap to 4 lines, and JSON values are clipped mid-token with no ellipsis (`review-w4/v-light-1024-snapshot-hash.png`). This was deferred before. It is still the densest pain point on real development data.
6. **Paging away from an open row editor silently drops the draft.** No notice appears; the original bytes are unchanged (`paging.json`). A "Discard draft?" or a kept draft would be kinder.

## Sound (verified, no findings)

- **Compare-and-set, all editors × types, both roles, both writable databases** (`matrix-operator-sandbox-e2e*.json`, `matrix-admin-snapshot.json`, 19/19 cases each):
  - Unobserved changes return 409 with the correct reason text: "Another client wrote it", "It has a value now that you have not seen", "What you opened is no longer there", "The key no longer exists" and "It is now a string (you opened a hash)".
  - The current value is shown, with a line diff where useful.
  - Save is disabled while the conflict shows.
  - Overwrite anyway writes the draft over exactly the shown state, and is never offered across a type change.
  - Reload reopens on fresh bytes and keeps Base64 for CRLF, or closes when the key is gone.
  - Observed changes (5 s auto refresh) disable Save before any request.
  - JSON subpath edits are guarded by the whole document, and Overwrite writes only that path.
  - Off-page hash fields are expected absent.
  - LSET -1 after RPUSH is caught.
  - Equal bytes (ABA) save normally.
  - No false conflicts on 20-digit integers, `-0.0`, emoji, `\/`, `inf`, `1e+21` or `0.1` scores, binary `FF 00 0D 0A 80`, or a 200,003-byte string loaded in full.
- **Own saves** close cleanly with no spurious "changed" notices.
- **Delete / Rename** of a changed key: "This key changed since you read it" with Delete/Rename anyway; nothing deleted or renamed.
- **MessagePack** (`broad.json`): uint64 max, int64 min, float32 shown exactly (`0.10000000149011612`), duplicate integer map keys kept in order, a 96-bit negative timestamp to the nanosecond, a nested 2^53+1 integer, and invalid UTF-8 marked `InvalidUTF8(…)`.
- **JSON** with big integers in a hash value keeps its number tokens, and `1.50` stays `1.50`.
- **Truncation**: a string over the preview cannot be edited until loaded in full, and then edits correctly.
- **Read-only remote-6390** (as admin):
  - A hatched "Read-only database · All writes are disabled" banner, a red Read-only badge, and the effective role shown as viewer.
  - No Add/Edit/TTL/Rename/Delete/bulk delete.
  - In the Console, a typed `SET` shows "write · blocked: This database is read-only" with Run disabled.
  - The Workbench names the blocked line, with Run disabled.
  - Guided lists its write tasks with "write" tags. I did not open one on the remote. The code disables their Run button and shows "This database is read-only, so write tasks are off." (`Guided.tsx` `blocked`).
  - Screenshots: `b-remote-*.png`.
- **Viewer**: no write controls on sandbox-e2e; Console `SET` is blocked with a role reason and Run disabled.
- **Console, keyboard only** (`console-operator-light-1440.json`):
  - Focus starts on load.
  - Enter runs.
  - ↑/↓ history keeps the draft.
  - Ctrl+R search.
  - Tab completion.
  - F1 docs, with Esc returning focus to the prompt.
  - Alt+↑/↓ moves through result blocks and back to the prompt.
  - Cmd+Shift+C copies the last result.
  - Ctrl+C clears the line.
  - `?` opens the overlay.
  - A destructive `DEL` opens the confirmation with focus on Close, so Enter cancels ("Cancelled at the confirmation. Nothing was run."), which is a safe default.
  - Exact integers: `INCRBY … 9007199254740993` returns the exact value.
  - CRLF replies show as `"a\r\nb"`.
- **Workbench, keyboard only**: Mod+Enter runs; per-line status for screen readers; stop on first error marks later lines "not run"; WRONGTYPE is reported on its line.
- **Themes and widths**: light and dark at 1024 and 1440 for Keys, the conflict dialog, Console, Workbench and Overview on snapshot (`v-*.png`). There were no page errors or CSP violations in any run.

## Release recommendation

**Ship v0.2 once M1 and M2 are fixed.** Both are small, local changes to the copy and quoting paths. Editing safety, the reason for the last three rounds, is now structurally sound. L1/L2 and the UX list can follow in a patch.
