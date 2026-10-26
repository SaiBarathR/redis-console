# Redis Insight parity plan (v0.2 completion)

Source audit: `docs/RI-PARITY-AUDIT.md` (fix IDs F1–F27, keep list K1–K5). Goal: every DOWNGRADE is matched or exceeded through our
policy boundary; everything in "Keep ours" stays; "Intentionally different" items stay out.

## Workstreams and file ownership

| Stream | Owner | Fixes | Owns (primary files) |
|---|---|---|---|
| KB — key browser scanning & tree | Claude (`feat/v021-kb`) | Names-only scan + lazy metadata (RI parity), F2 percentages/coverage, F14 tree/list toggle + column chooser + sort, F16 list last-refresh/auto-refresh, F20 observable/cancellable pattern delete | `pages/Keys.tsx`, `lib/keytree.ts`, `lib/keyscan.ts`, `styles/keys.css`; server `routes/keys.ts` scan/bulk sections, `redis/scan.ts` |
| DETAIL — key details | GPT (`feat/v021-detail`) | F1 field/member search + list index jump + zset lookup, F3 in-place collection formatting, F6 hash field TTL column, F9 full element retrieval, F18 multi-entry add, F15 stream groups/consumers/pending/claim in inspector, F17 vector-float formatter (first slice), F23 vector-set read view if cheap | `components/KeyInspector.tsx`, `KeyContent.tsx`, `ValueViewer.tsx`, `KeyOperations.tsx`, `HashExpiry.tsx`, `lib/format.ts`; server `routes/keys.ts` read/op sections, `routes/modules.ts` stream parts |
| SHELL — shell & tools | Claude (`feat/v021-shell`) | F27 bottom tools drawer (Console / Command Helper / Profiler on any DB page), F5 persistent CPU/ops/memory/keys/clients, F13 logical-DB context, F21 landing sort/tags, F25 command catalog + profiler controls, F22 Pub/Sub ergonomics, F19 slowlog real config (read-only), F26 Preferences | `App.tsx`, `StatusBar.tsx`, `Landing.tsx`, `lib/dbstats.ts`, new `components/drawer/*`, extracted Pub/Sub, Slowlog, Profiler from `Diagnostics.tsx`; server `routes/databases.ts`, `routes/diagnostics.ts` |
| INSIGHT — search, analysis, workbench, import | Claude (`feat/v021-insight`) | F7 Make searchable + index wizard, F8 search workflow, F4 analysis recommendations + report history, F11 rich Workbench results, F10 bulk import job, F12 offline tutorials/recipes | extracted Search and Analysis from `Diagnostics.tsx`, `components/ConsoleResult.tsx`/`Reply.tsx` result renderers, `pages/Guided.tsx` tutorials; server `routes/modules.ts` search parts, `routes/diagnostics.ts` analysis parts, new import job route |

Shared files (`Diagnostics.tsx`, `routes/keys.ts`, `routes/modules.ts`, `routes/diagnostics.ts`, `packages/shared/src/api.ts`): change only
your own sections, extract your tool into its own file early, keep shared-contract changes additive and log them in
`docs/CONTRACT-CHANGES.md`. Integration branch: `release/v0.2.1`.

## Deferred with reason
- F24 array type inspector: feature-gated in Redis Insight itself; revisit when Redis ships it generally.

## Rules (all streams)
Hard rules from `AGENTS.md` apply unchanged: server-side policy and per-role ACL users, no Redis data as HTML or in URLs/storage, byte-exact
display/copy/write, compare-and-set for replacing edits, measured transport for data-dependent replies, read-only/prod framing.
Live testing in Chromium as viewer/operator/admin on `snapshot`, `sandbox-e2e` and read-only `remote-6390` is mandatory.
