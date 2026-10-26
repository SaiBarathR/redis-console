# Live QA: Workbench geo map (v0.4 S4)

Branch `feat/v04-workbench-geo-graph`, 2026-10-26, Chromium from the repository's Playwright (headless, 1440×900).
Own instance on port 4500 (`config/rconsole.dev.json`, built SPA, a temporary data directory). Accounts from
`scripts/qa-accounts.mjs` (`qa-viewer`, `qa-operator`, `qa-admin` with TOTP) and Keycloak `viewer1`. Fixture: one geo
set of six European capitals on `sandbox-e2e` under a `claude:20261026:geoqa:` prefix.

| Who | What | Result |
|---|---|---|
| qa-viewer, qa-operator, qa-admin, viewer1 (SSO) | Workbench: `GEOSEARCH … FROMLONLAT 2.35 48.85 BYRADIUS 1200 km ASC WITHCOORD WITHDIST` and `GEOPOS … Berlin Nowhere`; Reply/Tree → Map | Two maps per session: 6 points with the radius outline (an ellipse on this projection, labelled approximate) and the land outline; GEOPOS 1 point plus "Not found: Nowhere". Enter on a focused point selects it and its table row; light and dark themes checked by screenshot. |
| qa-viewer, viewer1 | `GEOADD` in the workbench | Refused before sending: Run disabled, "GEOADD requires the operator role on this database (you have viewer)". Redis has no key. |
| qa-operator, qa-admin | `GEOADD` in the workbench | Written (key present in Redis afterwards). |
| all | Browser checks | 0 CSP or Trusted Types violations, 0 page errors. The only console error was the expected 401 of the signed-out `/auth/me` probe before sign-in. No request left the console origin while the map was shown (the SSO session's only other requests were the Keycloak sign-in pages). |

Cleanup: every `claude:20261026:geoqa:*` key deleted (0 left); the instance stopped by PID; its data directory and
QA accounts file removed.
