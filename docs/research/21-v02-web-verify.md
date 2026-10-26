# Redis Console v0.2 — web fix verification (round 5)

Verifying the fixes for `17-v02-web-review-final.md` (M1, M2, L1, L2) on `release/v0.2` @ `881c181` (fix commits `f4c341e`, `2b02273` included), 24 October 2026. Read-only worktree `redis-console-wt/review-w5`; server :4700, data dir `/tmp/rc-review-w5`, QA accounts via `scripts/qa-accounts.mjs`. Chromium (Playwright, headless) as qa-operator. Writes only to sandbox-e2e (6411) under prefix `rcw5:`. Drivers: `review-w5/drivers/`, outputs `review-w5/*.json|png`.

Clipboard is read through a native `paste` event into an injected textarea (`clipboardData.getData('text/plain')`), because the app's Permissions-Policy blocks `navigator.clipboard.readText()`. Byte comparisons tokenize the copied text with the shared `tokenizeCommandLineBytes` and compare hex with the fixture bytes.

## Original findings

Fixture keys/values (sandbox-e2e): leading BOM, ZWSP, CRLF, NUL, RLO (U+202E), quote/backslash, binary `FF 00 80` (value `FF 00 0D 0A 80`). `verify.json`.

| ID | Status | Evidence |
|---|---|---|
| M1 Console shows `﻿`; re-run hits other key | **Fixed** | For all 7 keys: SCAN reply and Copy result show `"\xef\xbb\xbfrcw5:k:bom-"`, `"…a\xe2\x80\x8bb"`, `"…a\r\nb"`, `"…a\x00b"`, `"…\xe2\x80\xae…"`, `"…\xff\x00\x80"`. Pasting the copied token after `TYPE ` returns `"string"` and the request body tokenizes to the fixture key bytes. GET → Copy result tokenizes to the exact value bytes. Copy as code, the Re-run button and history ↑+Enter all send the exact key bytes. The key link opens the right key, and Copy key name is exact (`m1-*`, `keylink-copy-name`). |
| M2 Text "Copy value" copies escapes | **Fixed** | Clipboard equals the stored value for BOM, ZWSP, CRLF (`line1\r\nline2`), NUL, RLO and quote/backslash. The binary value is labelled **Copy as redis-cli** and copies `"\xff\x00\x0d\x0a\x80"`, which tokenizes to the exact bytes. Inspector Copy CLI (`GET "\xef\xbb\xbf…"`) is exact for every key (`m2-copy-value`). |
| L1 BOM JSON opens on failing JSON tab | **Fixed** | `"﻿{"a":1}"` opens on **Text**, shows `﻿{"a":1}`, Copy value enabled, clipboard exact (`l1-bom-json`, `v-l1-bom-json.png`). Choosing JSON by hand still says "Invalid JSON at character 0.", which is accurate. |
| L2 deleted key keeps value and live actions | **Fixed** | After an external DEL and Refresh key, the value block is gone and the only button is "Close and rescan" (`v-l2-stale.png`). TTL dialog open → external DEL → submit 100: the form is replaced by "This key no longer exists.", and EXISTS = 0 (`v-l2-ttl.png`). |

## Same-class sweep

Byte-exact in live tests: Console Copy result, Copy as code, Re-run, history ↑+Enter, the key link and Copy key name, inspector Copy CLI, and Copy value on the default tab. Exact by code reading only, not run live: Copy JSON (`JSON.stringify` of the Bin reply), Ctrl+R history selection (keeps the original line), and Guided preview copy (built with `cliArg`). Code review of the remaining `visibleText`/`displayBin` callers found display-only uses (labels, aria, conflict diff, Diagnostics, Admin). The two issues below are where text still reaches a request with different bytes.

### N1 (Medium): A raw BOM pasted unquoted into the Console or Workbench is dropped, so the command targets a different key

**Source:** `packages/shared/src/commands.ts:240` (`isSpace = /\s/`), also `:298`, `:302`, `:328` in `tokenizeCommandLine`. JavaScript `\s` includes U+FEFF, U+00A0, U+2000–U+200A, U+2028/2029, U+202F, U+205F and U+3000. redis-cli splits only on ASCII whitespace. The server tokenizes `{line}` with the same function (`apps/server/src/routes/cli.ts:119`, `:238`). This was not caused by the fix. It is pre-existing, but it is the M1 harm reached through a different copy: Copy key name and Copy names copy the raw UTF-8 name (`KeyInspector.tsx:110`), which is correct, and the Console then reads that name back differently.
**Repro (qa-operator, sandbox-e2e, `n1.json`):** `SET "\xef\xbb\xbfrcw5:n1:k" with-bom` and `SET rcw5:n1:k decoy`. Open the BOM key in Keys and click **Copy key name**. In the Console, type `GET `, paste, and press Enter. The request body is `{"line":"GET \ufeffrcw5:n1:k"}`, the echo is `GET rcw5:n1:k` and the reply is `"decoy"`. Then type `DEL `, paste, and press Enter. The prompt and the confirmation both show `DEL rcw5:n1:k`, because the BOM is invisible and the prompt does not mark it (`n1-console-confirm.png`). Confirm → `(integer) 1`. **The decoy was deleted and the BOM key still exists** (EXISTS 1 / 0). The Workbench behaves the same way. With NBSP the name splits instead: Copy key name of `rcw5:n1:a\u00a0b`, then `EXISTS ` + paste, counts `rcw5:n1:a` and `b` as two keys.
**Minimal fix:** in both tokenizers, split on ASCII whitespace only (`/[ \t\n\r\v\f]/`, the same set as C `isspace`). Add a round-trip test: `tokenizeCommandLineBytes("GET " + raw)` keeps U+FEFF/U+00A0/U+2028 bytes. Optionally, enable CodeMirror `highlightSpecialChars` in the prompt so a pasted BOM or ZWSP is visible before it runs.

### N2 (Low): The KEYS → SCAN suggestion re-encodes `\xHH` bytes as Latin-1, so the suggested SCAN matches nothing

**Source:** `apps/web/src/components/ConsoleAssist.tsx:137`–`:142` (`keysToScan`) takes `lex(line)[1].text`, which comes from the string tokenizer (`apps/web/src/lib/console/language.ts:49` → `tokenizeCommandLine`). That tokenizer turns each `\xHH` into one U+00HH code unit. `JSON.stringify` and the request then UTF-8-encode it again.
**Repro (`verify.json` `keys-suggestion`, `v-keys-suggestion.png`):** type `KEYS "\xef\xbb\xbfrcw5:k:bom-"`. This is exactly the form Copy result now produces after M1. The hint offers **Use `SCAN 0 MATCH ï»¿rcw5:k:bom- COUNT 100`**. Clicking it and running it sends the pattern bytes `c3 af c2 bb c2 bf …` and returns no key, although the key exists. The same happens for any non-ASCII `\xHH` pattern, such as `\xc3\xa9`. Bare NUL and CRLF patterns round-trip correctly. The result is read-only and misleading ("no keys").
**Minimal fix:** in `keysToScan`, reuse the original token source text verbatim: `const t = lex(line)[1]; const pattern = t ? line.slice(t.from, t.to) : "*";`. Alternatively, build it from `tokenizeCommandLineBytes(line)[1]` through `cliKey(binFromBytes(...))`.

Also noted (UX, not a defect): **Copy names** joins raw names with `\n`, so a name containing CR/LF cannot be told apart from two names in the copy (`copy-names`). Use the `cliKey` form for every name when any of them contains a control character.

## Regression

- **Checked edits**: I reran the round-4 matrix (`matrix.log`, 20/20 cases, sandbox-e2e, operator) and every case matches round 4. Unobserved and observed changes show the conflict with the correct reason, the current value and a diff. Save stays disabled. Overwrite writes the draft, Reload reopens (CRLF stays Base64), and a type change offers no Overwrite. Delete/Rename anyway work, a deleted key closes the editor, ABA saves, binary `ff000d0a80` round-trips, and there are no false conflicts on inf/1e+21/0.1, big ints or -0.0 (`m-operator-*-conflict.png`).
- **Keyboard only** (`console-operator-*.json`): the Console has focus on load, and Enter, ↑/↓ history, Ctrl+R, Tab completion (`HGETA`→`HGETALL`), F1 docs with Esc back to the prompt, Alt+↑/↓, Ctrl+C and `?` all work. A destructive DEL opens the confirmation, and Enter cancels it ("Nothing was run."). In the Workbench, Mod+Enter runs the script, per-line status is announced, WRONGTYPE is reported on its line, and stop-on-first-error marks later lines "not run".
- **Themes**: light at 1440 and dark at 1024 for the Console, Workbench, help overlay, confirmation and conflict dialog look right (`c-operator-*.png`, `m-operator-*.png`). There were no page errors and no CSP violations in any run. Remote-6390 received only the landing page's GET `/overview`.

## Housekeeping

- Writes went only to sandbox-e2e under `rcw5:`. Cleanup found and deleted 37 keys, leaving 0 that match `*rcw5:*`, including the BOM-prefixed and binary names (`cleanup.json`).
- No write was attempted on remote-6390, and nothing connected to 6380. Port 4000, port 4400 and `redis-console/data` were not touched. There were no source edits, no commits and no E2E run.
- I stopped my own server by PID (73085 and its wrapper 73062) and confirmed :4700 is free. The worktree was then removed.

## Release recommendation

**Ship v0.2: M1, M2, L1 and L2 are fixed.** N1 is pre-existing, but it can make a pasted DEL hit a different key, so fix it in the first patch, or before shipping if the change is cheap (a one-line whitespace set in the shared tokenizer). N2 can follow in a patch.
