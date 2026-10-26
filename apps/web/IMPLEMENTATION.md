# Redis Console web implementation

## Feature status

Implemented: SSO/local login, TOTP login and local QR enrollment, forced password change, account settings; database/environment/read-only/effective-role shell, command palette, shortcuts, light/dark themes; overview and bounded SSE charts; virtualized SCAN namespace tree, configurable delimiter/type/pattern filters, continue scan, binary-safe key details and paging; string/hash/list/set/zset/stream/JSON/TimeSeries viewers and editors, unsupported module metadata; text/JSON/tree/hex/base64/MessagePack formatting, safe serialization detection and bounded gzip/deflate inflation; TTL/rename/delete, CLI copy/explanation, impact-confirmed bulk deletion; creation for all core types plus JSON, TimeSeries, Bloom, Cuckoo and vector sets; nonce-aware CodeMirror console/autocomplete/docs/policy/history and sequential workbench; nine guided tasks; slowlog, clients, memory analysis, Pub/Sub, stream groups/consumers/pending/ack, search, TimeSeries and a time-boxed profiler; audit filters/paging and local user management.

Database mutations invalidate dependent database views while retaining command documentation. Global account/admin navigation retains the selected database. Truncated values cannot be used for destructive member actions or replacement edits. String creation/rename collisions and typed Redis error replies are reported instead of false success.

## Verification

- `pnpm --filter @rconsole/web typecheck`
- `pnpm --filter @rconsole/web build`
- `pnpm --filter @rconsole/web test`
- `pnpm --filter @rconsole/web test:browser:contract` builds the production bundle and serves a strict-CSP fixture on **4300**; stop the live server first. Tests use intercepted contract fixtures, never Redis.
- `pnpm --filter @rconsole/web exec playwright test -c qa/live.config.ts` uses the real server on **4300**. Source the repository `.env` without printing it first. The local bootstrap case requires a fresh **app SQLite data directory**; it changes/enrolls that app's bootstrap account. Redis writes use unique `webqa:20261023:<run>:` names only on `sandbox-e2e`.
- For Vite qualification, `WEB_QA_ORIGIN=http://localhost:5173` runs the live suite through the dev UI; `/api` proxies to the server port (`RCONSOLE_PORT`, else the dev config's `server.port`; `scripts/dev-ports.ts`), so start that server with `RCONSOLE_PORT=4300` for these specs, or run the root `pnpm dev` with the same variable. The dev config's extra allowed origins permit these authenticated writes.

The real server was started from this worktree using the dev config, `RCONSOLE_PORT=4300`, `RCONSOLE_PUBLIC_URL=http://localhost:4300`, and a private gitignored `apps/web/.qa-data-*` directory. Browser checks use Keycloak `viewer1`, `operator1`, `admin1` and a local bootstrap admin; they cover the sandbox copy and read-only remote browsing, and assert that no non-GET request targets `remote-6390`. No connection was made to port 6380.

Production-build browser checks enforce `script-src 'self'`, `style-src 'self' 'nonce-…'`, and `require-trusted-types-for 'script'`. They exercise charts, CodeMirror, hostile HTML/bidi values, confirmation and locally generated QR codes, recording console violations and page errors. Zod runs in `jitless` mode before shared schemas initialize; this prevents even its caught dynamic-code capability probe from violating Trusted Types. No permissive Trusted Types policy or CSP weakening is used.

`TESTIDS.md` is the automation interface. Screenshots and browser artifacts are in gitignored `qa-results/`; they are not shipped. T3 preview snapshots timed out twice, so browser qualification used Playwright Chromium.

## Round 1 verification record (2026-10-23)

Build, typecheck and `git diff --check` pass. Vitest: **53/53** across five files. Playwright contract/CSP: **3/3**. Real-backend Chromium flows: **4/4**, covering local bootstrap/password/TOTP login, operator workflows, viewer/read-only remote access, and admin diagnostics/user management. Vite-proxy operator/viewer flows: **2/2**. Production fixture and real-backend checks recorded **zero CSP violations and zero page errors**. The actual backend response was also checked for the exact script/style/Trusted Types directives and an injected nonce meta tag.

The live operator flow additionally covers binary key and value bytes, hostile HTML/RTL/zero-width text, 90,000-character full-value loading, local gzip inflation, list offsets and exclusive newest-first stream paging. The admin flow covers pending entry acknowledgement, manual and automatic profiler stop, and vector writes. No browser non-GET request targeted `remote-6390`.

## Dependencies (all exact versions in package.json)

Requested stack: React/React DOM, React Router, TanStack Query and Virtual, CodeMirror State/View/Commands/Autocomplete/Language, lucide-react, uPlot, Vite/React plugin, TypeScript, Tailwind v4/Vite plugin, Vitest and Testing Library.

Additional runtime dependencies:

- `qrcode-generator@2.0.4` — zero-runtime-dependency QR matrix encoder; authenticator QR codes are painted on local canvas. MIT, Copyright (c) 2009 Kazuhiko Arase. Replaces `qrcode` and its CLI/PNG dependency tree.
- `@msgpack/msgpack` — bounded MessagePack decoding, without evaluating or deserializing Java/PHP objects.
- `zod` — same exact version as the shared contract, explicitly configured without JIT before contract evaluation to meet strict CSP.

Additional development dependencies: `@playwright/test` for real Chromium/CSP qualification; `jsdom` for DOM/component tests; `@testing-library/user-event` and `@testing-library/jest-dom` for realistic interactions/assertions; React/React DOM TypeScript declarations. Prettier 3.6.2 was used as a one-off formatting tool and is not a project dependency. No telemetry, remote fonts, runtime CSS framework or external data service was added.

## Limits and gaps

- The sandbox operator ACL denies vector writes; admin vector creation works. Viewer/operator search index discovery needs the ACL grants documented by the server owner. Denials remain enforced and visible.
- Unknown Redis module types are metadata/display-only. Oversized collection elements remain server-truncated; the console is the inspection path. JSON/string edits require an untruncated server-capped full value.
- Scripts run sequentially with per-command results; they are not transactional. Individual server runtime errors can leave earlier successful commands applied.
- Browser qualification here is Chromium on macOS, including laptop widths; Firefox, Safari and real mobile devices were not qualified.
- SSO logout follows the server-provided IdP end-session redirect after clearing local session state; Redis data is never used for navigation.

See `docs/CONTRACT-REQUESTS-web.md`: M2 body-only reads and M1 command previews are integrated; optional capability/ACL metadata still needs a contract. See `REVIEW-ROUND2.md` for the round 2 status.

## Round 3 (2026-10-23)

- **M1 preview**: every 428 dialog shows the server-built `preview` as text: a numbered, monospace, scrollable and keyboard-focusable list of commands (key/pattern arguments highlighted, arguments quoted when they contain spaces or quotes, server-cut values as `<prefix>… (N bytes)`, `+N more arguments`, `+N more commands`, total), bulk pattern/type, impact count (marked "at least" when the server count is incomplete) and sample. It names the database, a loud production badge and the effective role, keeps typed-name and reason fields, and keeps Cancel/Confirm visible. Client text no longer rewrites the server summary; an optional note (client name on Kill) is shown separately.
- **Contract**: 413/429/504 messages keep the server text and add the server hint or short guidance. Workbench lines skipped for reply/time budgets or an account change say "Not run: …"; an `unauthenticated` line or any 401 (API or SSE) returns to sign-in with the reason. `query()` refuses parameter names the server rejects. `<hidden>` client addresses show as "Address hidden".
- **QA**: `qa/tour.config.ts` + `tour.browser.spec.ts` visit every page as viewer, operator and admin, in light and dark, at 1440 and 1280 (read-only; fails on page errors, CSP violations, writes or 5xx). `SHOTS=/path,... SHOT_USER=... ` with the same config captures ad-hoc screenshots.

## v0.2 UI (branch `feat/v02-ui`)

Design reference: `docs/DESIGN.md` (tokens in `src/styles/tokens.css`, one stylesheet per page in `src/styles/`). Live test record: `docs/qa/v02-ui-live.md`.

- Shell: `.main-content` is a flex column; scrolling views keep a sticky toolbar (`PageTitle`, with an optional inline controls slot), split views render `.workspace` > `.split`. Theme is applied before first paint (`lib/theme.ts`); charts read colours from tokens and redraw on a theme switch.
- Shared primitives (`components/ui.tsx`): `Tabs` (roving focus), `Readout` + `Sparkline` (scale starts at zero), `Empty` (cause, details, next action), `ErrorState` with an optional retry, icon-only `CopyButton`.
- Signature element (`components/anatomy.tsx`): `KeyName` (key anatomy, prefix hidden but kept in the accessible text), `TypeGlyph`, `TtlFuse` (shared one-second clock, log scale).
- Key browser: `lib/keytree.ts` (tree rows with aria positions, collapsed start for large pages), `lib/keyscan.ts` (explicit SCAN state in session memory, 400-key pages, scan to end, local patches instead of replaying pages after writes), `components/KeyInspector.tsx`, `components/KeyContent.tsx`, `components/ValueViewer.tsx` (formatter tabs). `pages/Keys.tsx` re-exports `keyTree`, `KeyContent`, `readCommand` and `inspectCommands` for existing imports.
- Memory slots the console relies on keep their meaning: `${db}:selected-key`, `${db}:recent-keys`, `${db}:console:draft`.
- The key browser's `/` shortcut is a page-local listener (ignores inputs and open dialogs) until the shortcut registry from `feat/v02-console` is merged.
- Live tour: `qa/v02-ui-live.browser.spec.ts` (`npx playwright test -c qa/v02-ui-live.config.ts` against 4200 with the repository `.env` sourced).
