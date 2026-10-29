# Area B UI polish

Branch: `ui/admin`. Screenshots are local, ignored artifacts in `.qa/ui/admin/`; none are committed.

## Fixed defects

| Area | Observed problem and fix | Evidence in `.qa/ui/admin/` |
| --- | --- | --- |
| Audit | A more specific nowrap rule overrode command wrapping. A 60-key command produced an 8,853 px scroll extent and painted beyond its cell. Fixed column layout, bounded wrapping, and a three-line preview with an accessible full-command toggle preserve every supplied redacted argument. At 1024 px, the table is 1,120 px wide, starts at scrollLeft 0, and only its container scrolls. It fills wider workspaces. | `audit-before-1280.png`; `audit-after-{width}-{theme}.png` |
| Audit filters | Fixed-width filters left unused space and inconsistent control alignment. Fields now share the available row, wrap deliberately, and use consistent minimum control heights. | Same audit pair |
| Local users / account | Long display names could dominate the user table. Fixed table layout and wrapping bound names; account facts and recovery-code grids have shrinkable tracks. | `users-after-{width}-{theme}.png`; `user-editor-after-{width}-{theme}.png`; `account-after-{width}-{theme}.png` (no separate before image for these defensive bounds) |
| Landing | A single nowrap metadata row hid descriptions behind IDs, tags, and capabilities. Metadata wraps, descriptions get their own line, and truncated database names have a full-name tooltip. The table owns its scroll instead of nesting inside a scrolling landing page. | `landing-before-1024-light.png`; `landing-after-{width}-{theme}.png` |
| Diagnostic headers / tables | Slow-log controls could exceed a narrow tool header. Headers and action groups now wrap; the body owns vertical scrolling. Slow-log, profiler, and Pub/Sub columns allocate more space to commands/messages. The clients table has explicit widths and a deliberate 900 px minimum so addresses remain readable. | `slowlog-before-1024-light.png`; `clients-before-1024-light.png`; matching `*-after-{width}-{theme}.png` |
| Memory analysis | A long key's shared anatomy component retained preformatted whitespace inside fixed columns, causing 2,485/2,603 px scroll extents in 1,421 px tables. Scoped wrapping now keeps both populated tables at 1,421 px. | `analysis-populated-before-1920.png`; `analysis-populated-after-{width}-{theme}.png` |
| Pub/Sub | A 219-character subscribed channel expanded the listening panel's contents to 1,777 px in a 696 px panel. Shrinkable flex children and wrapping topic text now keep content within the panel; the full channel remains visible. | `pubsub-populated-before-1024-light.png`; `pubsub-populated-after-{width}-{theme}.png` |
| Charts / INFO | uPlot was given clientWidth including chart padding, overflowing by 4 px. It now receives content width, including on resize. INFO tables have bounded columns and wrapping values. | `overview-before-1024-light.png`; `overview-after-{width}-{theme}.png`; live geometry after fix: chart clientWidth 786, scrollWidth 786, canvas host 778 |
| Status bar | Overflowing metrics/session information was clipped with no way to reach it. The footer now has one horizontal scroll container and is keyboard focusable; its items do not shrink into each other. | Overview screenshots |

All after-image patterns above have widths **1024, 1280, 1440, 1920** and themes **light, dark**. The initial matrix covers audit, users, landing, overview, slow log, clients, Pub/Sub, analysis, profiler, account, and Preferences. Additional matrices cover the user editor, Streams, Search, TimeSeries, sign-in, populated memory analysis, and populated Pub/Sub. Clients images were refreshed after column tuning. No page-level horizontal overflow or tool-header overflow was found in the initial 88-screen geometry pass.

## Data and live flows

- Generated **310 command audit events through the app API**: 186 allowed, 62 denied, 62 errors. Included 60-key MGET commands, GET, TYPE, unknown commands, and WRONGTYPE errors. An initial unpaced attempt hit rate limits; the successful generation was paced. No rate limits or policy checks were weakened.
- Scratch fixtures: 7,000-field hash with 64-character hex fields and long JSON values; 3 MiB string; 250-character key; binary string; 100-member list/set/zset; stream. All writes used the assigned scratch database and prefix. Reads of other configured data used the app only.
- Ran memory analysis on the assigned prefix, including the large string, hash, long key, and binary key. Both populated result tables were checked at every requested width/theme.
- Subscribed and published a long channel/message through the UI, received one message, and stopped the subscription. Verified populated topic/message layout at every requested width/theme.
- Started the profiler, generated a long multi-key command through the app, exposed this console's own connections, observed **62 captured events**, and stopped capture. Screenshot: `profiler-populated-after-1024-light.png`.
- Overview live samples, charts, keyspace, server facts, and expanded INFO table were exercised. Latency is shown through the existing round-trip metric; there is no separate latency tool in this revision.
- Local user creation, role change, disabling/re-enabling, forced password change, TOTP enrollment/login, recovery-code copy/download/sign-in/regeneration, and low-code warning were exercised by the targeted existing UI specs. Viewer/operator restrictions were checked there too.
- Preferences, Account, sign-in and every diagnostic tool were opened in the screenshot matrices. Search/TimeSeries were checked in their unloaded forms; Streams was checked without creating shared consumer state.

## Validation

- `pnpm -r typecheck`: all four packages passed; final run repeated after the last CSS edits.
- Web unit tests: **553 passed, 43 files** (`pnpm --filter @rconsole/web test --maxWorkers=2`). The two new audit tests verify expansion/collapse preserves the final redacted argument and short commands need no toggle. Against the original Admin component, the long-command regression failed; against the fix, both passed.
- One default-concurrency run had **552 passed, 1 failed**: the unchanged key-browser test asserted an intermediate pending state after asynchronous user input. It passed with the new regression tests in an isolated run (**11 passed**) and in the full two-worker run. No unrelated source/test was changed. This timing failure is recorded rather than counted as a clean first run.
- Existing UI specs, attached to the assigned server, under the machine-wide lock: **9 passed** from admin/auth/diagnostics; **2 passed** from recovery-codes. Selected only cases compatible with the assigned database/prefix boundaries; did not run specs that seed other prefixes, alter shared Redis configuration, or kill clients. Logs: `e2e.log`, `recovery-e2e.log`.
- Production web build passed after final edits; `git diff --check` passed.
- Existing UI guards checked CSP/Trusted Types, uncaught errors, and response leaks in the 11 selected UI specs; all passed. No blanket claim is made about every screenshot navigation's console history (intentional initial 401/429 responses occurred during setup).

## Limits and integration

- Long configured database names/tags were addressed in layout code but **not tested with a modified server configuration**. Existing descriptions were checked. A configuration-driven stress case remains for integration QA.
- Forced onboarding/recovery states passed browser specs at the default test width; they were not screenshot-matrix-tested at all eight width/theme combinations. No authentication logic changed.
- Search/TimeSeries populated result states and stream consumer-group interactions remain outside this live pass. No unrelated implementation changes were made there.
- Shared-file edits: **none**. All style changes are in Area B-owned stylesheets. The new unit test is inside the owned diagnostics directory. No API/contract/test-ID changes and no new dependencies.
- Cleanup: scratch keys deleted; Pub/Sub and profiler stopped; own server stopped by PID; own lock traps released after each spec run. Other processes and locks were left alone. Temporary accounts and storage belong only to this disposable QA instance.
