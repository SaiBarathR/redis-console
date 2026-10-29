# Redis Console v0.4.2

A layout and usability release: about 40 defects fixed across every page, found by using the console on real data
sizes at 1024, 1280, 1440 and 1920 px wide, in the light and dark themes.

## Fixes

- **Collection inspector.** Expanding a field or value opens one full-width detail row, not two cramped panels whose
  controls collide. The value formats (Text, JSON, Tree, Hex, …) wrap as separate chips instead of running under the
  next column or scrolling out of sight. Toggles name their column ("Expand field", "Expand value"). Long field names
  end in an ellipsis, and numeric columns (sorted-set scores, time-series values) are no longer squeezed to a few
  pixels.
- **Audit log.** It opens at the left with every column visible. Short columns fit their content, the command takes
  the remaining width, and long commands collapse behind "Show full command". Times stay on one line, and identifiers
  such as `auth.totp.confirm` wrap only at a separator.
- **Streams.** The consumer-group inspector has labelled sections and empty states, and its row actions are compact
  and on one line. The lookup row lays out cleanly on narrow screens.
- **Diagnostics.** The slow log keeps each client address and port together, the Pub/Sub and stream tables stay in
  their columns, and chart time labels keep a clear gap at every width.
- **Console, Workbench, Search and the tools drawer.** Toolbars, the docked prompt and the split drawer no longer
  overlap or clip. Each view has one scroll container, and the index wizard's steps are aligned.
- **Everywhere.** Inputs, buttons and selects share one height, and long values have a single scrollbar. Probabilistic
  keys (Bloom, Cuckoo, count-min sketch, Top-K, t-digest) show readable names. Cancelling a confirmation is shown as a
  neutral status, not an error, and long display names in the sidebar end in an ellipsis.

The detailed list of defects is in [qa/v042-ui-inspector.md](qa/v042-ui-inspector.md),
[qa/v042-ui-admin.md](qa/v042-ui-admin.md), [qa/v042-ui-shell.md](qa/v042-ui-shell.md) and
[qa/v042-ui-final-pass.md](qa/v042-ui-final-pass.md).

## Upgrade notes

- No configuration, API or data changes. Upgrade by replacing the image (back up the data directory first, as
  always).
- Automation: the collection toggles are now labelled per column ("Expand field" / "Collapse field");
  [TESTIDS.md](../apps/web/TESTIDS.md) lists them.

## How it was checked

- Three area passes by GPT-6.1 Sol (inspector; admin, overview and diagnostics; shell, console and tools), then an
  independent pass over every page by Claude, then an automated sweep over 368 captures. The sweep flags overlapping
  boxes, text overflow, horizontal page scroll, breaks inside identifiers and text touching borders. Screenshots were
  reviewed by hand at 1024 px dark and 1440 px light.
- `pnpm -r typecheck` clean; web 559 passed; the full Playwright suite 704 passed, 0 failed, 0 flaky, 2 skipped.
- The test harness's read-only proxy now keeps local port probes (HTTP requests from other tools on the test machine)
  apart from violations. Every non-read command still fails the suite.
- Not verified live: graph result views (the local graph sandbox had no graph data).
