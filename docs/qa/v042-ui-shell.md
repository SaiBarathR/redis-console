# v0.4.2 UI polish — shell and tools

Branch: `ui/shell`. Scope: Area C. Presentation changes only; no API, policy, storage or test-id changes.

## Defects and fixes

| ID | Reproduction / before | Change | Evidence in `.qa/ui/shell/` |
| --- | --- | --- | --- |
| C1 | At 1024px, expand the rail and open Workbench. Toolbar actions shrink the title block until the reply toggle covers the title. | Keep the title's intrinsic width and allow the actions row to wrap. | `before-workbench-toolbar-1024-light.png` → `after-workbench-split-1024-light.png` |
| C2 | Open the tools drawer below Workbench. Its fixed-height editor consumes the available view; the results region measures zero pixels high. | Let the editor shrink while preserving its own scrolling and a minimum results region. Wrap script controls instead of overflowing them. | `before-workbench-split-1024-light.png` → `after-workbench-split-1024-light.png` |
| C3 | In the split drawer, Console toolbar controls overflow their half-pane and the dock leaves almost no results space. | Wrap toolbar and prompt controls, constrain long prompt/snippet labels, and bound toolbar/dock height with deliberate overflow so the result region remains usable. Wrap result metadata/actions and history controls. | `before-workbench-split-1024-light.png` → `after-workbench-split-1024-light.png`; `after-preview-split-1024-light.png` |
| C4 | Query a document with a 225-character field name and a long text value. A nonwrapping header makes the table 2,031px wide inside a 717px pane. A 420px results cap also creates nested vertical scrolling. | Wrap rich-table headers. Remove the vertical table height cap: the containing tool pane or transcript owns vertical result scrolling. Remove the Console key-link list's independent vertical cap as well. | `before-search-long-field-1024-light.png` → `after-search-long-field-1024-light.png` |

| C5 | At 1024px the sampled index schema compresses the Type selector to a single letter and wraps the No stemming option across several lines. | Preserve minimum schema/control widths and keep checkbox labels intact; the existing table wrapper provides horizontal scrolling. | `before-search-wizard-1024-light.png` → `after-diagnostics-search-panel-create-1024-light.png` |

Manual 1024px expanded-list check: all 300 long members produce a 24,070px transcript, with exactly one vertical scroll container in the result subtree and the prompt still inside the viewport (`after-console-expanded-300-1024-light.png`).

All four widths (1024, 1280, 1440, 1920) are covered in light and dark themes by the local Chromium layout matrix. It checks title/action separation, pane width bounds, preserved results height, long replies, history, palette and shortcut dialogs; tours Guided, tutorials, Import, Search query/indexes/wizard and Analysis. Screenshot names include width and theme. The split Console has separate scrollable controls and transcript regions; result lists have one vertical scroll owner.

Shared-file edits: **none**. Only `pages/Console.css`, `components/drawer/drawer.css`, and `styles/insight.css` changed.

## Validation

- Web production build and recursive typechecks pass.
- Web unit tests: 551 passed on rerun. The first run had 550 passed and one timing-sensitive failure in the existing lazy-metadata placeholder assertion in `Keys.test.tsx`; no changes were made to that unrelated test or its implementation.
- Existing UI specs: 36 passed under the machine-wide lock, attached to the assigned server. Selected Console, console-keyboard, pages and shell-v021 tests cover policy classification/refusal, autocomplete, history, all-role page loading, accessibility status, lazy shell loading and drawer sharing/resizing. No destructive tests or tests with unrelated fixture writes were selected.
- Local Chromium layout matrix: **8 passed** (four widths × two themes), zero captured page errors or CSP violations. Includes Guided lookup, Import plan and cancelled confirmation, Search query with long fields, sampled wizard and a completed Analysis job.
- Local layout matrix and screenshots: see `layout.spec.ts`, `layout-run.log` and `layout-results.json` in the ignored evidence directory. The matrix uses prefixed scratch fixtures: 7,000-field hash with 64-character names and JSON values, 3 MiB string, binary, a 200+ character key, long collection members, stream, Geo and a Search document with a long field name.
- Local harness setup failures were corrected: storage-state relative path, a mismatched history-control locator, and a lazy chunk invalidated by rebuilding during an in-flight run. The stable-server run uses a completed build.

## Qualifications and cleanup

- Graph has unit coverage, but no live graph fixture was created: the assigned scratch Redis is not a graph server and graph writes would exceed the assigned write boundary. Existing graph theme aliases resolve correctly; no graph CSS change was necessary.
- Existing all-role page tests cover empty/loading/refusal states; detailed layout matrix interactions use the operator. Import is planned and its confirmation opened then cancelled, not executed. Search wizard is sampled, not committed. Tutorials are viewed without running writes.
- Only prefixed fixtures on the assigned scratch database were written. The temporary Search index is removed before deleting the prefixed keys. No non-sandbox screenshots are included or committed.
- The assigned server is stopped by its own process/session, and the e2e lock is released. The ignored screenshots and local harness remain available for integration review.
