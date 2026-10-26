# Live QA: vector-set inspector (v0.4 S2)

Branch `feat/v04-vectorset`, 2026-10-26, Chromium from the repository's Playwright (headless, 1440×900). Own instance on
port 4100 (`config/rconsole.dev.json`, built SPA, a temporary data directory). Accounts from `scripts/qa-accounts.mjs`
(`qa-viewer`, `qa-operator`, `qa-admin` with TOTP) and Keycloak `viewer1`. Fixture on `sandbox-e2e` under a
`claude:20261026:vsetqa:` prefix: a 4-dimensional vector set (default Q8 quantisation) of 240 members, half with JSON
attributes (`year`, `genre`), plus a member named `<script>alert(1)</script>`. The sandbox ACL users were regenerated
from the updated template first (vector-set commands have no ACL category; `ACL LOAD`, additive grants only).

| Who | What | Result |
|---|---|---|
| all four | Key browser → the set | Summary "Members 241 · Dimensions 4 · Quantisation 8-bit (Q8) · HNSW M 16 · Top layer 4 · With attributes 120"; 100 rows in byte order; attributes appear for the rows on screen. The hostile member is the first row, shown as text; no script element is created. |
| all four | Open `movie:006` | Attributes as an inert JSON view; embedding "4 of 4 values (VEMB)" with the note that a quantised set shows approximations; Copy vector; HNSW neighbours on layer 0 with scores, each a link to that member. |
| all four | Find similar, filter `.genre == "drama" and .year > 1980` | 10 results, every one a drama; the form previews the exact `VSIM … FILTER … FILTER-EF 1000`. Dark theme checked by screenshot. |
| qa-viewer, viewer1 | Write controls | None: no remove buttons, no "Edit attributes". |
| qa-operator, qa-admin | Edit `movie:010` attributes | Saved (compare-and-set); Redis has the new JSON. |
| qa-operator, qa-admin | Remove `movie:010` | The server's confirmation ("Remove 1 vector set member on E2E scratch", "Removes member …") appeared; cancelled, so the member stayed (VCARD 241). Removal itself is covered by the e2e spec. |
| all | Browser checks | 0 CSP or Trusted Types violations, 0 page errors, no request outside the console origin. The only console errors were the expected 401 of the signed-out `/auth/me` probe and the 428 that asks for the confirmation. |
| server | Audit | `vset.element`, `vset.attributes`, `vset.search`, `key.read` events for every session. |

Cleanup: the fixture deleted (0 `claude:20261026:*` keys left), the instance stopped by PID, its data directory and
QA accounts file removed.
