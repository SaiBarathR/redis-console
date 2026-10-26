# Redis Console v0.2

Restore point for the previous release: `git checkout v0.1`.

## What's new

**A redesigned interface**
- A workspace laid out like an IDE: a collapsible rail, a namespace tree, an inspector and a persistent status bar. Light and dark themes, using self-hosted Atkinson Hyperlegible fonts.
- Key names are split into namespace, ID and leaf. Each key has a TTL bar that burns down, and each Redis type has its own colour everywhere.
- The environment is marked on the whole frame: staging amber, production red, read-only hatched.
- The database landing page shows live figures for every database, most recently used first, and can be driven from the keyboard.

**A smart console and workbench**
- Terminal and IDE shortcuts:
  - Ctrl+R history search, Ctrl+L clear, Ctrl+C cancel
  - ⌥↑/↓ to move between results
  - F1 for docs
  - ⌘Enter to run all and Shift+Enter to run the current line
  - `?` for the cheatsheet
- Highlighting by argument role (from the Redis key specs), ghost-text history, a signature hint, did-you-mean, and KEYS→SCAN guidance.
- A live policy badge and a danger state before destructive commands.
- Result blocks with copy, re-run, code snippets and key links.
- Cancelling really stops a script on the server, and the transcript tells you exactly which lines ran.

**Safer editing**
- Compare-and-set edits: every value edit sends a fingerprint of what you opened. The server writes only if Redis still holds it; otherwise you get "This value changed since you opened it".
- What you see, copy and re-run matches the stored bytes, including big integers, CRLF, BOM and other invisible characters, binary values and MessagePack.
- Creating a key never overwrites an existing one. Editing a string keeps its TTL unless you choose otherwise.

**A more robust server**
- Replies are measured as they arrive, instead of having their size predicted, so memory stays bounded however the data is shaped.
- Bounded wait queues and fair per-user shares. Long-lived streams have their own budget, and upload bodies are budgeted before they are read.
- An account's authority is re-checked after the request body arrives, after any wait, and at the moment a command is sent to Redis.
- Request, header and idle timeouts. Production refuses unsafe proxy trust, plaintext prod databases and shared credentials unless you explicitly accept the risk.

**Development data**
- A local snapshot sandbox of a real development Redis (refresh it with `scripts/snapshot-redis.sh`), and a read-only remote development target used for live testing. Both are machine-specific and configured outside the repository.

## Redis Insight parity (added before release)

The owner compared v0.2 side by side with Redis Insight; every gap found was audited (`docs/RI-PARITY-AUDIT.md`), fixed and reviewed (`docs/REVIEW-LOG.md`).

- **Key browser opens on the whole keyspace.** Names-only scan (like Redis Insight) builds the full namespace tree with counts and
  shares in under a second (7.5k-key snapshot 4.6 s → 0.8 s, 8k-key remote 55 s → 0.8 s; about 22.5k → 14 Redis commands on open); type/TTL/size load
  lazily for visible rows. Tree/List toggle, column chooser, sorting, folder actions, list auto-refresh, and pattern delete as a
  cancellable job with honest partial results. Default "Keys to scan" 10,000; sizes use `MEMORY USAGE … SAMPLES 5`.
- **Key details:** field/member search and list index jump, formatters inside collections, hash field TTL column, full-element
  read/copy/download, multi-entry add (compare-and-set), stream groups/consumers/pending with claim, ack, consumer delete and group
  create/destroy, float-vector, PHP and Java structure views (inert, bounded).
- **Tools everywhere:** bottom drawer with Console, Command Helper and Profiler (optionally side by side) on every database page;
  live CPU/ops/memory/clients and `db N` in the status bar; landing sort and tags; Pub/Sub with multiple topics, freeze and
  continuity; real slowlog configuration; Preferences.
- **Insight:** "Make searchable" and an index wizard, search editor with saved queries and table/JSON views, analysis
  recommendations with history and comparison, rich Workbench results (search tables, time-series charts, query plans), policy-checked
  bulk import, offline tutorials.
- **Policy tightening:** `FT.DROPINDEX` is admin-only with typed confirmation; imports need operator.
- **Deferred:** vector-set inspector, array-type inspector, geo/graph Workbench renderers.

## Upgrade notes
- **Operator ACL:** the operator Redis ACL user needs `+@transaction` for checked edits. Without it, edits return a clear 403 and nothing is written. See `docs/INSTALL.md` (section 5).
- **New config keys, all optional with defaults:** `policy.keyScanThresholdMax`, `policy.keyMetaMemorySamples`, `policy.searchDropDeletesDocuments`, `databases[].tags`, `policy.maxStreams`, `policy.maxBodiesInFlight`, `policy.maxBodyBytesInFlight`, `policy.maxReadReplyBytes`, `policy.maxInflightCommands`, `auth.oidc.sessionTtlMinutes`.
- **API:** reads that carry Redis data are POST bodies. Pub/sub uses single-use subscription ids. See `docs/CONTRACT-CHANGES.md` for the full list.

## How it was checked
- Each feature was built by one model and then reviewed independently by another (GPT-6.1-Sol and Claude Opus 5.5). The reviews ran in rounds. Each finding was reproduced against the current code, then fixed with a regression test, or skipped with a recorded reason. Every verdict is in `docs/REVIEW-LOG.md`, and the reports are in `docs/research/07`–`25`.
- Each feature was tested live in Chromium as viewer, operator and admin, through both local accounts and Keycloak SSO, on every configured database. See `docs/qa/`.
