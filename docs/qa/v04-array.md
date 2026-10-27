# Live QA: v0.4 array inspector (S3, F24)

Branch `feat/v04-array` at `1a7f467` (operator and viewer tours repeated at `a7c28d1`), 2026-10-26, macOS, Node 24, Chromium from the repository's Playwright 1.64
(headless, 1440×1000). Own server on **:4200** with the built SPA and `RCONSOLE_DATA_DIR=/tmp/rc-v04-array`; config:
`config/rconsole.dev.json` plus two views of `sandbox-e2e` added in a private copy outside the repository,
`sandbox-e2e-ro` (`readOnly: true`) and `sandbox-e2e-prod` (`environment: prod`), so read-only refusal and the prod
rules could be exercised live. Redis 8.10.2. Accounts: `scripts/qa-accounts.mjs` (`qa-viewer`, `qa-operator`,
`qa-admin` with TOTP) and Keycloak `viewer1`, `operator1`, `admin1`, `nogroup1`. Writes only on `sandbox-e2e` (6411)
under `arr:20261026:`.

## Fixtures (sandbox-e2e, `arr:20261026:*`)

| Key | Shape |
|---|---|
| `dense` | 300 elements at 0–299: numbers (every third), `item-N`, JSON objects |
| `sparse` | 7 elements at 0, 1, 2, 1000, 123456789, 9007199254740993 (above 2^53) and 18446744073709551614 (the last index); length 2^64 − 1 |
| `large` | 50,000 elements `item-0` … `item-49999` |
| `binary` | invalid UTF-8 with NUL/CR/LF, a two-line value, 100 KB, 600 KB (above `maxValueBytes` 512 KiB), JSON with a big integer |
| `xss` | `<img onerror>`, `<script>`, `javascript:` payloads |
| `qa-<account>` | created through the UI by each writer and deleted by the tour |

## Results

One scripted Chromium tour per account (assertions on the DOM and Redis readback through `redis-cli`), plus targeted
checks. Every session: **0 CSP or Trusted Types violations, 0 page errors, no Redis data in any URL** (all array
requests are POST bodies: `key/read`, `array/range`, `array/search`, `array/aggregate`, `key/element`, `ops`). The only
browser console entries were the network statuses the flows provoke on purpose (401 before sign-in, 409 conflicts,
413 for the oversize element, 428 challenges, 403 for the read-only probe).

| Account | Role | Checks passed / failed |
|---|---|---|
| `qa-viewer`, `viewer1` (Keycloak) | viewer | 26 / 0 each |
| `qa-operator`, `operator1` (Keycloak) | operator | 44 / 0 each |
| `qa-admin` (TOTP), `admin1` (Keycloak) | admin | 44 / 0 each |
| `nogroup1` (Keycloak) | none | refused: "Your company account has no Redis Console role." |

| Area | What was checked | Result |
|---|---|---|
| Landing | Capability badges | "Arrays" shown for the Redis 8.10.2 sandboxes. |
| Summary and gaps | `sparse` | 7 rows, 4 gap rows ("⋯ 997 empty positions: 3–999" … "⋯ 18,437,736,874,454,810,620 empty positions: 9007199254740994–18446744073709551613"), indices above 2^53 exact, length 18,446,744,073,709,551,615. |
| Paging | `large` | First page 100 rows; Next starts at 100; Previous back to 0; Last starts at 49999; Jump to 25000; page size 1000; an invalid index (`-1`) refused in the form without a request. Keyboard: Tab from Next reaches the jump field, Enter jumps (to 31337); disclosures open with Enter. |
| Search | `large`, `MATCH item-4999` | "11 matches in indices 0–49999 (50,000 elements searched)". GLOB `item-1?` → 10; GLOB `item-*` with limit 25 → 25 and Continue resumes at 25; a match's index opens the page at it; RE is not offered. |
| Aggregates | `dense` | SUM 0–299 = 14850 over 300 elements; MAX = 297; JSON formatter in cells. |
| Binary and size | `binary` | Bytes shown escaped (`\x00\xff\xfe\x0d\x0a\x80bin`); the 100 KB element loads in full; the 600 KB element is refused with 413 (`maxValueBytes` + 64 on the wire). |
| XSS | `xss` | `window.__xss` unset, no `img`/`script`/`iframe` in the table. |
| Write controls by role | every key | Viewers: no row edit/delete, no append/set/delete-range, no generic Edit button. Writers: all present. |
| Create | key form, type `array`, values `a b c` | Created with ARINSERT (3 elements); creating it again: "This key already exists", nothing changed. |
| Edit and conflict | row editor | Edit saved (compare-and-set). With the editor open the tour wrote `theirs` from `redis-cli`: Save showed the conflict with the current value and the diff, nothing written; Overwrite anyway wrote over exactly that state. |
| Append | cursor 3 after the create | `d e` written at 3–4. After `ARSEEK key 0` (console-only): refused, "ARINSERT would overwrite 1 existing element there", element 0 unchanged. |
| Set at index | default index | Proposed the length (5, following the array as it grew; see "Found and fixed"), wrote `f` at 5. |
| Delete index | row bin | Confirmation previewing `ARDEL arr:20261026:qa-<account> 0`; element gone after confirming. |
| Delete range | 1–2 | Confirmation previewing ARDELRANGE with the note "2 elements existed in this range when it was counted"; both gone. |
| Read-only view | `sandbox-e2e-ro`, operator and admin | No write controls; a direct `array.delete` POST → 403 `read_only`; data unchanged. Audit: no allowed write on `sandbox-e2e-ro`. |
| Prod view | `sandbox-e2e-prod`, operator and admin | Row edit asks for the typed database name and a reason; saved after confirming; the audit event (`array.set`, `allowed`, `detail: checked`) carries the reason. |
| Console | `qa-admin` | `ARGREP … RE "(a+)+$"`: policy badge "blocked" with the RE hint, nothing sent (the server refuses it too: integration and e2e tests); `ARGREP … GLOB item-4? LIMIT 3` runs; `ARDELRANGE` and `ARDEL` open the confirmation with the exact command (cancelled; `large` still has 50,000 elements). |
| Auto refresh | `qa-viewer`, `large` page 2, refresh every 5 s | Another client changed element 100: the shown page was re-read 6 ms after the next key read (about 4 s) and showed the new value (see "Found and fixed"). |
| Redis ACL tiers | `redis-cli` as the sandbox users `rc-viewer` and `rc-operator` (`infra/redis/users.acl.template`) | Viewer: ARGET, ARGREP, AROP, ARINFO allowed; ARSET and ARDEL refused by Redis with `NOPERM`. Operator: ARSET, ARRING, ARDELRANGE and WATCH (compare-and-set) allowed. No template or INSTALL change needed; `-@array` withholds arrays from a tier (checked on a disposable Redis). |
| Dark theme | header toggle | Cells, gaps and the `arr` glyph readable, matching the list inspector. |

Response times through the browser session on the 50,000-element array (server, Redis and JSON included):
`key/read` 4 ms (17 KB), `array/range` 1,000 elements 5–6 ms (172–178 KB), `array/search` MATCH over 50,000
elements 4 ms, GLOB `*9*9*9*` with limit 1,000 5 ms, `array/aggregate` USED 2 ms, MATCH 3 ms.

Audit (server stdout): 382 array-related events in the session, all with key tags and byte counts only; none of the
fixture values, key names or the prefix appear in the server log.

## Regular expressions (decision record)

`ARGREP … RE` was measured before deciding. On Redis 8.10.2, simple patterns are fast (`RE b` over 1,000,000 elements
0.01 s), and the engine avoids classic exponential backtracking (`^(a+)+$` on 26 characters: instant), but the cost
per element grows with the pattern's states times the value's bytes, with no time limit inside Redis and no way to stop
the command: `(a?){200}a{200}` took 0.84 s and `((a?){50}){5}b` 1.3 s per 1,000 elements of 28 bytes;
`((.?){255}){4}b` took 26 ms per 28-byte element and 0.98 s for a single 1 KiB element (so about a minute for one
64 KiB element). Counted repetitions are capped at 255 by Redis but nest. A range, LIMIT or pattern-length cap
therefore cannot bound the time. Decision: the inspector offers EXACT, MATCH and GLOB only, the search route refuses
`re` (400), and `ARGREP … RE …` is blocked for every role in the console, workbench and imports (`argumentRule`).
GLOB was measured too: 8 or more `*` over 1,000,000 elements took 0.07 s, so it keeps the existing 8-wildcard cap
only for consistency.

Incident during the measurement: one of the probes (`(.?){255}(.?){255}(.?){255}b` over 50,000 elements) was sent to
the shared `sandbox-e2e` before the per-element cost was known and kept that Redis busy for about ten minutes; it
recovered on its own (restarting the container would have deleted other agents' keys). Every later experiment ran
on a disposable Redis 8 container started for this purpose and removed afterwards.

## Found and fixed during QA

- 20-digit indices overflowed into the value column: the index column now fits them.
- "Set value at index" kept proposing the length from when the panel opened, so after an append it pointed at an
  occupied index (the edit was still compare-and-set, so nothing was overwritten blindly). Index and range defaults
  now follow the array until the user types a value (`fix(web)` commit, with a regression test).
- With auto refresh on, only the summary and the first page were re-read: a later page stayed stale. The shown page
  now follows every completed read of the key (first attempt watched the props, which React Query keeps identical
  when the first page is unchanged; the live check caught it, the second fix listens to the query cache).

## Cleanup

All `arr:20261026:*` keys unlinked on 6411 (0 left). Server :4200 stopped by PID; the disposable Redis container
removed; `/tmp/rc-v04-array`, the private QA config and `.qa/accounts.json` deleted. No connection to 6380 or 6390;
port 4000 and the main checkout's data were not used.
