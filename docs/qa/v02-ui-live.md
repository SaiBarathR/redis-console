# v0.2 UI live test record

Branch `feat/v02-ui`, live testing of the pages the UI agent owns: database landing, Overview, Key browser, Guided mode, Diagnostics, Audit log, Local users, Account, sign-in and the shell. The Console and Workbench belong to the console agent; the tour opens them as pages (render, read-only refusal on `remote-6390`) but does not test their features.

## Setup

| Item | Value |
|---|---|
| Server | `apps/server` from this worktree on **4200** (`RCONSOLE_PUBLIC_URL=http://localhost:4200`, `RCONSOLE_DATA_DIR=/tmp/rc-v02-ui-data`) |
| Config | `config/rconsole.dev.json`, plus a private copy (`/tmp/rc-v02-ui/rconsole.ui.json`, not committed) that adds two sandbox-backed simulations to check the frames the dev config cannot show: `ui-staging-sim` (6411 logical db 2, `staging`) and `ui-prod-sim` (6411 logical db 3, `prod`), and serves the SPA from a separate build directory so the e2e suite's `apps/web/dist` was never rebuilt under it |
| Databases | `snapshot` (7.5k keys), `sandbox-main`, `sandbox-e2e`, `remote-6390` (read-only, viewer max) |
| Browser | Playwright Chromium 1.64 (headless), 1440×900 unless noted; 1280 and 1024 for layout checks |
| Accounts | Keycloak SSO `viewer1`, `operator1`, `admin1`, `nogroup1`; local `qa-viewer`, `qa-operator`, `qa-admin` (password + TOTP) from `scripts/qa-accounts.mjs` |
| Harness | `apps/web/qa/v02-ui-live.browser.spec.ts` with `apps/web/qa/v02-ui-live.config.ts` (`cd apps/web && set -a && source ../../.env && set +a && npx playwright test -c qa/v02-ui-live.config.ts`). It writes `qa-results/v02-live/matrix.json` (gitignored) and the screenshots in `docs/qa/v02-ui/`. Every screenshot was also reviewed by eye, in both themes, during the work. |

## Safety

- The read-only upstream is guarded by the harness: only documented reads are allowed to leave the browser. The tour never sends it a write, even to prove refusal: every request to `/api/v1/databases/remote-6390/` is intercepted in the browser, and anything that is not a GET or a documented read (scan, key read, analysis sample, pub/sub listen, streams, search and timeseries reads, or a single read-only console line) is aborted before it leaves the browser and fails the tour. Server-side refusal of writes to read-only databases is covered by the e2e suite (`specs/api/readonly-prod.spec.ts`, `specs/ui/readonly.spec.ts`), which reaches 6390 only through its read-only RESP proxy.
- Writes on the sandboxes use the `uiqa:<run>:` namespace and are deleted again through the UI (selection delete and delete by pattern). Tour runs that stopped early during development left a few such keys; they were removed with Delete by pattern in the UI. A final scan for `uiqa:*` on every sandbox and the production simulation found none.
- No connection to 127.0.0.1:6380. Port 4000, the owner's `data/` and the owner's `admin` account were not touched.

## Page × role × database matrix

Final run of the tour on the last build (`6b2b233`), server on 4200 with `config/rconsole.dev.json`: **8 Playwright tests passed, 296 checks: 290 passed, 0 failed, 6 not applicable** (write flows for viewers and on the read-only database). No CSP or Trusted Types violation, page error, console error, 5xx response or blocked write attempt was recorded. The only HTTP errors were expected answers: `401 /auth/me` before sign-in, `403 search/indexes` for viewers and operators (FT._LIST not granted, see known gaps) and `428` confirmation challenges before every delete.

Legend: V viewer, O operator, A admin; ✓ passed, — not applicable. A "View" row means the page rendered with data or a state that names the next step, the database switcher showed that database, and on `remote-6390` the read-only edge was present. Diagnostics tool rows open the tool directly; `clients` and `profiler` are checked as not offered for viewer and operator and on the read-only database, and opened for admin on the sandboxes.

#### Keycloak SSO (viewer1, operator1, admin1; nogroup1)

| Page / feature | snapshot | sandbox-main | sandbox-e2e | remote-6390 |
|---|---|---|---|---|
| View · overview | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| View · keys | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| View · console | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| View · workbench | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| View · guided | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| View · diagnostics | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| Diagnostics · slowlog | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| Diagnostics · analysis | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| Diagnostics · pubsub | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| Diagnostics · streams | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| Diagnostics · search | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| Diagnostics · timeseries | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| Diagnostics · clients | V✓ O✓ A✓✓ | V✓ O✓ A✓✓ | V✓ O✓ A✓✓ | V✓ O✓ A✓ |
| Diagnostics · profiler | V✓ O✓ A✓✓ | V✓ O✓ A✓✓ | V✓ O✓ A✓✓ | V✓ O✓ A✓ |
| Keys · browse, inspect, formatters, keyboard | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| Keys · scan to end (7.5k keys) | V✓ O✓ A✓ |  |  |  |
| Guided · find and inspect | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| Guided · write task | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| Diagnostics · memory analysis | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| Diagnostics · pub/sub listen and publish | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| Keys · add, edit, TTL, rename, hash field, bulk TTL/delete, delete by pattern | V— O✓ A✓ | V— O✓ A✓ | V— O✓ A✓ | V— O— A— |
| Read-only marking and refused writes |  |  |  | V✓ O✓ A✓ |

| Global page | V | O | A | Notes |
|---|---|---|---|---|
| Sign-in (SSO) | ✓ | ✓ | ✓ | nogroup1: ✓ refused with the reason; no session |
| Database landing | ✓ | ✓ | ✓ | 4 rows; first row focused on load; arrows + Enter and 1–9 open databases |
| Admin · audit and users hidden | ✓ | ✓ |  |  |
| Account | ✓ | ✓ | ✓ |  |
| Admin · audit log with filters |  |  | ✓ | values never shown (published message absent) |
| Admin · local users |  |  | ✓ |  |

#### Local accounts (qa-viewer, qa-operator, qa-admin with TOTP)

| Page / feature | snapshot | sandbox-main | sandbox-e2e | remote-6390 |
|---|---|---|---|---|
| Keys · browse, inspect, formatters, keyboard | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ | V✓ O✓ A✓ |
| Read-only marking and refused writes |  |  |  | V✓ O✓ A✓ |
| Keys · add, edit, TTL, rename, hash field, bulk TTL/delete, delete by pattern |  |  | O✓ A✓ |  |

| Global page | V | O | A | Notes |
|---|---|---|---|---|
| Sign-in (local) | ✓ | ✓ | ✓ | password; password + TOTP |
| Database landing | ✓ | ✓ | ✓ | 4 rows; first row focused on load; arrows + Enter and 1–9 open databases |
| Admin · audit and users hidden | ✓ | ✓ |  |  |
| Account | ✓ | ✓ | ✓ |  |
| Admin · audit log with filters |  |  | ✓ | values never shown (published message absent) |
| Admin · local users |  |  | ✓ |  |


What the feature rows exercised:

- **Database landing**: rows for every configured database with live INFO figures, first row focused on load, ↓ then Enter opens the second database, 1–9 open by position.
- **Keys · browse, inspect, formatters, keyboard**: flat list, inspect the first key, Hex then Text tabs, tree keyboard (Home, →, ↓, End, Enter), select all loaded keys. Writers get Set TTL and Delete in the selection bar; viewers and the read-only database get Copy names only and no Add key.
- **Keys · scan to end**: see the next section (every key).
- **Keys · write flow** (operator and admin on each sandbox, SSO and local): add a JSON string (opens on the JSON tab), edit it to plain text, set a 900 s TTL (fuse reads 14–15 min), rename (inspector follows the key), add a hash and edit a field in place, add three keys, select them, Set TTL 600 for all, delete them through the server confirmation (typed name on `sandbox-e2e`), then delete the whole namespace by pattern (preview, review, typed confirmation).
- **Guided**: find keys with a pattern; the SET task runs for writers and is disabled with its reason for viewers and on `remote-6390`.
- **Diagnostics**: memory analysis report on every database; pub/sub listen everywhere, publish round trip for writers (publish disabled with its reason for viewers and read-only); clients table and a 4 s profiler session for admin on each sandbox. On `remote-6390` Search and TimeSeries explain that the module is missing.
- **Read-only marking and refused writes** (`remote-6390`, every role): hatched edge "Read-only database · All writes are disabled", Read-only and viewer badges in the context bar, Read-only in the status bar, no Add key / Delete by pattern / Edit / TTL / Rename / Delete, and the console keeps Run disabled for `SET` and sends nothing.
- **Admin**: audit log filtered to `operator1` (the published message text never appears), local users table and the Create user dialog; for viewer and operator the admin pages are not offered.
- **Sign-in**: SSO for `viewer1`, `operator1`, `admin1` with the right role; `nogroup1` refused with "no Redis Console role" and no session; local `qa-viewer`, `qa-operator` (password) and `qa-admin` (password + TOTP).

## Key browser on snapshot (7.5k keys)

Measured in the tour (Chromium, 1440×900, server on localhost, sandbox copy on 6412):

| Action | Result |
|---|---|
| First SCAN page (200 keys) to a usable tree | under 1 s; the tree opens on the namespace outline (folders with counts and memory) |
| Scan to end | every key (about 7.5k) in about 4 s (pages of 400, paced under the 10 scans/s limit). With 1,000-key pages it took 1.8–2.3 s but lost 5 keys (finding 12) |
| Open two folder levels with everything loaded | 84–105 ms |
| Flat list of about 7.5k keys | 40 rows in the DOM (virtualised, 26 px rows) |
| End + Enter on the last key | 137–165 ms to the inspector |

## Accessibility checks

- **Contrast**: every text token pair used on a surface (ink, graphite, delimiter, signal, danger, warn, ok, TTL soon and critical on pane, raised, canvas, hover and the selected-row tint), every type glyph on its 14 % tint, `--env-ink` on the staging and production fills and `--signal-ink` on the signal fill pass 4.5:1 in both themes (script over `tokens.css`); list checkboxes and row actions keep at least 3:1.
- **Reduced motion**: with `prefers-reduced-motion: reduce` the fuse's 1 s transition and the folder twisty's 120 ms transition compute to 0 s, and the spinner stops; the fuse still updates every second.
- **Keyboard**: the landing (focus on load, arrows, Enter, 1–9), the key tree (arrows, Home/End, PageUp/PageDown, Left/Right, Enter, Space with Shift, Escape, `/`), the split handle (arrow keys), formatter tabs (arrows, Home/End) and every dialog (Escape) were driven from the keyboard in the tour; focus is a 2 px signal ring, shown for keyboard focus only in the key list.
- **Widths**: every page was reviewed at 1440, 1280 and 1024. At 1024 the key browser toolbar wraps to two rows, the landing hides hit rate, clients and uptime, and the Overview stacks its two-column sections.

## Findings from live testing, all fixed on this branch

| # | Found by | Finding | Fix |
|---|---|---|---|
| 1 | tour, operator write flow | After editing a JSON string into plain text, the inspector stayed on the automatically chosen JSON tab and showed a parse error instead of the new value. | The automatic format follows the value; only a tab the user picks is kept (`288c143`, unit test). |
| 2 | code review during the tour | List rows used the latest SCAN page time as their TTL read time, so earlier rows' fuses jumped back up whenever another page loaded. | Each key carries the time its page was read (`288c143`). |
| 3 | tour, landing | 1–9 opened a database only when focus was inside the table; right after load the keys did nothing. | 1–9 work anywhere on the landing outside inputs and dialogs (`c442f29`). |
| 4 | screenshots, viewer on Search | FT._LIST denied by the viewer ACL was followed by "No search indexes on this database", which contradicted the error and left no way forward. | The pane says the list is not available to the role and the index can be typed (`c442f29`). |
| 5 | screenshots, staging/prod simulation | On a database configured with a logical `db` index, the overview, status bar and landing showed the whole server's key count as the database's. | Labelled "on this server" / "all dbs" when INFO lists several logical databases (`2e1bb26`). The API does not expose the configured index; see known gaps. |
| 6 | screenshots, staging/prod simulation | The lock icon of the production/staging edge sat on its own line above the label. | One inline row (`2e1bb26`). |
| 7 | contrast check (`tokens.css` pairs, both themes) | Key delimiters measured 4.08:1 and amber TTL text 4.34:1 on the selected-row tint; list checkboxes at 55 % opacity fell below 3:1. | `--delim` and light `--ttl-soon` adjusted, checkboxes and row actions at 80 % (`c442f29`). Every text token now passes 4.5:1 on pane, raised, canvas, hover and the selected-row tint. |
| 8 | screenshots, Overview | Min–max sparklines turned a 0.1 MiB memory wobble into a cliff. | Sparklines start at zero (`05e123e`). |
| 9 | screenshots, landing | Descriptions squeezed the figures into wrapping cells; the table overflowed at 1024. | Name column absorbs the width and truncates (`145c2e5`). |
| 10 | key browser on snapshot | The count line claimed more keys scanned than the database held (SCAN may examine a key twice). | "<n> examined of <total> keys" (`288c143`). |
| 12 | tour numbers on snapshot | "Scan to end" always loaded 5 keys fewer than the database held. Not expiry: the server's `keys/scan` route collects every key a SCAN iteration returns and then keeps the first 1,000 (`keyMeta(page.keys.slice(0, 1000))`), so a page that overshoots loses keys the cursor has already passed. With 1,000-key pages a few keys were lost per scan. | The UI requests at most 400 keys per page, which keeps a page below 1,000 (`keyscan.ts`). The server-side truncation is reported for the server owner; `apps/server` was not changed. **Update:** fixed on the server in `1984f93` (each SCAN call asks only for the room left; no truncation), so the 400-key page is no longer a workaround. |
| 11 | e2e in this worktree | The `ui` project's `testMatch` matched the absolute path `…/v02-ui/…/specs/api/…`, so all API specs ran twice and failed on their own leftovers. | Patterns anchored to `specs/` (`e895063`). |

## Known gaps

- **Key counts on databases configured with a logical `db` index.** INFO's keyspace is server-wide and the browser is not told which logical database a configuration uses, so the Overview, status bar and landing label such counts "on this server" instead of showing the database's own count. The key browser's count (DBSIZE through SCAN) is per database. A contract field (`DatabaseSummary.logicalDb` or a per-database DBSIZE in `overview`) would fix it; not added, to keep `apps/server` and `packages/shared` unchanged.
- **Search index discovery for viewers and operators** needs the sandbox ACL to grant `FT._LIST` (known server-side gap, e2e finding F-02). The UI now says so and accepts a typed index name.
- **No type mix on the landing.** It would need a SCAN of every database on every visit (see DESIGN §4).
- **Console and Workbench** are owned by the console agent; this tour only checks that they render and that the console refuses writes on `remote-6390` before sending.
- **Browsers.** Chromium only (Playwright). Safari and Firefox were not tested; the layout relies on `:has()` (Safari 15.4+, Firefox 121+).
- **The `/` shortcut in the key browser** is a local listener on that page, not part of the console agent's shortcut registry (not on this branch yet). It ignores inputs and open dialogs; it should move into the registry when the branches merge.

## Screenshots (not published)

Taken by the tour as `admin1` (so every control is visible) on the final build, in both themes; `<theme>-<width>-<page>.png`.
They were removed before publication because several show the private development dataset; the list records what was
checked.

| Page | 1440 | 1024 |
|---|---|---|
| Database landing | `light-1440-landing`, `dark-1440-landing` | `light-1024-landing`, `dark-1024-landing` |
| Overview (snapshot, live samples) | `light-1440-overview`, `dark-1440-overview` | `light-1024-overview`, `dark-1024-overview` |
| Key browser, namespace tree and inspector (snapshot) | `light-1440-keys-inspector`, `dark-1440-keys-inspector` | `light-1024-keys-inspector`, `dark-1024-keys-inspector` |
| Key browser, hash with Shift-selected range (sandbox-main) | `light-1440-keys-hash-selection`, `dark-1440-keys-hash-selection` | |
| Read-only database with the explain panel (remote-6390) | `light-1440-remote-readonly-explain`, `dark-1440-remote-readonly-explain` | |
| Diagnostics, memory analysis report (snapshot) | `light-1440-diagnostics-analysis`, `dark-1440-diagnostics-analysis` | |
| Diagnostics, slow log (sandbox-main) | | `light-1024-diagnostics-slowlog`, `dark-1024-diagnostics-slowlog` |
| Guided mode, inspect a value | `light-1440-guided`, `dark-1440-guided` | |
| Audit log | `light-1440-audit`, `dark-1440-audit` | |
| Local users | | `light-1024-users`, `dark-1024-users` |
| Account | | `light-1024-account`, `dark-1024-account` |
| Sign-in | `light-1440-sign-in`, `dark-1440-sign-in` | |
| Staging frame on the Overview, production frame with the typed-name and reason confirmation (private simulation config; the dialog was cancelled, nothing written) | `light-1440-staging-frame-overview`, `dark-1440-staging-frame-overview`, `light-1440-prod-frame-confirmation`, `dark-1440-prod-frame-confirmation` | |
