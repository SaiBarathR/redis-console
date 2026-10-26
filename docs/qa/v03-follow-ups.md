# Live QA: v0.3 follow-ups and the TOTP review fixes

Branch `feat/v03-follow` at `4c3b789` (code as of `2765ee1`), 2026-10-24, macOS, Node 24.14, Chromium from the
repository's Playwright 1.64 (headless, 1440×900). Server on **:4600** started exactly as the task asked
(`config/rconsole.dev.json`, `RCONSOLE_DATA_DIR=/tmp/rc-v03-follow`, built SPA). Accounts: `scripts/qa-accounts.mjs`
(`qa-viewer`, `qa-operator`, `qa-admin` with TOTP, `qa-admin2`) and Keycloak `viewer1`, `operator1`, `admin1`,
`nogroup1`. Writes only on `sandbox-e2e` (6411) under `qa:v03f:<run>:`. The dev config has no read-only database;
the read-only proxy assertions ran in the e2e suite instead (0 non-read commands).

## Results

| Item | Who, where | What was done | Result |
|---|---|---|---|
| 1 `trustProxy` | terminal, nginx 1.29 in Docker in front of a second instance on :4610 (`trustProxy: 1`, own data dir) and of :4600 (`false`) | Failed sign-ins through nginx (which appends `$proxy_add_x_forwarded_for`), with and without a forged `X-Forwarded-For`, and directly to the app port | Hop count 1 through nginx: audit `ip` = the client address nginx saw, also with a forged header. Directly to :4610 with a forged header: the forged address (the documented hop-count limitation: only the proxy may reach the port). `false` through nginx: every client is the proxy (127.0.0.1), the original symptom. |
| 2 Notices | `qa-viewer`, `qa-operator`, `qa-admin` | Account → About → *Third-party notices* | Opens `/THIRD-PARTY-NOTICES.txt` in a new tab (141,806 characters, starts with `THIRD-PARTY NOTICES`, contains the OFL text). Also verified on the production image: served as `text/plain; charset=utf-8` with `nosniff`, `/app/THIRD-PARTY-NOTICES` identical to the repository. |
| 3 Audit retention | data dir seeded before start with 4 rows aged 400, 401, 402 and 40 days; `qa-admin` | Server start | Startup prune deleted 3 rows (`system.audit.prune deleted=3 batches=1 before=2025-10-24T16:20:53.812Z retentionDays=365`, on stdout and in the table); the 40-day row stayed; *Admin → Audit log* shows the event. |
| 5 Dev loop | terminal, Chromium | `RCONSOLE_CONFIG=… RCONSOLE_PORT=4600 RCONSOLE_WEB_PORT=5176 RCONSOLE_DATA_DIR=… pnpm dev` | Server on :4600, Vite on :5176 proxying `/api` there; foreign `Origin` → 403; `viewer1` signed in through Keycloak and returned to the Vite origin as viewer, 0 page errors. Ctrl+C equivalent: every process of the run stopped by PID; the server released its lock. |
| 6 429 retry | `qa-operator`, `sandbox-e2e` stream with a group created in the inspector and 2 pending entries | Acknowledge one entry while the pending reads of the first 400 ms are answered 429 + `Retry-After: 1` (Playwright route, as on a slow machine) | 2 reads refused at +103/104 ms, retried at +1,323 ms; the list showed 1 pending; no error left on screen. Terminal: 24 concurrent typed reads → 23 × 200 and 1 × 429 `Retry-After: 1` "At most four data reads can run at once per user." |
| 7 Console race | `qa-operator`, `qa-viewer`, `sandbox-e2e`, catalog request delayed 2–2.5 s | `SET` typed and Enter pressed at once | Operator: badge "loading — Loading command info… The command runs as soon as it has loaded.", never "unavailable"; the SET ran once the catalog arrived (GET returned the value). Viewer: the same loading state, then the real refusal "Not run. SET requires the operator role on this database (you have viewer)." |
| TOTP M1 | terminal, :4600 running | The same start command again; `admin status`; `admin rotate-totp-key` | Duplicate exits **75** "a server is running on it (pid …): /tmp/rc-v03-follow is in use"; `server.lock` byte-identical (SHA-256 before = after); :4600 still healthy; `status` names the running server; rotation refused with **75**. |
| TOTP L2 | terminal, `qa-admin` and a temporary operator | Enroll, confirm, admin reset, enroll a new authenticator and confirm **in the same 30 s step**, then sign in with that code again | Confirm 200 after the reset (was 400); replayed code at sign-in 401. The temporary user was disabled and the data directory deleted. |
| Keycloak | `viewer1`, `operator1`, `admin1`, `nogroup1` | SSO on :4600 | viewer / operator / admin; `nogroup1` → `/login?error=oidc_no_role`, `/auth/me` 401; 0 page errors. |

Every Chromium session (`qa-viewer`, `qa-operator`, `qa-admin`) recorded **0 CSP or Trusted Types violations and 0 page
errors**. Server log: 0 errors; 3 `unavailable` warnings at the moments the harness closed its browsers mid-poll;
no key names. Not a product fault, but noted: the first driver run hit the 10-per-minute sign-in limit right after
`qa-accounts.mjs`, and reused a TOTP code from that script's step (replay protection); the driver now waits.

## Cleanup

6 keys `qa:v03f:*` unlinked on 6411 (0 left). Servers :4600 (node 97560) and :4610 (node 9947) and the dev loop
(launcher 22937 and children) stopped by PID; the nginx container `rc-v03-follow-nginx`, the image
`rc-v03-follow:notices` and the smoke container removed; data directories `/tmp/rc-v03-follow*` and `.qa/accounts.json`
deleted. No connection to 6380 or 6390; port 4000 and the main checkout's data were not used.
