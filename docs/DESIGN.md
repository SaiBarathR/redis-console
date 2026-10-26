# Redis Console design (v0.2)

This document is the design brief for the v0.2 interface. It comes before the code and records why the interface looks the way it does. Tokens live in `apps/web/src/styles/tokens.css`; the rules in this file are the reference when a page is restyled.

## 1. Subject, audience and primary job

**Subject.** A Redis keyspace: colon-delimited namespaces of typed keys, each with a TTL that burns down, on one of several servers that differ in risk (dev, test, staging, prod, read-only).

**Audience.** Backend developers (Spring, Node) debugging their app's cache, sessions, queues and rate limits. They know `redis-cli`, read key names all day and look for one ID inside thousands. Admins also audit activity and manage accounts.

**Primary job.** Find a key fast, understand it, change it safely, on the right database.

So the interface must:
1. make the database and its risk impossible to miss,
2. make key names readable at a glance (namespace, ID, leaf),
3. show expiry as something that is happening now, not as a number,
4. keep data dense and left-aligned, the way an IDE does, not spaced out like a marketing dashboard.

## 2. Palette

Colour is information. The chrome is a quiet, slightly green-grey neutral (an instrument bezel). Hue appears only when it means something: the Redis type, the TTL state, the environment and the single "signal" colour for focus, selection and the primary action.

### Light: "Bench"

| Token | Hex | Use |
|---|---|---|
| `--canvas` (bezel) | `#E9ECE8` | app background, gutters between panes, rail |
| `--pane` | `#F8F9F6` | panes, tables, dialogs |
| `--raised` | `#FFFFFF` | inputs, hover rows, the selected row's base |
| `--ink` | `#191D1B` | primary text, values |
| `--graphite` | `#555E59` | secondary text, namespace segments, labels (6.3:1 on pane) |
| `--rule` | `#D2D8D2` | 1px pane and row rules |
| `--signal` | `#3B3DB4` | focus ring, selection, primary buttons, links (7.6:1 on pane) |

### Dark: "Night shift"

| Token | Hex | Use |
|---|---|---|
| `--canvas` | `#1A1F1D` | app background (green-graphite, not #111) |
| `--pane` | `#212725` | panes |
| `--raised` | `#2A312E` | inputs, hover rows |
| `--ink` | `#E2E6E1` | primary text |
| `--graphite` | `#9AA49E` | secondary text (6.4:1 on pane) |
| `--rule` | `#363E3B` | rules |
| `--signal` | `#ABAAFF` | focus, selection, primary (7.9:1 on pane) |

### Semantic environment colours

The environment colours the **frame**, not just a badge (see §6).

| Environment | Light | Dark | Treatment |
|---|---|---|---|
| dev | `#3D7552` moss | `#86C79F` | rail tick only, no frame |
| test | `#2E6F84` slate-cyan | `#86C3D6` | rail tick only, no frame |
| staging | `#965F00` amber | `#E8B65A` | 3px frame + tinted status bar |
| prod | `#B0261C` signal red | `#FF8E84` | 3px frame + solid status bar + labelled top edge |
| read-only (any env) | `#555E59` graphite | `#9AA49E` | hatched frame edge + "Read-only" in the status bar and context bar |

### One hue per Redis type

Used in the list glyphs, inspector header, overview keyspace bars and analysis report. The console agent uses the same `--type-*` tokens for highlighting. Each pair keeps at least 4.5:1 for the glyph text on its 14% tint, on the pane colour of its theme.

| Type | Code | Light | Dark |
|---|---|---|---|
| string | `str` | `#286B3C` green | `#7FD19B` |
| hash | `hsh` | `#7537BC` violet | `#C5A3F5` |
| list | `lst` | `#1D5FA8` blue | `#8EBDF0` |
| set | `set` | `#9C4710` orange | `#F2A874` |
| zset | `zst` | `#A72C67` magenta | `#F59CC6` |
| stream | `stm` | `#0A6F75` teal | `#71D1D6` |
| ReJSON-RL | `jsn` | `#7D6000` ochre | `#E2C25B` |
| TSDB-TYPE | `ts` | `#4E6A0C` olive | `#B6D86E` |
| MBbloom-- / MBbloomCF | `bf` / `cf` | `#6B5444` umber | `#CDB4A0` |
| vectorset | `vec` | `#56606E` steel | `#AEB9C7` |
| other / unknown | `?` | graphite | graphite |

### TTL states

| State | Rule | Colour |
|---|---|---|
| persistent | ttl = -1 | no fuse; a dotted `--rule` line and "no expiry" |
| long | > 1 h | `--graphite` |
| soon | ≤ 1 h | amber `--ttl-soon` (`#965700` / `#EDB65E`; light darkened from `#9A5B00` to keep 4.5:1 on a selected row) |
| critical | ≤ 60 s | red `--ttl-critical` (`#B0261C` / `#FF8E84`) |
| expired | ttl = -2 or reached 0 | struck through, "expired" |

## 3. Type

Two families, both self-hosted from `apps/web/src/assets/fonts/` (woff2, Latin and Latin Extended, variable weight), SIL Open Font License 1.1, licence file shipped next to them:

- **Atkinson Hyperlegible Next** (UI). The Braille Institute designed it so confusable letterforms differ: `I` has serifs, `l` has a tail, `1` has a flag and foot, `0` has a slash.
- **Atkinson Hyperlegible Mono** (data: key names, values, commands, numbers in tables). Slashed zero, serifed `I`, tailed `l`. Same skeleton as the UI face, so mixed lines (a label next to a key) do not jump.

Why not the usual developer pairing (Inter with JetBrains Mono or Plex)? Those look like every admin template. Atkinson is chosen for the job: telling `user:1001:Il1` apart from `user:l00l:I11` at 13px.

Numbers in tables, the status bar and the TTL fuse use `font-variant-numeric: tabular-nums` so columns do not jitter while counters update.

### Scale (px / line-height)

| Step | Size | Use |
|---|---|---|
| micro | 11 / 16 | status bar, column headers, glyph codes, kbd |
| meta | 12 / 18 | secondary text, toolbar labels, badges |
| data | 13 / 20 | base size: list rows, values, form controls, body |
| pane | 14 / 20 | pane titles, inspector key name (mono 15) |
| page | 16 / 22 | page title (one per view, in the view toolbar) |
| display | 22 / 28 | sign-in heading, landing heading only |

Weights: 400 body, 550 emphasis and pane titles, 650 page titles. No all-caps labels anywhere; column headers are sentence case at 11px in `--graphite`.

## 4. Layout concept

An IDE workspace, not a card dashboard. Panes butt against each other and are separated by 1px rules on the bezel colour. There are no floating cards with shadows. Only dialogs get a shadow, because they really float.

### Shell (every database view)

```
┌──┬───────────────────────────────────────────────────────────────────────────┐
│◆ │ orders dev (copy) ▾  dev · operator · ● 8.2.1        ⌕ Jump to…  ⌘K  ◐  ⎋ │ context bar 40px
│──├───────────────────────────────────────────────────────────────────────────┤
│▦ │                                                                           │
│⌗ │                                                                           │
│>_│                         view (full bleed, own toolbar)                    │
│≣ │                                                                           │
│? │                                                                           │
│∿ │                                                                           │
│  │                                                                           │
│⚙ │                                                                           │
│☺ │                                                                           │
├──┴───────────────────────────────────────────────────────────────────────────┤
│● connected  Redis 8.2.1 standalone │ dev │ operator │ 7,512 keys │ 3 ms  ⌁ 7h│ status bar 24px
└──────────────────────────────────────────────────────────────────────────────┘
 rail 52px (expands to 200px with labels; choice kept in memory only)
```

Production adds a 3px red frame around the whole window. The top edge carries a label ("Production · changes need a reason") and the status bar turns solid red. Staging gets an amber frame and a tinted status bar. Read-only adds a hatched edge and a "Read-only" segment in both bars. These marks stay on every view, dialogs included, because the dialog backdrop leaves the frame visible.

### Database landing (`/`)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Databases                          4 configured · 4 connected   ⌕ filter   │
├───┬───────────────────────────┬──────┬──────┬────────┬────────┬──────┬─────┤
│env│ name / id                 │status│ ver  │  keys  │ memory │ops/s │role │
├───┼───────────────────────────┼──────┼──────┼────────┼────────┼──────┼─────┤
│▌dv│ orders dev (copy)  ↵ last │ ●    │8.2.1 │  7,512 │ 9.8 MiB│   0  │op   │ ← focused row
│   │ orders-copy               │      │      │ ▂▂▅▂ hash 61% list 22% …     │
│▌dv│ orders dev (live)  RO     │ ●    │7.2.4 │ 7,498  │ 11 MiB │  14  │view │
│▌ts│ E2E scratch               │ ●    │8.2.1 │    116 │ 6.7 MiB│   0  │op   │
└───┴───────────────────────────┴──────┴──────┴────────┴────────┴──────┴─────┘
  ↑↓ choose · Enter open · 1–9 open by position
```

Rows are ordered with the last used database first, then by name. Production databases sort last unless they were used last. Each row is a single link, so it can be tabbed to and opened with Enter. Arrow keys move between rows. Stats come from the existing per-database `overview` endpoint and load row by row; a failing database shows its error in the row.

**As built (v0.2).** The type-mix line (`▂▂▅▂ hash 61% …`) was dropped: the `overview` endpoint has no per-type counts, and getting them needs a SCAN of every database on every visit, which the landing must not do. The second line of each row carries what is known instead: the database id, *last used*, *Read-only*, the configured description, and, for a database you inspected a key in during this session, that key in key anatomy (it opens the key browser). Hit rate, clients and uptime columns appear from 1280 px. When a server holds more than one logical database, the key count is the server total and says so ("all dbs"), because the API does not tell the browser which logical database a configuration uses.

### Key browser

```
┌─ toolbar ─────────────────────────────────────────────────────────────────────┐
│ Keys  [ session:*            ] [Scan]  type ▾  delim [:]  sort ▾   + Add  ⌫ … │
├──────────────────────────────────────────┬────────────────────────────────────┤
│ 1,200 of 7,512 · 2,000 scanned  ↻        │ hsh  session:9f2a1b:profile        │ ← key anatomy
│ ▾ session                          812   │ ████████░░░░  42m 10s · 2.1 KiB ·  │ ← TTL fuse
│   ▾ 9f2a1b                           3   │ listpack · 12 fields               │
│ ☐ hsh 9f2a1b:profile  ████░ 42m   2 KiB  │ [Edit] [TTL] [Rename] [Delete]  ⧉ ›_│
│ ☐ str 9f2a1b:csrf     ██░░░  9m    84 B  │ Text JSON Tree Hex Base64 MsgPack  │ ← formatter tabs
│ ☐ lst 9f2a1b:events   ·····  —   410 B   │ ┌────────────────────────────────┐ │
│ ▸ user                            1,904  │ │ field        value             │ │
│ ▸ queue                              41  │ │ …                              │ │
│ (virtualised, 26px rows)                 │ └────────────────────────────────┘ │
├──────────────────────────────────────────┤                                    │
│ [Continue scan]   scan complete          │                                    │
└──────────────────────────────────────────┴────────────────────────────────────┘
 selection bar replaces the list header when keys are checked:
 │ 3 selected  Set TTL [3600] · Delete · Copy names · Clear │
```

Keyboard in the list: ↑/↓ move, → or Enter expands a folder or opens a key, ← collapses or goes to the parent, Space toggles the checkbox, Shift+click selects a range, `/` focuses the pattern (only when focus is not in an input).

**As built (v0.2), and why it differs from the sketch.**
- *Collapsed start for big keyspaces.* On a 7.5k-key development snapshot a fully expanded tree opened as 200 rows of opaque IDs, which hid the shape of the data. When the first SCAN page holds more than 150 keys, folders start collapsed and single-child chains open down to the first real branch, so the first view is the namespace outline with counts and memory per folder. Small results (a scoped pattern) open fully.
- *Explicit scan state.* Every write broadcasts "database updated", and a cached infinite query would replay every loaded SCAN page after each edit (38 requests for 7.5k keys, over the server's 10 scans/s limit). The browser keeps its own SCAN state in session memory, patches its own changes (add, edit, TTL, rename, delete) and rescans only when asked. *Scan to end* drains the cursor at 400 keys a page, paced under the limit (the v0.2 UI tour first chose 400 to stay clear of a server truncation that lost keys; since `1984f93` the server never drops keys the cursor has passed, so 400 is now only a pacing choice), with a Stop button and a 100k-key cap. The list never claims more than it knows: a key added or renamed under a pattern or type filter is not inserted (the browser does not match globs itself), its own adds and deletes adjust the key count, and writes made on other pages (Guided, console, workbench) or changes it could not place show a "Rescan to update" notice (web review round 1, M3/M4).
- *Resizable split.* The list/inspector boundary is a 1px rule with a 7px drag area and arrow-key support; the width is kept in session memory only.
- *Selection for every role.* Viewers can select keys and copy their names; Set TTL and Delete appear only for writers. Space on a folder selects the loaded keys under it.
- *Row actions.* Element tables (hash, list, set, zset, stream) show compact icon actions (edit, field TTL, remove) that open a panel under the row, instead of a text button and a disclosure in every cell.
- *Formatter tabs.* A string or JSON value that is a whole JSON document opens on the JSON tab; everything else on Text. Structured tabs are disabled (with the reason) on truncated previews.
- *Inspector fuse.* The inspector fuse is 160 px, not full width: a 900 px bar read as a progress bar and pushed the size, encoding and length facts to a second line. The log scale stays readable at that length.
- *Delete is not a filled red button.* A solid red button in every inspector header drew the eye to the least common action. It is a red text button; the server confirmation dialog (impact, typed name and reason on production) is the safeguard.

**As built (v0.2.1): names first, details for what is on screen.** Compared side by side with Redis Insight on
a 7.5k-key development snapshot and an 8k-key read-only remote database, v0.2 showed 200 keys and needed "Scan to end" for the shape of the data,
because every listed key cost TYPE + TTL + MEMORY USAGE. The browser now works the way Redis Insight's does, through the
policy boundary:
- *Whole tree on open.* `keys/names` returns names only (SCAN COUNT 2000 per call, up to "Keys to scan", 10,000 by
  default), so the first view is the full namespace outline with a count and a share of the results on every folder
  (the owner's picture of which namespaces dominate). The head reads `Results N · Scanned X / DBSIZE`; the header note says
  whether shares are of *matching keys* (cursor back at 0) or of *loaded matches* (partial), and the folder tooltip gives
  the full pattern and the precise share. A partial inventory never claims database coverage.
- *Metadata for visible rows.* Type, TTL and size come from `keys/meta` for the rows on screen (debounced batches, one
  at a time, cached per key in session memory). Until then a row shows quiet placeholders that keep the columns aligned
  (an outlined `···` glyph, an empty fuse track, no size). Folder byte sums appear when every key below has a size;
  before that they read `≥ 1.2 MiB` in italics, with the count of sized keys in the tooltip.
- *Columns are headers.* Type, Key, TTL and Size are sort buttons above the list (pressing the active one reverses it;
  the arrow shows the direction), and a column chooser hides TTL, size or type. Hidden columns are not read from Redis.
  Sorting by metadata or "No TTL" needs every key's details, so it loads them explicitly with a progress line and Stop.
- *Tree and List* are a segmented control; the delimiter field only shows in Tree and keeps its value.
- *Folder actions on hover and focus.* A filter icon (F) scans the folder's pattern; for writers a red trash icon
  (Delete) opens Delete by pattern pre-filled. Icons only appear on the hovered or focused folder, so 30 rows of folders
  do not become 60 red icons.
- *Freshness.* "Refreshed 2 min ago" next to a refresh button and an opt-in auto-refresh select. Auto-refresh pauses while
  a dialog is open, keys are selected, a pattern delete runs or the user is typing; refreshing replaces the list when it
  is done, so the tree never flashes empty.
- *Pattern delete is a job.* After the same sample and server confirmation, the dialog shows deleted / scanned / counted
  at confirmation / failed / time, a progress bar, Stop, and a closing sentence that says what happened and why it ended
  ("Stopped on request. Deleted 1,200 of 1,400 scanned keys; keys not reached yet were left in place.").

### Diagnostics

```
┌─ tools ──────────┬───────────────────────────────────────────────────────────┐
│ Slow log      12 │ Slow log                       [Refresh] [Reset]          │
│ Memory analysis  │ ───────────────────────────────────────────────────────── │
│ Pub/Sub          │ id  when       duration  command                          │
│ Streams          │ 41  10:02:11   12.3 ms   HGETALL session:9f2a…            │
│ Search           │ …                                                         │
│ TimeSeries       │                                                           │
│ Clients (admin)  │                                                           │
│ Profiler (admin) │                                                           │
│ ─ unavailable ─  │                                                           │
│ Profiler: prod   │                                                           │
└──────────────────┴───────────────────────────────────────────────────────────┘
```

The v0.1 grid of identical tool cards is replaced by a tool list with one-line explanations and the Redis command each tool runs. Tools you cannot use are listed separately under "Not available here" with the reason. `/diagnostics` opens on the slow log, so the view starts with data rather than a menu.

## 5. The signature element: key anatomy and the TTL fuse

**Key anatomy** renders a key name as typed segments:

- **namespace segments** (`session`, `user`) in `--graphite`,
- **delimiters** (`:` or the chosen delimiter) in `--delim` (`#606863` / `#959F98`), a step lighter than the namespace but still 4.5:1 on every surface a key appears on, including the selected-row tint (the first values, `#68706B` / `#8C968F`, measured 4.08:1 on a selected row),
- **identifier segments** (UUIDs, ULIDs, hex ≥ 6, numbers, Base64-ish tokens ≥ 16) in `--ink`, mono, with tabular numerals and a dotted `--rule-strong` underline so an ID stands out from the words around it (the first build used a signal-tinted underline; in a list of 70 hex-keyed rows every row looked like a link, so the underline became a quiet dotted rule),
- **the leaf** (last segment) in `--ink` at weight 550.

It is pure text (spans, never HTML from data), keeps exact characters (the accessible text equals the key), escapes invisible and bidi characters with `visibleText`, and falls back to plain escaped text for binary keys. It is used in the key list, the inspector title, the selection bar, confirmation dialogs (keys in the server preview) and the landing "last key" hint. The console agent can import `KeyName` for results.

**The TTL fuse** is a 4px bar, 40px in lists and 160px in the inspector (see §4, key browser), plus a countdown label. Its length is the time left on a log scale (full at seven days or more, empty at zero), so the difference between 20 seconds and 20 minutes is visible. It burns down live from the TTL the server reported and the time it was read. The colour follows the TTL states in §2. With `prefers-reduced-motion` the bar does not animate between ticks; it updates every second without a transition. A persistent key shows a dotted line and "no expiry". The bar is `aria-hidden`; the label carries the meaning.

Everything else is deliberately quiet: no icons in headings, no decorative illustrations, no coloured section backgrounds.

## 6. Environment marking

`data-env` and `data-readonly` on the shell root drive everything:
- `--env` colour for the frame (`box-shadow: inset 0 0 0 3px`) on staging and prod, a 2px rail tick on dev and test.
- prod: a 20px labelled top edge that also carries the role="status" message ("Production database · All writes are disabled" or "· Changes require explicit confirmation and a reason"), and a solid red status bar.
- read-only: a diagonal 45° hatch on the top edge and a "Read-only" lock segment in the context bar and status bar. It is a repeating stripe pattern that marks state, not a decorative gradient wash.
- The database switcher option text keeps `[env]` and `· READ ONLY`.

## 7. Principles

1. **Density with air.** 26px list rows and 13px data, but 12–16px pane padding and clear rules. No empty hero areas; each view starts with its own toolbar, not a page heading block with a subtitle.
2. **Colour means something.** Neutral chrome. Hue means a type, a TTL state, an environment or the signal colour.
3. **Show the command.** Every action can show the Redis command it runs (Copy CLI, guided previews, explain panel).
4. **Say what to do next.** Empty, loading and error states name the cause and the next action ("No keys match `session:*`. Clear the pattern or continue the scan.").
5. **Keyboard first, mouse friendly.** Visible focus (2px signal ring, 2px offset) on everything, every shortcut has a visible control, no shortcuts fire while typing.
6. **Calm motion.** Only state transitions (120ms) and the TTL fuse move; `prefers-reduced-motion` turns transitions off.
7. **Text is data.** Never HTML from Redis; bidi and invisible characters made visible; mono for anything copied into `redis-cli`.
8. **Copy:** plain, active voice, sentence case, no exclamation marks.

## 8. Review against the "avoid template tells" list

I checked the first draft of this plan against the list in `docs/V0.2-PLAN.md`. Changes:

| Tell | First draft had | Changed to | Why |
|---|---|---|---|
| Identical rounded cards with soft shadows | Landing as a grid of database cards with stats inside; Diagnostics as tool cards (v0.1 pattern) | Landing is a dense table; Diagnostics is a list next to the tool pane; panels are rule-separated panes with 0–4px radius and no shadow | The landing's job is comparing databases, and a table compares better than cards. Shadows imply floating, and panes don't float. |
| Gradient washes | Prod banner as a red-to-transparent gradient | Solid frame plus a solid status bar. The only `repeating-linear-gradient` is the read-only hatch | The hatch is a state pattern people recognise as "do not touch". A wash is decoration. |
| All-caps eyebrow labels | "WORKSPACE" / "ADMINISTRATION" rail section labels and uppercase table headers | No section labels in the rail (a rule separates groups); sentence-case 11px headers | Uppercase labels add noise and are harder to read. |
| Accenting one word in a heading | Sign-in headline "Clarity at the *command line*" (v0.1 large headline) | Sign-in uses a plain sentence heading and a real key-anatomy sample instead of a marketing line | The product's voice is plain. |
| Near-black #111 with one neon accent | Dark theme at `#121417` with a cyan accent | Green-graphite `#1A1F1D` and a soft indigo signal `#ABAAFF`, with type hues doing the colour work | Avoids the "hacker terminal" cliché and keeps AA contrast for 11px text. |
| Cream + terracotta | Light pane `#FAF8F3` | Cool `#F8F9F6` on a green-grey bezel | A warm cream reads as editorial or lifestyle. The instrument bezel is cool. |
| Default dashboard stat tiles (big number, icon in the corner) | Overview kept four stat tiles | Overview is a "readout strip": one row of compact gauges with sparklines and units, then charts and tables with no card chrome | Same information, half the height, no icon decoration. |
| Default font pairing | Inter + JetBrains Mono | Atkinson Hyperlegible Next + Mono | Chosen for identifier legibility (§3). |

The accessory I removed at the end is listed in §9.

## 9. Final critique log

I reviewed every page in both themes at 1440, 1280 and 1024 wide, as viewer, operator and admin, on a development snapshot, the sandbox databases and a read-only remote database (the page × role × database matrix: `docs/qa/v02-ui-live.md`). Changes made after looking at the screenshots:

| Saw | Changed | Why |
|---|---|---|
| Overview sparklines dropped from top to bottom while memory moved 0.1 MiB | Sparklines start at zero (hit rate on 0–100 %, CPU on at least 0–5 %) | Min–max scaling turned noise into cliffs; a readout must not exaggerate. |
| Readout qualifiers cut off at 1280 ("no maxme…") | Shorter qualifiers, full text in the tooltip | The qualifier is information, not decoration. |
| Landing figures wrapped ("Connecte d", "8.10. 2") once descriptions were added; the table overflowed at 1024 | The name column absorbs the free width and truncates; every figure is on one line; three secondary columns hide below 1280 | Comparing rows is the landing's job, and wrapped numbers cannot be compared. |
| Overview of a database configured with a logical `db` index showed the whole server's key count as if it were the database's | "Keys on this server", "keys on server" in the status bar, "all dbs" on the landing when INFO lists several logical databases | The API does not expose the configured index; the label now says what the number is. |
| Lock icon of the production and staging edge sat on its own line | Edge label is one inline row | The edge must stay a single 20 px band. |
| The key tree on 7.5k keys opened fully expanded | Collapsed start with single-child chains opened (§4) | The first view should show the namespace outline. |
| Every hex-ID row looked like a link | Dotted, quiet ID underline (§5) | Links are signal-coloured; IDs are not links. |
| Explain panel facts stretched to the height of the command column | Facts align to the top; command lines wrap | Dense panes, no stretched gaps. |

**The accessory I removed before calling it done:** the folder icon in tree rows. It repeated what the chevron and the trailing delimiter already say (this is a namespace), and it cost 20 px of indent per level, which in a deeply nested namespace pushed key names into truncation. Also cut: the icon in each guided task heading, the `<>` illustration in the empty inspector and the icons in the old stat tiles.

## 10. v0.2.1 shell additions (Redis Insight parity, SHELL stream)

- **Tools drawer.** A pane under every database view, not a floating panel: a 30 px tab bar (Console, Command helper,
  Profiler where allowed) with the database's `db N`, role and read-only state, and a body resized by a 1 px rule with
  a 7 px drag area (keyboard: arrow keys on the focused rule). It is closed by default; open state, tab and height are
  the only things remembered. The environment frame and the prod/read-only edge stay outside it, so the risk marking
  is never covered. On the Console page the drawer shows a note instead of a second editor.
- **Status bar metrics.** One quiet group labelled `server` (dotted underline, tooltip explains the scope) for CPU,
  ops/s, memory and clients, then a freshness word. The selected logical database's keys sit before it with a `db N`
  chip, because they are a different scope. Stale or unavailable figures turn graphite and the freshness word amber,
  rather than disappearing. CPU is the difference between two INFO readings, so it shows `—` until the second one.
- **Landing.** Column headings are buttons with `aria-sort`; a third click restores last-used order. Configured tags
  are outlined; capability badges are filled and quieter, and hide below 1280 px, where the name column needs the room.
- **Pub/Sub and Profiler.** Topic chips (kind + name, remove button) instead of one field each. Freeze/Pause is a
  pressed toggle that says how many arrived meanwhile; nothing scrolls under the reader.
