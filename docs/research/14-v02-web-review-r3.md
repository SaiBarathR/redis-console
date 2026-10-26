# Redis Console v0.2 — independent web review, round 3

Reviewed **`137d7659fdf7504a02288d77fb231663d1422515`**, detached from `release/v0.2`, on 23 October 2026. Source remained unchanged. All source locations below refer to that commit, even if the release branch has since advanced.

**Result: 3 High, 2 Medium, 1 Low new findings, all reproduced against the production build.** The release is not yet clean on data fidelity and safe editing. The most consequential defects are drafts that survive an observed change to the data they edit. The previous JSON-number fix also does not cover MessagePack integers.

## Method and evidence

- Read the prior web/console reports (`09`, `10`, `12`), the review log, contributor rules, architecture, v0.2 plan, design and shared API/contract notes. Inspected the frontend's data conversions, editor and collection state, scan identity, Console/Workbench execution and copy paths, Guided mode, authentication/access handling, diagnostics, and UI regression specifications.
- Created `../redis-console-wt/review-w3` at the requested commit, linked its `.env`, ran `pnpm install`, then `pnpm --filter @rconsole/web build`. Both passed. Provisioned local QA accounts with the supplied script.
- Used a separate server at **http://localhost:4700**, the requested dev config, and **`/tmp/rc-review-w3`**. Playwright Chromium exercised **qa-viewer, qa-operator and qa-admin**. No source or test files were edited, and no commit was made.
- All fixture writes were on **sandbox-e2e / 6411**, under `rcw3:20261023:` or the same prefix preceded by a UTF-8 BOM. Existing snapshot data was read only. Remote-6390 was read through the app only; no write request was sent there. No connection was made to 6380, and neither port 4000 nor the main checkout's `data/` was used.
- Fixture creation used a guarded direct connection to the approved sandbox. Mutation probes were checked with CLI replies through this server, including browser Console readbacks, and direct byte reads where relevant. Native clipboard paste was used for copy checks; this avoided confusing the app's clipboard-read Permissions Policy with a failed copy.
- Evidence, screenshots and external review drivers are under **`<research-dir>/review-w3/`**. Drivers contain no embedded credentials. They refer to the review checkout, which is removed during cleanup; recreating that checkout is necessary to rerun them.

The broad interaction matrix completed 32/35 groups; its three failures used an overlong exact SCAN pattern, which correctly exceeded the API's 512-character pattern limit. A separate short-prefix scan verified the long keys and invisible names for all three roles (`diagnostics.json`). The diagnostics matrix completed 25/28 groups; the other three used the wrong button name in the external driver. All three memory-analysis cases passed with `analysis-run` (`recovery.json`). These are recorded driver errors, not product findings. Initial driver errors and logs are retained rather than presented as a completely green test-suite run.

## High findings

### H1 — A refreshed hash value changes the encoding of an already open draft

**Source:** `apps/web/src/components/InlineEdit.tsx:19`, `:20`, `:32`; hash callers in `apps/web/src/components/KeyContent.tsx:265`. `editableBin(value)` is recomputed from new props on every render, but `draft` is initialized only once. Save combines the old draft with the new `editable.enc`.

**Repro, as operator on sandbox-e2e:**

1. In Console, run `HSET rcw3:20261023:hash-live f YWJj`.
2. Open that hash in Keys. Choose **Edit hash field f**. The editor is UTF-8. Enter the literal text **`REVG`**.
3. From another Console tab, run `HSET rcw3:20261023:hash-live f "\xff\x00\r"`.
4. In the original inspector click **Refresh key**, or let its five-second refresh run. The draft remains `REVG`; its encoding caption silently becomes Base64.
5. Save. Read it back with `HGET rcw3:20261023:hash-live f`.

**Observed:** Redis contains **`DEF`**, bytes **`44 45 46`**. The user entered UTF-8 `REVG`, bytes **`52 45 56 47`**. The old draft was Base64-decoded because the refreshed row became binary. A refreshed UTF-8 value containing CR triggers the same encoding transition through `editableBin`. The reverse transition can write a former Base64 draft as literal text.

**Expected:** An open draft retains its original byte interpretation. An observed conflicting row update must close the draft or require an explicit conflict decision; a refresh must not redefine its encoding.

**Minimal fix:** Capture `{data, enc}` together when opening the editor. Keep that encoding for the draft's lifetime. Also invalidate the hash editor when its observed source bytes change, as the list editor now does. Freezing the encoding alone prevents this corruption but still leaves an unannounced stale-value overwrite.

**Evidence:** [Changed encoding beside unchanged draft](<research-dir>/review-w3/h1-hash-encoding-changed.png), [Console readback](<research-dir>/review-w3/h1-hash-readback.png), `review-w3/probe.json` (`hashBefore`, `hashAfterDirect`, `hashAfterConsole`). The direct read is `444546` in hex.

**Regression needed:** Open a UTF-8 hash draft, refresh the same field to binary and separately to CRLF text, then assert the draft closes or remains explicitly bound to its original encoding. Include the reverse binary-to-text transition.

### H2 — The main value editor survives observed type changes and JSON array retargeting

**Source:** `apps/web/src/components/KeyInspector.tsx:538` passes refreshed `data` into the existing editor. `apps/web/src/components/KeyOperations.tsx:95`–`:120` initializes type, value, encoding and path once; `:124` and `:133` derive options/title from current details; `:173`–`:176` and `:226`–`:227` submit the retained type/path/draft. There is no source-snapshot invalidation.

This has two independently reproduced destructive outcomes.

**Repro A — Hash replaced by SET under a hash-editor title:**

1. Console: `SET rcw3:20261023:type-change ORIGINAL`.
2. Open it in Keys; set **Every 5 s** refresh, choose **Edit value**, enter `EDITED`.
3. In another Console tab, delete only that fixture key (confirm the deletion), then run `HSET rcw3:20261023:type-change sensitive KEEP-ME`.
4. Wait until the original inspector shows the hash and the open modal title changes to **“Set a hash field.”**
5. Save the still-open modal.
6. Run `TYPE rcw3:20261023:type-change` and `GET rcw3:20261023:type-change`.

**Observed:** The modal sends **`SET … EDITED KEEPTTL`**. `TYPE` is `string`, `GET` is `EDITED`, and the entire hash is gone. Its current title and inspector describe a hash-field operation, while its retained state performs whole-key replacement.

**Repro B — JSON array editor overwrites a different item after refresh:**

1. Console: `JSON.SET rcw3:20261023:array-retarget $ '{"items":[{"id":"A","v":1},{"id":"B","v":2}]}'`.
2. Open Edit value with five-second refresh. Pick **`$["items"][1]`** and change the draft to `{"id":"B","v":99}`.
3. In another Console tab: `JSON.ARRINSERT rcw3:20261023:array-retarget $.items 0 '{"id":"X","v":0}'`.
4. Wait for the refresh. The picker now includes the new index 2, proving that the new document reached this editor. Save without changing the path.
5. Console: `JSON.GET rcw3:20261023:array-retarget`.

**Observed:**

```json
{"items":[{"id":"X","v":0},{"id":"B","v":99},{"id":"B","v":2}]}
```

The draft originally opened for B replaced **A**, which moved under index 1. The original B at index 2 is untouched.

**Expected:** Once a refresh reveals that the source type or selected JSON item changed, the old editor must become unusable until reopened or explicitly reconciled. This is an **observed-conflict** bug, beyond the already documented race between the last read and a later save.

**Minimal fix:** Bind the editor to an immutable opening snapshot and close it on an observed type/value conflict. The simplest safe patch closes it when source value bytes or type change. A less disruptive version compares the selected JSON subtree as well as the key/type. Keep the title, operation and draft derived from the same snapshot. An eventual atomic expected-value server operation would additionally close the unobserved read/write race.

**Evidence:** [Hash title with string controls](<research-dir>/review-w3/h2-type-change-before.png), [Hash replaced, Console readback](<research-dir>/review-w3/h2-type-change-readback.png), [JSON draft after array change](<research-dir>/review-w3/h2-json-array-retarget-before.png), `review-w3/supplement.json` (`observed-type-change`, `observed-json-array-retarget`). The former records the exact submitted SET argv and both readbacks.

**Regression needed:** Both examples above, including automatic refetch. Assert no write after invalidation, rather than only checking that a label changed.

### H3 — MessagePack still rounds 64-bit integers and changes other scalar types

**Source:** `apps/web/src/lib/format.ts:123`–`:130` decodes MessagePack with its default number handling. `apps/web/src/lib/json.ts:66`–`:75` serializes decoded JavaScript values as JSON/object entries. The JSON token-preservation fix does not protect this decoder.

**Repro, any role:**

1. Console: `SET rcw3:20261023:msgpack "\xcf\x00\x20\x00\x00\x00\x00\x00\x01"`.
2. Open the key, choose **MsgPack**, then **Copy value** and paste into a text field.
3. Read the original bytes through Console GET or Hex/Base64.

**Observed:** The encoded uint64 **9007199254740993** is displayed and copied as **9007199254740992**. A map containing that integer was copied through the native clipboard as `"n": 9007199254740992` for **viewer, operator and admin**. The original Redis bytes remained correct.

Additional live cases:

| Stored MessagePack bytes | Meaning | MsgPack view |
|---|---|---|
| `d3 ff df ff ff ff ff ff ff` | -9007199254740993 | -9007199254740992 |
| `cb 80 00 00 00 00 00 00 00` | float64 negative zero | `0` |
| `cb 7f f0 00 00 00 00 00 00` | positive infinity | `null` |
| `cb 7f f8 00 00 00 00 00 00` | NaN | `null` |
| `d6 ff 00 00 00 01` | timestamp extension, one second after epoch | `{}` |

**Expected:** An inspection/copy tool must retain the exact integer and distinguish non-JSON scalar values. A timestamp is not an empty object; infinity and NaN are not null. Decoded output should clearly state its representation where JSON has no corresponding type.

**Minimal fix:** Enable `useBigInt64` and render bigint tokens without routing them through Number. Add explicit handling for negative zero, non-finite numbers, timestamps and binary/extensions, using an unambiguous typed representation where necessary. Do not simply stringify BigInt as a JSON string and silently change its type. Keep raw-byte copy available alongside decoded copy.

**Evidence:** [Rounded integer](<research-dir>/review-w3/m1-msgpack-rounded.png), [Timestamp becomes object](<research-dir>/review-w3/m1-msgpack-timestamp.png), [Infinity becomes null](<research-dir>/review-w3/m1-msgpack-inf.png); `review-w3/matrix.json` records native copied map text for every role; `review-w3/supplement.json` records each scalar and its unchanged raw-byte Console reply.

**Regression needed:** uint64/int64 beyond 2^53, negative zero, infinities, NaN and timestamp extensions, including clipboard output. The existing `format.test.ts` MessagePack case contains only small ordinary numbers.

## Medium findings

### M1 — Frontend display limits silently truncate “Copy value” and “Copy result”

**Source:** `apps/web/src/lib/format.ts:112` slices formatted JSON/MessagePack at 100,000 characters without metadata. `apps/web/src/components/ValueViewer.tsx:161` copies that sliced text. `apps/web/src/components/Reply.tsx:81` independently slices string replies, and `apps/web/src/components/ConsoleResult.tsx:600` copies the resulting transcript text. `apps/web/src/components/ui.tsx:394` also silently cuts individual Tree strings at 10,000 characters.

**Repro:**

1. Seed `rcw3:20261023:long-json` with `'{"big":"' + 'x'.repeat(120000) + '","end":9007199254740993}'` (120,033 UTF-8 bytes). This is below the configured full-value cap.
2. Open it in Keys; choose **Load full value**, then **JSON**.
3. Click **Copy value**, paste, and try parsing the pasted text as JSON.
4. In Console run `GET rcw3:20261023:long-json`. Click **Show all 100,000 characters**, then **Copy result**.

**Observed:** JSON copies exactly **100,000 characters**, ending inside the long string. It is invalid JSON, with no remaining “preview truncated” or formatter-cap notice. The full backend reply was successfully loaded. Console's “Show all” and Copy likewise stop at exactly **100,000 characters**, with neither the end of the value nor its closing quote. The backend returned all 120,033 value bytes. Tree's long string display is shorter again, without a per-string omission marker.

**Expected:** Display budgets remain bounded but are explicitly labelled. “Show all” must not imply completeness for a second, silently cut representation. A normal full-value/result copy should retain the bounded backend payload, or the action should explicitly say **Copy preview** and offer a full-byte alternative.

**Minimal fix:** Separate clipboard/source data from the displayed slice. Carry a frontend truncation flag and omitted count through every formatter and transcript representation. Make capped output and disabled/unavailable full copy apparent. Keep existing memory/DOM safety limits.

**Evidence:** [Unmarked JSON cut](<research-dir>/review-w3/m2-silent-json-cap.png), [Console after Show all](<research-dir>/review-w3/m3-console-copy-truncated.png), `review-w3/supplement.json` (`copy-long`) and `review-w3/fidelity-extra.json` (`long-full-console-copy`, with native clipboard lengths).

### M2 — Collection value inspector discards the server's truncation flag

**Source:** `apps/web/src/components/KeyContent.tsx:137` stores only a `Bin` in `inspected`; `:168`–`:172` opens cells without completeness metadata; `:523` constructs `<ValueViewer value={inspected} />` with the default `truncated=false`.

**Repro:**

1. Seed a hash field with `'{"a":1}' + ' '.repeat(75000) + 'SECRET-END'`, under `rcw3:20261023:truncated-hash`, field `f`.
2. Open the hash. The parent inspector correctly warns that elements are truncated previews and hides full-byte mutations for that field.
3. Click the field's **value** cell to open the Value inspector.
4. Choose JSON or Tree, or use the automatically selected JSON view, and copy it.

**Observed:** The modal displays a clean, apparently complete `{"a":1}` document. JSON/Tree/MsgPack are enabled and there is no truncation notice in the modal. The full stored value has a suffix and is not a complete JSON document. The partial prefix happened to parse after the server cut it.

**Expected:** Completeness belongs to the bytes wherever they are displayed. The modal must preserve the preview warning and disable structured decoding exactly as the top-level string inspector does. Copy must be labelled as a preview.

**Minimal fix:** Store `{value, truncated}` (and available total-byte metadata) when opening a cell, and pass it into ValueViewer. Apply this to hash/list/zset/stream values and conservatively to set members when the API supplies only a collection-wide flag. Preserve field-name truncation state too.

**Evidence:** [Preview shown as complete JSON](<research-dir>/review-w3/m3-truncated-hash-json.png), `review-w3/probe.json` (`truncatedHash`, `truncatedModal`; `jsonDisabled` is false). This probe only read the truncated fixture; it did not overwrite it.

## Low finding

### L1 — Generated JSON paths for control-character property names are not valid RedisJSON paths

**Source:** `apps/web/src/components/KeyOperations.tsx:544` treats JSON string escaping as RedisJSON JSONPath escaping.

**Repro:**

1. Console: `JSON.SET rcw3:20261023:path-0 $ '{"a\nb":"target","a\\nb":"decoy"}'`.
2. Open Edit value and select the generated path **`$["a\nb"]`** for the property containing the actual LF.
3. Enter `"EDITED"`, Save.
4. Console: `JSON.GET rcw3:20261023:path-0`.

**Observed:** Redis rejects the generated path at position 2. The form remains open and the document is unchanged. CR, tab and NUL property names have the same failure. Quote and backslash property names in the same test did work and did not modify the decoy field.

**Expected:** Every offered path should address the property it represents, or explain that this property's name cannot be safely represented by the picker and direct the user to root-document editing.

**Minimal fix:** Use the supported RedisJSON path grammar rather than assuming JSON escaping is identical. Until all such names are representable through the path input, omit/disable those picker entries with a clear explanation; keep raw/root editing available. Test escaped controls against real RedisJSON rather than only checking generated strings.

**Evidence:** [Generated path error](<research-dir>/review-w3/path-escape-0.png), `review-w3/paths.json` (six independent property-name/decoy cases with Console readbacks). No wrong-property write was observed in this test.

## Ranked UX list

1. **Make editor binding visible and stable.** Show the key/type/path and opening snapshot together, and a clear “changed since this editor opened” state. Avoid silently changing an encoding caption or operation title under a retained draft (H1/H2).
2. **Name what Copy copies.** Distinguish raw bytes, decoded/formatted data and a capped preview; carry byte lengths and completeness into nested modals (H3/M1/M2). Invalid formatters currently still offer Copy value and copy an empty string.
3. **Make JSON Tree scalar types distinguishable.** It displays string `"null"` like null and string `"123"` like number 123 (`ui.tsx:390`–`:397`). Quote strings or add type cues; clipboard serialization already retains those types.
4. **Keep a labelled action path at 1024 px.** The dense console remains usable, but some toolbar labels reduce to shortcuts/icons. Retain concise text for copy/navigation and expose full names on focus. Examples: `populated-operator-dark-1024-console.png`, `operator-dark-1024-console.png`.
5. **Finish the previously deferred TimeSeries scale fix.** Two constant `-10` samples still produce an empty/mis-scaled plot while the table is correct (`Chart.tsx:93`–`:99`; `viewer-diagnostics-timeseries.png`). This was already recorded in round 2 and is not counted again above.

## Checked and fine

These statements describe the exercised cases, not a whole-product security certification.

- **Build and unit gate:** install and production build passed. Web Vitest **242/242 tests, 22 files**, passed (`review-w3/web-unit.log`). No source change was made to obtain that result. The full repository E2E suite was not rerun; guarded independent browser drivers held the machine-wide E2E lock.
- **Ordinary JSON numeric fidelity:** plain string JSON containing `9007199254740993`, `1.2300e+42`, `-0`, escaped Unicode and nested objects retained its numeric tokens in the tested JSON/Tree and clipboard paths. RedisJSON itself normalizes document formatting; submitted raw editor text and returned server bytes were treated separately. The newly found MessagePack path is H3.
- **Binary and control bytes:** binary string values, NUL, BOM and CRLF were tested through Text/Hex/Base64, the UTF-8/Base64 editors and CLI/Workbench replies. Existing strings selected Base64 editing when CR required it, and ordinary edits kept TTL with KEEPTTL. Binary hash field names survived inline value writes: the verified value was `00ff0d0a`, including the trailing CRLF. See `matrix.json` and `fidelity-extra.json`.
- **Key identity:** BOM, plain and zero-width keys stayed separate. A confirmed deletion of the BOM key preserved the plain and binary names; a later selected bulk deletion removed exactly those remaining fixtures. A key with a 1,526-character name was found using a short prefix and read correctly as every role. Exact patterns longer than the API's 512-character limit were clearly rejected. RTL override/zero-width/BOM display was escaped; underlying keys remained byte-distinct.
- **Collections:** inspected binary hash fields, duplicate list values, set members, sorted-set `-inf`/`inf` and exponent scores, and stream IDs containing components above 2^53. Tested inline hash/list/score writes read back correctly. The score `1.2e+31` was submitted as text; no frontend Number conversion was needed. Stream IDs stayed exact strings in inspector, group/pending view and Console/Workbench replies.
- **List regression fix:** refreshing `[A,B,C]` after an LPUSH closed an open draft at index 1 and issued no LSET. A duplicate-value displacement can still retain the draft when the bytes at the index are equal; this is not a guarantee of occurrence identity. The existing removal control accurately says **Remove first matching list value**. Neither this nor the documented absence of atomic list compare-and-set is presented as fixed.
- **Rename/TTL/bulk operations:** operator and admin renamed fixtures with RENAMENX behavior, verified the old name was absent and the destination retained the value, set a 2,147,483,647-second TTL, and confirmed selected-key deletion. Separate one-second expiry and PERSIST checks returned TTL `-2` and `-1` respectively. BOM/binary deletion checks compared exact names, not displayed text.
- **Guided:** operator/admin executed string set, TTL, counter increment, stream append, set/zset addition and publish tasks. Exact previews and returned/readback values are in `matrix.json`. The viewer's write task was disabled. Find and Inspect also ran successfully for all three roles (`final-browser.json`); the blank Find-pattern explanation was inspected. JSON/Tree/Hex/MsgPack are viewing formats, not independent writable editor modes; the actual writable modes are UTF-8/Base64 and the JSON document/path editor.
- **Console and Workbench:** binary SET/GET scripts round-tripped `00 ff 0d 0a` as `AP8NCg==`; JSON GET replies kept token text and stream IDs. Workbench returned per-command replies. Session drafts/results stayed out of persistent browser storage in the checked flows. Long-string transcript/copy completeness is the exception in M1.
- **Access/session behavior:** viewer mutation and admin-list requests received 403; write controls were absent/disabled. Logout followed by direct navigation to a database returned to sign-in. Persistent storage held only the theme/database preference, sessionStorage was empty, and the session cookie was not exposed to page JavaScript. This round did not repeat the earlier SQLite idle-expiry timing test.
- **Remote-6390:** all three roles saw the read-only shell/effective viewer behavior; entering SET disabled Run and sent no write request. DBSIZE ran as a read. Browser request guards permitted only the exercised read routes/commands there. Screenshots: `viewer-remote-readonly.png`, `operator-remote-readonly.png`, `admin-remote-readonly.png`.
- **Real-shaped snapshot:** each role scanned and opened an existing large JSON cache value; it rendered its document without a frontend exception. No application value on the copy was changed. The snapshot at review time was small; the 28–40 ms scan measurements in this run are not a new 7.5k-key performance qualification.
- **Diagnostics/admin/account:** all roles exercised memory analysis, Pub/Sub receive/stop with BOM/CRLF/NUL text, large-ID stream group/pending reads, Search results preserving numeric field text, TimeSeries tables and slowlog reads. Operator/admin acknowledgement was checked with XPENDING. Admin additionally opened clients, started/stopped its own five-second profiler, and inspected local-user and audit pages. The palette opened and dismissed from Account. Search's scratch index was dropped afterward. The negative TimeSeries plot is the already deferred issue noted above.
- **Themes/layout/CSP:** Overview, Keys, Console, Workbench, Guided and Diagnostics were visited in light/dark at 1024/1440 for each role. Additional populated JSON/hash inspectors and Console/Workbench transcripts were captured in those combinations (`visual-populated.json`, `populated-*.png`). Inspected screenshots show usable layout and persistent database/role framing. The captured browser runs reported no uncaught page errors; the matrix's collected CSP violations were empty. This is Chromium/macOS evidence, not physical Windows/Linux keyboard or screen-reader qualification.

## Test gaps and limits

Add regression cases for H1/H2/H3 and the two completeness bugs before the next review. Current round-2 tests cover list displacement, standalone CRLF editors and JSON numbers separately; they miss changing a draft's encoding, changing its source type, JSON-array displacement, MessagePack int64/scalar conversion, and preview metadata crossing a modal boundary. A successful small-value formatter test does not prove large-value copy completeness.

No production/staging-tagged database was added to the requested dev configuration, so production reason/typed-name framing was not newly qualified. No real screen reader, non-macOS operating system, browser other than Chromium, exhaustive command-key grammar, or new idle-timeout race campaign was run. No FLUSH, existing client kill, shared slowlog reset or source modification was performed.

## Cleanup

Cleanup completed; verification is recorded in `review-w3/cleanup.json` and `review-w3/cleanup.log`. Deleted **54** exact byte-prefix fixtures from 6411 and verified **0 remain** on 6411, 6410 and 6412. The scratch search index is absent. The source diff was empty before worktree removal. Stopped the restarted review server by PID **54991**; its pnpm parent **54978** exited, and port 4700 is free. The earlier review server was already gone at the continuation. Released the review lock, removed the detached worktree, and removed its temporary server data directory. Screenshots, drivers, logs and this report remain under `<research-dir>`. No other server or worktree was stopped or removed.
