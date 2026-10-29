# Key browser and inspector UI QA

Branch: `ui/inspector`. Sandbox fixtures only. Screenshots and browser scripts are untracked under `.qa/ui/inspector/`.

## Defects and changes

| Defect | Change | Before screenshot | After screenshot |
|---|---|---|---|
| Expanding a hash field and its value creates competing cell-sized formatter panels. | A table owns a single selected cell. Its formatter renders in a separate row spanning every column. Selecting another cell replaces that detail area; Collapse closes it. Stream field/value pairs use explicit columns and the same detail-row model. | `before-hash-1280.png`, `before-type-stream.png` | `after-hash-1280-light.png`, `after-type-stream-1024-light.png` |
| Formatter tabs extend past their cell and paint over neighbouring text; toolbar badges and buttons wrap inconsistently. | Formatter tabs occupy their own bounded, horizontally scrollable strip. Buttons never shrink; badges and wrapping actions share a separate aligned line. The final numeric formatter is reachable by keyboard and pointer. | `before-hash-1280.png`, `before-type-long.png` | `after-hash-1024-light.png`, `after-value-modal-1024-light.png` |
| Long previews become tall wrapped blocks with separate cell scrollbars. | Collection previews show three lines with an ellipsis; Expand and the value-inspector button expose the complete available preview. Formatter bodies own bounded scrolling and wrap long tokens. Retrieval, copy and download byte semantics are unchanged. | `before-hash-1280.png`, `before-type-large.png` | `after-hash-1024-light.png`, `after-type-large-1024-light.png` |
| The width control has no inset padding, and percentage widths consume space needed by TTL and row actions. | The width control uses spacing tokens. A ResizeObserver measures the table because mixed percentage/pixel calculations on table columns were ignored by the browser. The selected percentage applies to the space left after fixed TTL/action columns. A table has one deliberate horizontal scroll container if the split is extremely narrow. | `before-hash-1280.png` | `after-hash-1024-light.png` |
| Narrow inspector headers consume substantial scrolling space; scan controls, list status controls and action groups can resist wrapping. | Controls can wrap with consistent gaps, the narrow inspector header scrolls away with its content, and metadata no longer reserves a wide empty indent. | `before-type-long.png`, `before-key-list.png` | `after-type-long-1024-light.png`, `after-key-list-1024-light.png` |
| Multi-entry dialog fieldsets and encoding controls lack a consistent layout and spacing. | Fieldsets, labels, inputs, selects and repeated entries use a grid with token-based gaps, inset borders and wrapping actions. | `before-dialog-multi.png` | `after-dialog-multi-1024-light.png` |
| A stream timestamp hint can run underneath the next column at narrow widths. | Both stream ID and timestamp hint wrap within the ID column. | `before-stream-id-1024-light.png` | `after-type-stream-1024-light.png` |

All listed fixes were checked at widths 1024, 1280, 1440 and 1920 in light and dark themes. The conflict screenshot is a separate 1024px check; the existing conflict layout needed no change.

## Browser coverage

- A 7,000-field hash with 64-character hexadecimal field names and JSON values, a 3 MiB string, binary bytes, a key name longer than 200 characters, list/set/sorted-set/stream values, JSON, time series, array and vector-set keys.
- Bloom, Cuckoo, count-min sketch, Top-K and t-digest keys; unsupported-value guidance remains usable. Graph commands are unavailable in this sandbox, so graph-key rendering is unqualified.
- Every available seeded type was captured at the four widths in both themes. No page horizontal overflow, uncaught page errors or CSP refusal messages were observed.
- Hash field/value expansion, replacement and collapse; formatter overflow; wide inspector and return to list. The automated role matrix covers viewer, operator and admin, all four widths and both themes, including reaching the final formatter tab.
- Tree and flat lists, long key names, size columns, scan status; set-field editor, two-entry add dialog, key TTL, field TTL, rename, delete confirmation and value inspector. Dialogs were captured at every width in both themes. Delete and rename dialogs were inspected without applying them.
- A concurrent change produced a real compare-and-set conflict in an inline hash editor. The draft, current value, diff and recovery actions remained in their containers (`after-conflict-1024.png`).

## Validation

- `pnpm -r typecheck`: all workspace packages pass.
- `pnpm --filter @rconsole/web test --maxWorkers=1`: **553 passed, 42 files**. The full-row regression failed against the original implementation before its fix.
- The existing metadata-placeholder unit test exposed a race: its mock metadata response could settle before the placeholder assertion. A deferred fixture response now explicitly holds that state until the assertion finishes.
- The first attached detail-spec run passed 5 tests and failed the rendered-width assertion. This reproduced the browser ignoring the mixed percentage/pixel column calculation. The implementation now measures the table and assigns a pixel width; the final combined run passed **9 tests** (6 existing detail specs plus 3 role-specific layout cases), under the machine-wide E2E lock, without retries.
- The default concurrent web run later exposed an existing shell drawer keyboard test race (320 versus 344 height). It passed in isolation; the complete one-worker web run passed. No shell source or shell test was changed. This scheduling-sensitive default-run failure remains outside this area.
- `pnpm --filter @rconsole/web build`: passed.
- Browser matrices and logs: `matrix.log`, `forms.log`, `module-matrix.log`; baseline comparison: `baseline.log`. No observed page overflow, page errors or CSP refusals in the completed matrices.

## Scope and qualifications

No shared CSS, UI primitives, server, policy or contract files changed. Tests changed alongside the owned UI files. No dependencies or test IDs changed. The detail UI spec accepts an optional scratch prefix for safe attached-server runs; its width assertion checks rendered geometry rather than CSS serialization.

The full E2E suite, topology tests, all-role SSO flows, screen-reader testing and graph rendering were not run. The large fixture/browser matrix used an operator; the layout regression independently used all three local roles. This is a UI-area check, not a release qualification.

## Cleanup

All scratch keys under this area's prefix were deleted from the shared scratch database. The area server was stopped by its process session; its isolated data directory and temporary account credentials were removed. The E2E lock was released by the test command's exit trap. No containers were started, no other server ports were used, and nothing was pushed.
