# Live QA: v0.4 review round 1 fixes

Date: 2026-10-27. Tree: `release/v0.4` with `fix/v04-review-r1` and the VSIM catalog fix (`3b8a41b`). Instance: a
local server on its own port and data directory with the built SPA and the generic sandbox config
(`config/rconsole.dev.json`). Database: `sandbox-main` (Redis 8.10.2). Browser: Playwright Chromium, headless.
Accounts: `qa-viewer`, `qa-operator`, `qa-admin` (TOTP), created by `scripts/qa-accounts.mjs` on that data directory.

## Data

Seeded under the prefix `qa:20261027:r1:` and deleted afterwards (0 keys left after each run):

- `a100`: an array of exactly 100 elements (one default page).
- `abig`: an array of 5,000 elements of 4 KiB (`a…`), the worst case for case-insensitive substring search.
- `vset`: a vector set of 40 members (`m00`…`m29`, `p0`…`p9`).
- `geo`: a geo set with a member named `WITHDIST` and one named `paris2`.

## Results (each role: 14 of 14 checks passed)

| Check | Finding | Viewer | Operator | Admin |
|---|---|---|---|---|
| `a100`: Next is disabled on the exactly full last page | L1 | pass | pass | pass |
| The search form states the 1,024-byte and 64-byte limits | H1 | pass | pass | pass |
| "To index" `abc`: the message is shown, the button re-enables as "Search" | M1 | pass | pass | pass |
| NOCASE 64-byte MATCH over `abig`: "0 matches in indices 0–816 (817 elements searched)", Continue offered (about 200 ms round trip) | H1 | pass | pass | pass |
| NOCASE 65-byte MATCH: refused with the 64-byte message | H1 | pass | pass | pass |
| Prefix `p`: "Members 1–10 starting with the prefix (the set has 40)" | L5 | pass | pass | pass |
| Prefix page of exactly 10 with page size 100: no next page | L1 | pass | pass | pass |
| Member `p0`: neighbours listed from "Layer 0", layer 0 open | gate fix (VLINKS) | pass | pass | pass |
| Console `VSIM … COUNT 2 TRUTH NOTHREAD`: badge "blocked" with the TRUTH/NOTHREAD hint, Run disabled | M2 | pass | pass | pass |
| Console `VSIM … ELE p0 COUNT 3 WITHSCORES`: runs and shows `p0` | M2, QA fix | pass | pass | pass |
| Workbench `GEOSEARCH … FROMMEMBER WITHDIST BYRADIUS 20000 km WITHCOORD`: the Map view is offered | L2 | pass | pass | pass |
| No page errors or console errors (other than the two expected 400 responses) | | pass | pass | pass |
| No CSP or Trusted Types violations | | pass | pass | pass |
| No Redis data in request URLs (all data in POST bodies) | | pass | pass | pass |

The first run found that every `VSIM` in the console showed "blocked" with Run disabled, although the server ran valid
ones: the console's command catalog classifies bare command names, and the M2 rule read a bare `VSIM` as unparsable.
Fixed in `3b8a41b` (see `docs/REVIEW-LOG.md`), then all three roles were rerun.

The server side of M2 (403 for `TRUTH`, `NOTHREAD`, `COUNT 30000`, `FILTER-EF 0` for viewer and admin) is covered by
`integration/vectorset.test.ts`. The type-conflict wording (L5) is covered by unit tests; it needs a key created
between opening and saving, which this flow does not stage.

## Cleanup

All seeded keys were deleted (0 left under the prefix after each run); the instance was stopped by its PID and its
data directory removed.
