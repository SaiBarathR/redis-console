# Independent web review: round 2 implementation

Scope: `apps/web` on `feat/web`, starting at `2b5ae37`. No direct edits to `apps/server` or `packages/shared`; backend changes arrive only through the requested merges of `feat/server`. Nothing was pushed. Live servers use 4300 and the existing worktree-owned Vite server on 5173. No connection to 6380 and no write to 6390; `scripts/dev-setup.sh` was not run.

## Review fixes

- **M3:** JSON trees parse the full original bytes under the 4 MiB decoder cap. Text display limits no longer corrupt tree input. Tree copy includes the complete JSON. Structured formats are disabled for truncated previews; MessagePack range errors explain invalid/truncated input.
- **M4:** Login lands on an explicit database picker, even with production first or remembered. Only the last chosen database ID persists, under `rconsole.database`; it is ranked first on the picker. An unopened remembered database is not shown as the active workspace and starts no SSE. Account/admin pages retain the previous database navigation context.
- **M5:** Per-database Console/Workbench drafts, results, history and session snippets survive route changes in session-owned memory. Logout/expiry unmounts that store. Results/history never enter browser storage.
- **M6:** Kill, Destroy, slowlog reset, key deletion and element deletion use destructive styling and a target-naming server confirmation. Existing server rules guarantee 428 for these actions. Single-key deletion opens only that challenge, without a preceding local dialog. Identified `rconsole-*` client rows warn and disable Kill. Collection removals use `keyOperation`, so Redis error replies cannot become success messages.
- **L1/L2:** Removed the empty nonce placeholder; CodeMirror selects only a nonempty nonce. HTTP logout redirects are accepted only when the current app itself runs on HTTP.
- **L3/L4:** PHP detection requires a plausible serialization token. A zlib-looking header is shown as deflate only after a bounded local trial decode succeeds. The review's plain-text examples remain plain text. Truncated JSON/MessagePack decoders explain that full bytes are required.
- **L5:** Replaced `qrcode` and its dependency tree with exact-pinned, zero-runtime-dependency `qrcode-generator@2.0.4`. Only `addData`, `make`, `getModuleCount` and `isDark` are consumed; the app paints the matrix onto canvas with a four-module quiet zone. No HTML/SVG string helper is called. The inspected source contains the MIT notice, Copyright (c) 2009 Kazuhiko Arase, in `dist/qrcode.mjs`; no vendored copy was introduced. Source review covered the matrix path and absence of network/dynamic-code/DOM sinks; this is not a cryptographic audit. `pnpm audit --prod` reports no known vulnerabilities.
- **L6:** Bulk deletion starts with an empty scoped pattern and an editable type. Pure wildcards are refused. Preview performs only a read-only SCAN page; a separate **Review & delete** action obtains the server's fresh impact challenge. Changing the draft invalidates an in-flight preview. Completion reports `Deleted N of M scanned`.
- **L7:** Removed the frontend's hard-coded prod exclusion. The backend decides allowed profiler environments and its refusal is visible. A default-on filter hides known Redis Console client addresses. A capability flag still needs a contract addition.
- **L8/L9:** Binary names use printable bytes plus `\xHH` escapes. Copy result uses redis-cli text; Copy JSON is secondary. An empty command has a neutral badge; destructive rules show a red confirmation badge.
- **L10/L11:** Guided inspection previews the actual metadata and type-specific bounded read sequence and renders `KeyContent`. Publish results report subscriber counts. Overview labels its sum as all logical databases, formats TTL durations, and uses whole-second chart ticks. Fetch-based SSE exposes HTTP 429 admission reasons and bounded stream/protocol errors. Server error messages escape invisible controls. Nested challenge autofocus warnings are avoided. Key rows are 34 px, with sorting and a no-expiry filter.

The latest authorized backend merge removed the old key-addressed GET routes. The frontend now consumes the documented **M2** POST-body reads for keys, scans, streams, TimeSeries and channel discovery, and requests a fresh single-use Pub/Sub subscription ID for every listen attempt. Only the opaque ID enters the SSE URL. There is no legacy URL fallback. `keyToParam` remains solely in memory for React/query IDs.

## UX and feasible parity

- Default chronological, scrolling redis-cli transcript with numbered arrays, quoted strings, `(integer)` and `(nil)`, plus a tree/table toggle and SCAN continuation explanation.
- Argument signatures highlight the current argument; autocomplete offers documented subcommands and recently scanned UTF-8 keys held in memory.
- SCAN reply keys open the key browser; key details prefill the appropriate console read command. Copy as code offers node-redis, ioredis and Spring Data examples.
- Inline hash values, list indices and zset scores; score updates use `ZADD XX`. Truncated elements cannot be edited from incomplete bytes. The formatting inspector remains available beside edits.
- Java class descriptor name and signed serialVersionUID extraction only; no deserialization. Numeric epoch seconds/ms and stream IDs gain timestamp displays with raw hover text.
- Read-only interpretation labels for BullMQ, Sidekiq, Spring Session and Socket.IO namespaces, with the appropriate inspection command.
- Field HTTL/HEXPIRE controls through the policy-gated CLI; JSON path selection/editing through the existing typed operation; bounded string/JSON file import through audited write endpoints.
- Loaded-page sort by name/type/TTL/size, no-TTL filter, selected-key deletion, and UTF-8 selected-key TTL batches (at most 100 commands; partial execution is explained).
- Per-database Workbench session snippets (memory only, up to ten), key-detail auto-refresh selection and relative TTL countdown, session-expiry warnings refreshed after existing API activity rather than by keepalive polling, and disabled cards explaining admin/module requirements.
- Search schema fields remain visible; query Explain and Profile use the existing policy-gated CLI and surface denials without bypasses.

## Deliberately left for follow-up

- **M1 is now rendered** (round 3): see `IMPLEMENTATION.md`.
- Role-enforced, separately audited file export, durable server snippets, explicit profiler/ACL capability flags, configured logical DB index metadata/switching, and per-node cluster/sentinel APIs require backend/contract support. The Overview currently labels its key count accurately as an all-logical-DB total.
- Collection pages and structured displays retain their explicit caps; binary names are not offered as textual autocomplete. TTL batches use sequential workbench execution and are not atomic.
- Verification is Chromium on macOS and laptop layouts; Safari, Firefox and physical mobile devices were not qualified.

## Verification

See the round 2 verification record in `IMPLEMENTATION.md`. Tests cover hostile data, real Keycloak/local auth, binary values, JSON over 100 KB, JSON paths, file import, inline edits, field TTL, query explain/profile, own-client Kill prevention, transcript/history retention, scoped read-only preview, exact confirmation inputs, opaque Pub/Sub subscriptions, stream admission refusal and storage boundaries. The live guard blocks database mutations outside `sandbox-e2e` while allowing only the documented read POST endpoints elsewhere; URL checks reject sensitive parameter names. Generated screenshots and logs remain gitignored under `qa-results/` / `qa-results-*.log`.
