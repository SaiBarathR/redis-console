# UI control anatomy audit (v0.4.3)

Branch `fix/ui-anatomy`. The owner found every select's native arrow sitting on its right border with no gap.
Page screenshots and between-element overlap checks had not caught it, because the defect was inside a control.
This round adds a permanent lint that measures inside every control and painted surface, and fixes what it found
and what a review of 2x crops of every control style found on top.

## Method

### Control anatomy lint

`tests/e2e/specs/ui/anatomy.spec.ts`, with helpers in `tests/e2e/lib/anatomy*.ts`, runs Chromium at device scale
factor 2. It covers widths 1024 and 1440 px, light and dark themes, and 87 page states per width and theme, so 348
measured states in total. Each state's scroll containers are swept: up to three per state, up to four steps each.

The lint measures every visible control: buttons, links with icons, inputs, selects, textareas, tabs, summaries,
badges, chips, tags, kbd, environment badges, type glyphs and checkbox labels. It also measures every element with
a visible border, an inset ring or a background distinct from what is behind it. Measurements come from
`getBoundingClientRect`, `Range.getClientRects` for text, SVG/img rects for icons, and computed padding and border.

| Check | Rule (CSS px) |
|---|---|
| `text-inset` | Text sits at least 6 from the left and right and 2 from the top and bottom of a bordered or filled box, and at least 2 from any single border. Content scrolled against a scrollport edge is exempt only on the axis it scrolls. |
| `input-inset` | Border plus padding of a native field is at least 6 / 6 / 2. A bare field inside a painted wrapper is measured against the wrapper. |
| `input-icon-overlap` | An icon or button drawn inside a field keeps 4 from the field's text area. |
| `select-padding`, `select-chevron` | Right padding is at least 22. The chevron is a themed background at least 6 from the right border. The text area ends at least 2 before the chevron. |
| `icon-inset` | Icons keep the same insets as text. |
| `icon-gap`, `icon-center` | An icon keeps at least 4 to its label and is centred on it within 1 (single-line labels). The same applies to a checkbox and the first line of its label. |
| `row-alignment` | Buttons, fields, selects and tabs on one flex or grid line have equal heights and centres (within 1). A transparent wrapper around a single control stands for that control. |
| `clipped-text` | Text whose ink runs past a clipping ancestor needs an ellipsis or line clamp. Hanging pre-wrap spaces do not count. |
| `text-overflow` | Text does not spill out of the box that owns it. |
| `control-overflow` | A control is not wider than its table cell. |
| `outside-gap` | A chip or control laid out as a flex or grid item keeps 4 to the painted text beside it. Text is hit-tested, so content under sticky bars or popovers is ignored. |
| `focus-ring`, `focus-clipped` | Every control reached by Tab shows a ring. The ring can be an outline, a signal-coloured box-shadow or fill, a pseudo-element, or a signal ring on a `:focus-within` ancestor up to five levels up. No ancestor's overflow may clip it; modal dialogs, fixed boxes and absolute containing blocks are respected. |

Each violation records the page state, a selector path, the nearest `data-testid`, the measured values and a 2x
crop. The spec fails on any violation outside the allowlist below. It also fails if any listed state cannot be
reached, or if any module type is missing.

### States covered

- **Pages:** landing; overview; diagnostics index, slow log and clients; audit; users; account; preferences;
  command palette (open and filtered); shortcut help.
- **Empty and error states:** an audit filter with no events; an unknown database.
- **Key browser:**
  - list, empty filtered scan, tree, selected rows;
  - every key type: short string, 3 MiB string, binary, a hash of 7,000 fields with 64-character names and
    300-byte JSON values, list, set, zset, stream with groups and pending entries, JSON, time series, bloom,
    cuckoo, count-min sketch, top-k, t-digest, array, vector set, geo, and a 220-character key name;
  - expanded hash and list rows, the value inspector and field TTL;
  - the dialogs: add key, set field, add multiple entries, string edit, edit conflict, TTL, rename, delete
    confirmation;
  - the wide inspector.
- **Console:** prompt, results, autocomplete, signature, suggestions, KEYS guidance, history search.
- **Workbench:** rich results (search table, series chart, profile plan, geo map) and the terminal view.
- **Guided:** tasks, a tutorial, and an import with its plan.
- **Search:** index detail, query results (table and JSON), a syntax error, and both wizard steps.
- **Diagnostics tools:** analysis report, Pub/Sub listening, streams with a group, time-series chart, profiler
  recording.
- **Tools drawer:** console, helper, and side by side.
- **Admin:** an audit row with its long command expanded, audit filters, the new-user dialog, the edit-user dialog.
- **Sign-in flow, in a fresh context:** sign-in, sign-in error, forced password change, TOTP enrolment, recovery
  codes.

### Contact sheets and visual review

The same run crops every distinct control style at 2x. Styles are deduplicated within each width, theme and group
by a computed-style signature, and large panels are cropped to their top-left corner. The crops are laid out on
labelled contact sheets of 24 tiles: one set per page or state, per width and theme. All 346 sheets were opened and
every tile reviewed for anything touching a border, cramped, misaligned, inconsistent in size or radius, clipped, or
oddly wrapped. The findings were checked against the live app before fixing.

### Data and safety

The test data is synthetic. Attached runs (`RC_E2E_ATTACH=1`) write only under the scratch prefix
`uiE:20261030:anatomy:<run>:` on the sandbox-e2e database and remove everything under it (and the search index)
afterwards. The harness run uses the disposable e2e Redis. A temporary admin user per width and theme exercises the
sign-in flow and is disabled afterwards. Evidence is written to the gitignored `.qa/ui/anatomy/<phase>/`.

## Lint counts

Counts are violations summed over all 348 states. The same element counts once per state it appears in.

| Check | Before | After |
|---|---|---|
| text-inset | 155 | 0 |
| row-alignment | 142 | 0 |
| select-padding | 24 | 0 |
| select-chevron | 24 | 0 |
| icon-center | 24 | 0 |
| focus-ring | 16 | 0 |
| icon-gap | 8 | 0 |
| icon-inset | 4 | 0 |
| input-inset | 4 | 0 |
| clipped-text | 4 | 0 |
| input-icon-overlap | 4 (detector false positives, since fixed) | 0 |
| control-overflow | added after the visual review; it found the search index name | 0 |
| outside-gap | added after the visual review; it found the key row's type glyph, 2.2 px from the name | 0 |

The "before" column is a run on the build that had GPT's 11 commits, including the first chevron fix. GPT's own
earlier measurements are in its commit messages.

## Defects fixed

| Concern | Before | After | Commit |
|---|---|---|---|
| Select text under the chevron | Tool-header selects (Slow log count and refresh, Pub/Sub format) had a local `padding: 2px 6px` that reset the base select's right padding to 6 px. The label ran 15 px under the chevron. | Right padding and chevron inset come from two tokens, `--select-pad-end` (28) and `--select-chevron-inset` (9), applied with priority. Compact selects set 22 / 6 instead. | `ad81733` |
| Mixed heights in one row | Slow log and Pub/Sub header selects were 26 beside 28 buttons. Scan footer buttons were 26 beside a 24 select. The console suggestion button was 24 beside a 28 hint. | All 28; the scan footer is 26 throughout. | `c9a5aeb` |
| Tag insets | Policy tags, landing database tags and capabilities: 5 left/right, 1 top. A topic chip without its remove button: 3 right. Wrapped audit outcome tags: 1 top. | Badge geometry (6 sides, 20 tall). The topic chip ends in 6 unless the button is there. | `49932e4` |
| Keep-expiry checkbox | 0 gap to the label, 2.5 off centre. | Shared checkbox label: 7 gap, centred. | `8d5986a` |
| Landing row focus | The link suppressed its outline. Focus showed only as a tint and a bar in another cell. | The row takes the 2 px signal ring. | `ced085e` |
| Docked console in the drawer | Side by side at 1024: the toolbar took 3 rows, Run wrapped, the transcript was 40 px with a half-cut line, and the last shortcut row was clipped by the pane. | Keys-only hints. The toolbar and shortcut row each take one line and scroll sideways in their own strip. Transcript: 111 px at 1024, 143 px at 1440. | `42c4c40` |
| Small insets | Autocomplete option: 1 top. Gutter marker: 5.7 from the border. Tag separator field: 5. Row icon in a pressed button: 5.5. | 2 / 6 / 6 / 6. | `5f3a0f0` |
| Key row type glyph | The grid column was hard-coded to 30 px while the glyph is 34. The glyph sat 2.2 px from the key name. | The column uses `--type-glyph-width`; gap 6. | `ebea204` |
| Index name over the Documents column | A nowrap name button was wider than its cell, and its last letter touched the count. | Shared name buttons wrap inside the cell (a local stream-groups override was removed). | `fe479f4` |
| Disclosure markers | Marker 0–2 px from tinted panel and notice edges, with no hit area. | Summaries get 2 px 6 px padding, a radius and a hover fill. | `33836a1` |
| Native file input and sliders | Unstyled "Choose File"; sliders in browser blue. | Button geometry for the file button; signal accent for sliders. | `1ac214a` |
| Unwanted wrapping | "needs confirmation" made a two-line tag. Stream entry IDs broke at the hyphen. The key list total sat alone on its own line. The lookup placeholder was cut mid-word. | One line each (ellipsis where it must shrink); a shorter placeholder. | `93c9599` |
| Sort headers | Landing sort headers had 0 padding, so the inset focus ring sat on the label. Key list headers had 4. | 2 px 4 px with a compensating margin; 6 px. | `1eef5dc` |
| Read-only lock | The lock icon on the landing page sat 3 px from "Read-only". | 4 px. | `6e69c03` |
| Column and row alignment | The import plan's "Line" header was left-aligned over right-aligned numbers. Wizard checkboxes sat 3–4 px above the centre of their row. | Numeric header; cells vertically centred. | `5f3b48d` |

The earlier commits on this branch (`8daaa65` through `05433a2`: the select chevron, switcher chevron, chips, tags,
row heights, focus inside clipped groups, type glyphs, previews, the expansion label and console hints) are
described in their commit messages. They are verified by the same lint.

## Allowlist

The list is in `tests/e2e/lib/anatomy.ts`. It has one entry, and that entry excuses one check only:

- **`mark` / `text-inset`:** a text highlight inside running text (history-search and grammar matches). Horizontal
  padding would move the highlighted characters away from their neighbours. It is not a control and has no border.

The earlier focus-ring entries for the landing link, the virtual key list, the split handle and the drawer resizer
are no longer needed. The landing row now draws the shared ring, and the detector recognises signal-coloured
box-shadow and pseudo-element rings.

## Not changed (reviewed, judged acceptable or out of scope)

- **Search index names:** long names in the narrow Index column at 1024 px now wrap inside the cell instead of
  overlapping, but they break mid-token.
- **Pub/Sub channel names:** they break anywhere. Breaking at `:` needs markup changes in the data cell.
- **Analysis table type labels:** module types show Redis type names such as `TSDB-TYPE`, which is a content
  choice.
- **Key hints:** their low-contrast grey is the existing hint style, a design decision outside this round.

## Validation

- `pnpm -r typecheck`: passed.
- `pnpm --filter @rconsole/web test`: 43 files, 559 tests passed.
- Anatomy lint, attached to an instance on the sandbox-e2e database: 20 of 20 tests passed (4 width and theme
  combinations × 5 groups), with 0 violations.
- The whole `specs/ui/` folder, run through the e2e harness under the lock (disposable e2e Redis, prefix
  `e2e:scratch:`): 275 passed, 2 skipped, 0 failed. The 2 skips are pre-existing conditional skips in other specs.
- The first harness run failed only the anatomy `pages` test, at all four widths and themes. The harness configures
  a read-only database, and on the landing page its lock icon sat 3 px from "Read-only". The fix is `6e69c03`; on
  the rerun the anatomy spec passed 22 of 22 and the whole folder passed as above.
- Cleanup: no keys or search indexes remain under `uiE:20261030:` on the sandbox-e2e database. The temporary users
  are disabled, and the instance was stopped.
