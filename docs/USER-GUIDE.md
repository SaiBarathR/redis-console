# Redis Console user guide

This guide is for developers who need to look at or fix data in Redis but have never used `redis-cli`. You don't need to install anything: Redis Console runs in your browser, and your company's server holds the database credentials. They never reach your laptop.

- [Signing in](#signing-in)
- [Redis in five minutes](#redis-in-five-minutes)
- [Finding your way around](#finding-your-way-around)
- [Browsing keys](#browsing-keys)
- [Changing data](#changing-data)
- [Guided mode: learn the commands](#guided-mode-learn-the-commands)
- [The console](#the-console)
- [The workbench](#the-workbench)
- [Diagnostics](#diagnostics)
- [Production databases and confirmations](#production-databases-and-confirmations)
- [What you can do with each role](#what-you-can-do-with-each-role)
- [Why was my command blocked?](#why-was-my-command-blocked)
- [Cheat sheet: redis-cli for the console](#cheat-sheet-redis-cli-for-the-console)
- [FAQ](#faq)

---

## Signing in

- **Company SSO** (recommended): click **Continue with …** (the name your administrator configured, such as *Company SSO*) and sign in as usual. Your access level (role) comes from the groups you belong to. If you see "Your company account has no Redis Console role", ask your team lead to add you to the right group.
- **Local account**: use the username and password an administrator gave you. On the first sign-in you must choose a new password (at least 12 characters). Administrators, and sometimes operators, also have to set up an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …): scan the QR code and type the six-digit code.
- Sessions end after a period of inactivity and after a maximum lifetime. Sign out with the icon in the top-right corner when you're done.
- Five wrong passwords in a row lock the account for a while. Wait, or ask an administrator.

## Redis in five minutes

Redis is a fast key–value store. Everything in it is a **key** (a name such as `user:42:profile`) that points to a **value** of some **type**:

| Type | Think of it as | Typical use |
|---|---|---|
| string | a single blob of text or bytes | cached JSON, counters, feature flags |
| hash | a small object, field → value | user profile fields |
| list | an ordered list (a queue) | job queues, recent activity |
| set | unique members, no order | tags, "users who did X" |
| sorted set (zset) | unique members, each with a numeric **score** | leaderboards, scheduling by timestamp |
| stream | an append-only log of entries with IDs | events, with **consumer groups** for workers |
| JSON | a JSON document (RedisJSON module) | documents you update by path |
| time series | timestamp → number samples (RedisTimeSeries module) | metrics |
| vector set | members, each with a vector (embedding) and optional JSON attributes, searchable by similarity | semantic search, recommendations |

Other things worth knowing:

- **Key names** usually use `:` as a separator, for example `session:9f2a` or `order:2026:10:123`. The key browser groups them into folders by that separator.
- **TTL** (time to live): a key can expire automatically. `-1` means "never expires".
- Redis has **no tables and no SQL**. You find keys by pattern (`user:*`) using `SCAN`, which walks the database a page at a time.
- Writes take effect immediately, and there is no undo. Be careful, especially on production.

## Finding your way around

- **Database switcher** (top left): choose which Redis database to work on. Badges show its environment (dev, test, staging, **Production**), the logical database it uses (`db 0`, set by the server configuration; it cannot be changed from the browser), whether it is **Read-only**, and your role on it.
- **Status bar** (bottom): the selected logical database and its key count, then **server-wide** CPU, operations per second, memory and connected clients with how fresh they are (`live` while the Overview page streams, otherwise the time since the last 30-second reading; `stale` or `unavailable` when they could not be read). Hover a figure for what it measures.
- **Tools drawer** (bottom of every database page, **Ctrl+`**): the **Console** (the same history and results as the Console page, kept in this tab's memory only), the **Command helper** (every command the server documents, searchable and grouped, with what you may run here) and, for admins on non-production databases, the **Profiler**. Drag its top edge (or focus it and use the arrow keys) to resize it. **Side by side** shows the Console next to the Command helper or the Profiler (the choice is remembered; Preferences has it too).
- **Database list**: click a column heading (keys, memory, ops/s, …) to sort; click again to reverse and a third time for the usual last-used order. Tags and module badges come from the server configuration and what Redis reports.
- **Preferences** (rail, or the palette): UTC or local time, 12/24-hour clock, ISO dates, how string values open, the default refresh for the slow log and channel list, editor font size and clearing the Workbench after a clean run. They are stored in this browser only and never contain Redis data; limits and roles are set on the server.
- **Overview**: live metrics (operations per second, memory, connected clients, hit rate) and the keyspace size.
- **Key browser**: explore keys and values.
- **Console**: type Redis commands, with autocomplete and help.
- **Workbench**: run several commands as a small script.
- **Guided mode**: forms for common tasks that show you the exact command.
- **Diagnostics**: slow commands, memory analysis, Pub/Sub, streams, search, time series. Admins also get clients and the profiler.
- **Ctrl/⌘ K** opens the command palette to jump anywhere. **?** lists keyboard shortcuts.

## Browsing keys

1. Open **Key browser**. It scans the key names straight away, up to **Keys to scan** (10,000 by default; change it at
   the bottom of the list, the choice is remembered in this browser), and shows the whole namespace tree: each folder
   with its number of keys and its share of the results. The line above the list says
   **Results N · Scanned X / total keys**.
2. Type a pattern and click **Scan**:
   - `*` matches anything, `?` matches one character. For example, `user:*:profile` or `session:????`.
   - To match a literal `*`, `?` or `[`, put a backslash in front of it (`\*`). A pattern without wildcards looks the
     key up directly.
3. Narrow the results by **Type** if you like. **Tree** groups keys into folders by the **Delimiter**; **List** shows
   one flat list.
4. In a database larger than **Keys to scan**, click **Scan more** for the next part, or **Scan to end** for all of it
   (it shows its progress, and **Stop** keeps what it found). Until the scan is complete, folder percentages are of the
   loaded matches, not of every key.
5. Type, TTL and size load for the rows you see as you scroll. Sizes of hashes, lists, sets and other collections
   are estimates from a sample of their elements (exact for strings). A folder's
   size appears once all its keys have one (`≥` means some sizes are still missing). Sort by clicking the **Type**, **Key**, **TTL** or **Size** header (click
   again to reverse); choose the columns with the column button. Sorting by TTL, size or type, and **No TTL**, first
   load those details for every listed key.
6. Hover a folder (or focus it) for **Filter to this folder** (**F**) and, if you may write, **Delete keys in this
   folder…** (**Delete**), which opens Delete by pattern with the folder's pattern filled in.
7. **Refreshed …** says when the list was read from Redis. The refresh button reads it again; **Auto** refreshes it
   every few seconds or minutes. Auto-refresh waits while a dialog is open, keys are selected or you are typing.
8. Click a key to open it. You'll see its type, TTL, size and value.

**Delete by pattern** first shows a read-only sample, then the server counts the matching keys and asks you to confirm
(type the database name; on production also a reason). The delete then runs as a job: you see the keys deleted,
scanned and failed as it goes, and **Stop** ends it between batches (what was deleted stays deleted). Closing the dialog
does not stop it; the list shows its progress and refreshes when it is done.

Working with values:

- **Value format**: Text, JSON pretty, JSON tree, Hex, Base64 or MessagePack. Redis stores bytes, so pick whatever makes the value readable.
- Compressed values (gzip/deflate) can be **inflated** in your browser for viewing (up to 4 MiB).
- Values that look like Java- or PHP-serialized objects are labelled as such. They are only displayed, never executed. Their **Java** / **PHP** tab shows the structure (class names, fields and values; PHP as `var_dump` prints it) read from the bytes: no class is loaded and nothing is deserialized. MessagePack extensions show their type and bytes.
- Big values are **truncated** in the preview, with the total size shown. **Load full value** fetches more, up to the server's limit. Big hashes, lists, sets and streams are shown a page at a time.
- Binary key names are shown safely: invisible and control characters are escaped.
- **Explain key** shows the encoding, memory and the `redis-cli` commands that read this key. Copy them if you want to learn.

### Arrays (Redis 8.8 and later)

An array is a list addressed by index that may have gaps: elements can sit at index 0, 1000 and 2^53, with nothing in
between. The inspector shows:

- **Elements** (how many exist), **Length** (the highest index plus one, so a sparse array is much longer than it has
  elements), **Next insert index** (where an append writes) and how much of the length is used.
- The elements one page at a time, in index order. A striped row such as "⋯ 997 empty positions: 3–999" marks a gap.
  **Next** continues after the last index shown, **Previous** goes back, **Last** starts from the highest index,
  **Jump to index** opens the page at any index (indices go up to 18446744073709551614, so they are shown in full),
  and **Page size** picks 25 to 1,000 elements.
- **Search values (ARGREP)**: elements in a range that equal a value, contain it, or match a glob pattern (`*`, `?`,
  `[a-z]`), with several conditions combined by any/all and an **Ignore case** option. A search looks at up to
  1,000,000 elements at a time and then offers to **Continue**; click an index in the results to open its page.
  Regular expressions are not offered: Redis runs them without a time limit, and one pattern can stall the server.
- **Aggregate a range (AROP)**: the sum, minimum or maximum of the numeric values in a range, bitwise AND/OR/XOR, the
  number of existing elements, or how many equal a value. Ranges with more than 1,000,000 elements are refused; narrow
  the range.

Long values are cut to a preview; open one and choose **Load full element**, as for other collections.

## Changing data

You need the **operator** role (or higher), and the database must not be read-only.

- **Add key**: choose the type, the name and the value. For hashes and streams you also enter a field. For sorted sets you also enter a score. New string keys are never overwritten: if the key already exists, nothing happens.
- **Edit**: change a string, add or replace a hash field, push to a list (or replace an item by index), add a set or sorted-set member, or append a stream entry.
- **TTL**: set an expiry in seconds, or `-1` to remove the expiry.
- **Rename**: renames only if the new name is free. Existing keys are never overwritten.
- **Delete**: always asks for confirmation (see below).
- **Delete by pattern**: first shows **how many keys** match and a sample, so you can check before confirming.
- The 🗑 next to a field or member removes just that element.
- **Vector sets**: the inspector shows how many members the set has, their dimensions and quantisation, then the members in byte order, 100 a page, with a **Members starting with** filter and each member's attributes (read for the rows on screen). Open a member to see its attributes, its embedding (the first 4,096 values; quantised sets show approximations) and its neighbours in the search graph. **Similarity search** finds the members closest to a member or to a vector you type, optionally narrowed by a filter expression on the attributes (for example `.year > 2000 and .genre == "drama"`; booleans are plain values: `.active`), and shows the exact `VSIM` it runs. Operators can edit a member's attributes (checked against what you opened) and remove members (after confirming); add members to an existing set with `VADD` in the console (**Add key** creates a new vector set).
- **Arrays**: edit an element with its row's pencil, or delete it with the bin (the server asks you to confirm and shows
  the exact command). **Set value at index** writes one value at any index; it proposes the first index after the last
  element. **Append values** adds values (one per line) at the insert cursor: if an element is already there (arrays
  built by setting indices keep the cursor at 0), nothing is written and you are told so; use Set value at index
  instead. **Delete a range** deletes every element between two indices after a confirmation that says how many there
  were. **Add key** with the type `array` creates an array from values one per line, and never touches an existing key.
  Ring buffers (ARRING), moving the cursor (ARSEEK) and setting several indices at once (ARMSET) are available in the
  console to operators.
- **Changed since you opened it**: edits, renames and deletes are checked against what the editor (or the inspector) read. If another client changed the value meanwhile, nothing is written and you see "This value changed since you opened it" with the current value (and the differences, for short text). Choose **Reload** to start again from the current value, or **Overwrite anyway** to write your draft over exactly what is there now (it is checked again). If the key became another type, only Reload is offered. An open row editor closes on its own when a refresh shows that its element changed.

Every change is recorded in the audit log with your name. Values themselves are never logged.

## Guided mode: learn the commands

Guided mode is a set of forms for everyday tasks: find keys, inspect a value, set a string, set an expiry, increment a counter, add to a set or sorted set, add a stream entry, and publish a message. As you fill in a form, the **Command you'll run** box shows the exact Redis command. For example, setting a value shows:

```
SET app:feature:dark-mode "on"
```

Run it from the form, or copy it into the console. This is the quickest way to learn `redis-cli`.

Guided mode has two more tabs:

- **Tutorials**: offline lessons and recipes (Search, JSON, Streams, TimeSeries, Spring Boot caching, Node.js caching). Each step explains what its commands do and shows whether your role may run them here. **Insert into workbench** adds the commands to your workbench script; nothing runs until you run the script. Practice keys live under `tutorial:` and expire within the hour. The workbench has a **Tutorials** link too.
- **Import**: run a file of `redis-cli` commands (one per line; `#` and `//` lines are comments; at most 10,000 commands and 4 MiB). **Check against the policy** shows how many commands read and write, and lists every line your role may not run here; remove those lines or tick **Skip refused lines**. Writes need one confirmation (on production, the typed database name and a reason). Commands then run one by one with a progress bar and a **Cancel** button, and the summary groups failures by command with their line numbers. Every command is checked and audited like a workbench line.

## The console

The console is like `redis-cli`, with extra help:

- **Autocomplete**: start typing and press **Tab**. Each suggestion shows whether the command is read, write, admin or blocked, plus a short description.
- **Inline docs**: once you've typed a command, a panel shows its arguments (for example `HSET <key> <field> <value> …`), its complexity and when it was added to Redis.
- **Policy badge**: before you press Enter, the badge says what the command is:
  - **read** (blue): looks at data. Safe.
  - **write** (amber): changes data. Needs the operator role.
  - **admin** (red): server administration. Needs the admin role.
  - **blocked** (red): never allowed through Redis Console. The badge explains why and what to use instead.
  - **loading** (grey): right after the Console opens, it is still fetching this database's command list, which it
    needs to classify most commands. If you press Enter now, the command waits ("Loading command info…") and runs as
    soon as the list arrives; if you change the line first, nothing runs. If the list cannot be loaded, the badge says
    so and Enter tries again.
- **Enter** runs the command. **↑/↓** walk through your history. The history lives only in this browser tab and is never saved.
- Results are shown as typed trees: strings, numbers, arrays, maps. Very large replies are cut off at the server's limit.
- Quoting works like `redis-cli`: `SET greeting "hello world"`. Inside double quotes you can use `\n`, `\t` and `\xHH`.

Useful first commands:

```
PING                         # is the database reachable?
DBSIZE                       # how many keys?
SCAN 0 MATCH user:* COUNT 100
TYPE user:42                 # what type is this key?
TTL user:42                  # seconds until it expires (-1 = never)
GET feature:flags
HGETALL user:42:profile
LRANGE jobs:pending 0 9      # first 10 items of a list
ZRANGE leaderboard 0 9 REV WITHSCORES
XRANGE events - + COUNT 10   # first 10 stream entries
JSON.GET doc:1 $.address.city
INFO memory
```

## The workbench

Write several commands, one per line, and press **Run script** (Ctrl/⌘ + Enter). Lines starting with `#` or `//` are comments. Each command is checked and run separately, and you get one result per line. Leave **Stop on first error** on, so that a mistake halts the rest of the script. There are no transactions: `MULTI`/`EXEC` are not supported. To stop a running script, press **Ctrl+C** or **Cancel**: no further line is sent, and the result shows which lines finished, which line was running when you cancelled (Redis may still have run it) and which were not run.

Some results get a richer view next to the plain reply (switch between them above the result): a **Table** for `FT.SEARCH` and `FT.AGGREGATE`, a **Chart** for `TS.RANGE`/`TS.MRANGE`, a **Plan** for `FT.EXPLAIN` and `FT.PROFILE`, and a **Map** for `GEOSEARCH` or `GEORADIUS` with `WITHCOORD`, and for `GEOPOS`. The map draws the points over a world outline that ships with the console (nothing is loaded from the internet), zooms to fit them (**World** shows the whole map), outlines the search radius or box when the command names a centre, and lists every point with its coordinates and distance. Click a point or press Enter on it to highlight its row. Up to 2,000 points are drawn; the plain reply always has all of them.

## Diagnostics

- **Slow log**: commands that took longer than the server threshold. Look here when "Redis is slow". Admins see the server's real threshold (`slowlog-log-slower-than`) and length (`slowlog-max-len`); other roles see why they are not shown. Choose how many entries to read, an automatic refresh, and µs or ms. Admins can reset it.
- **Memory analysis**: samples keys to show which types, prefixes and individual keys use the most memory, plus how many keys have no expiry. It is sampled and time-limited, so it is safe on big databases. It shows its progress and can be cancelled (you get the partial report). **Recommendations** turn the sample into next steps: big keys, hashes with too many fields, large collections, cache-like keys without an expiry, large strings holding JSON, keys that expire in the same minute, long key names, and namespaces of hashes or JSON documents that could be made searchable. Each says how many sampled keys it is based on; none is a statement about the whole database. Reports stay in this tab, so you can pick an earlier one and **Compare with** another.
- **Pub/Sub**: subscribe to up to 10 channels and patterns at once and watch messages arrive live. The session keeps running while you use the database's other pages (the tools drawer shows it and links back); switching database, signing out or reloading ends it. **Freeze** stops the table moving while messages keep arriving underneath, **Clear** empties it, **Copy shown messages** copies them as text, and the format menu shows JSON, MsgPack or hex. Operators can also publish. Messages over 64 KiB are shown cut, with their full size. Subscriptions close automatically after 15 minutes.
- **Streams**: inspect a stream's consumer groups, consumers and pending entries. Operators can create groups and acknowledge (ACK) stuck entries. In a stream key's inspector, operators can also create a group (at `$`, `0` or an entry ID, optionally creating the stream), destroy the selected group, and delete a consumer: the confirmation names the pending entries that leave the group with it.
- **Search** (RediSearch): pick an index and run a query, for example `@title:widget` or `@price:[0 10]`. Type `@` for the index's fields (Ctrl+Space lists query syntax), sort by a sortable field, choose the fields to return and the page size, and read the results as a table or as JSON. Every document opens in the key browser. Save queries for this tab, rerun recent ones, or explain and profile a query as a plan tree (Explain needs a Redis user allowed to run `FT.EXPLAIN`; if it is refused, **Profile** shows the plan too). **New index** (or **Make searchable** on a hash or JSON key in the key browser) samples keys under a prefix, suggests fields and types you can change, and shows the exact `FT.CREATE` before the server asks you to confirm. Creating an index needs the operator role and a Redis user allowed to run `FT.CREATE`. **Indexes** shows each index's definition, schema, indexing progress, errors and memory; admins can drop an index after typing its name, and its keys stay.
- **Time series**: chart a series, with optional aggregation (average per bucket, and so on).
- **Clients** (admins): connected clients. Killing a client requires confirmation.
- **Profiler** (admins, non-production only): shows the commands the server receives live (like `MONITOR`), for up to 60 seconds. Argument values are shortened, and the arguments of a very large command (over 64 KiB) are shown only up to that point. It also lives in the tools drawer and keeps recording while you move between pages; **Pause view**, **Clear**, a command filter, **Copy shown commands** and **Download shown commands** (a local `redis-profiler.log` with the same lines) help read it.

## Production databases and confirmations

Some actions show a **Confirm this action** dialog. The server, not the browser, decides when one is needed:

- **Destructive** commands (delete, rename, trim, FLUSHDB, bulk delete, client kill, slowlog reset) need a click to confirm.
- **FLUSHDB** and other high-impact actions ask you to **type the database name**.
- **Any write on a Production database** asks for the typed database name **and a reason**, such as a ticket number or "fixing stuck flag for INC-1234". The reason goes into the audit log.
- **Read-only** databases refuse every write for everyone, including admins. If you need a change there, follow your team's change process.

Cancelling the dialog (or pressing Escape) sends nothing to Redis.

## What you can do with each role

Your effective role on a database is the lower of **your role** and **the database's maximum role**. For example, an admin on a database capped at "viewer" acts as a viewer there. The badge in the top bar shows your role for the current database.

| | viewer | operator | admin |
|---|:-:|:-:|:-:|
| Browse keys, read values, read-only commands | ✓ | ✓ | ✓ |
| Metrics, slow log, memory analysis, watch Pub/Sub, streams, search, time series | ✓ | ✓ | ✓ |
| Add, edit, delete and rename keys; TTL; write commands; publish; ACK stream entries; import command files; create search indexes (when the Redis user allows `FT.CREATE`) | | ✓ | ✓ |
| Server administration (CONFIG GET, client list/kill, slowlog reset, FLUSHDB on non-prod, profiler, drop search indexes) | | | ✓ |
| Audit log, local user management | | | ✓ |

## Why was my command blocked?

Some commands are blocked for **everyone** because they are dangerous in a shared tool or could bypass the safety checks:

| Command | Why | Use instead |
|---|---|---|
| `KEYS` | Freezes Redis on big databases. | The key browser, or `SCAN 0 MATCH pattern COUNT 100` |
| `EVAL`, `EVALSHA`, `FUNCTION`, `SCRIPT`, `FCALL` | Scripts could do anything, bypassing per-command checks. | Individual commands. Put real scripts in application code. |
| `FLUSHALL` | Wipes every database on the server. | Admins: `FLUSHDB` on non-production databases. |
| `CONFIG SET`, `CONFIG REWRITE` | Can change server behavior or write files. | Ask the platform team. |
| `MODULE`, `DEBUG`, `SHUTDOWN`, `REPLICAOF`, `MIGRATE`, `SAVE`, `BGSAVE` | Server operations. | Ask the platform team. |
| `MULTI`/`EXEC`/`WATCH` | Commands run one at a time here. | Individual commands. |
| `SELECT`, `MOVE`, `SWAPDB`, `COPY … DB` | The logical database is fixed per entry. | The database switcher. |
| `ARGREP … RE …` | Redis runs the regular expression on every element of the range with no time limit; one pattern can stall the server for minutes. | `ARGREP` with `EXACT`, `MATCH` (substring) or `GLOB`, or the array inspector's search. |
| `FT.DROPINDEX … DD` | It deletes every indexed key as well. | Admins: drop the index without `DD` (the keys stay), from Diagnostics → Search → Indexes or the console. |
| `AUTH`, `HELLO`, `CLIENT SETNAME`, `ACL SETUSER` | The server manages connections and users. | — |
| `SUBSCRIBE`, `MONITOR` | Need a live stream. | Diagnostics → Pub/Sub or Profiler. |

Commands Redis Console doesn't recognise are blocked too ("fail closed").

## Cheat sheet: redis-cli for the console

| I want to… | Command |
|---|---|
| Find keys | `SCAN 0 MATCH order:* COUNT 100` (repeat with the returned cursor until it is `0`) |
| See a key's type, TTL and size | `TYPE k`, `TTL k`, `MEMORY USAGE k` |
| Read a string | `GET k` |
| Set a string with a 1-hour expiry | `SET k "value" EX 3600` |
| Set only if missing | `SET k "value" NX` |
| Increment a counter | `INCR k`, `INCRBY k 5` |
| Read or write hash fields | `HGET k field`, `HGETALL k`, `HSET k field value` |
| List items | `LRANGE k 0 -1` (all), `LPUSH`/`RPUSH k v`, `LLEN k` |
| Set members | `SMEMBERS k`, `SADD k m`, `SISMEMBER k m` |
| Top 10 of a sorted set | `ZRANGE k 0 9 REV WITHSCORES` |
| Stream entries | `XRANGE k - + COUNT 10`, `XLEN k`, `XINFO GROUPS k`, `XPENDING k group` |
| Acknowledge a stream entry | `XACK k group 1700000000000-0` |
| JSON | `JSON.GET k $`, `JSON.SET k $.path '"value"'` |
| Expiry | `EXPIRE k 600`, `PERSIST k` |
| Delete (asks for confirmation) | `DEL k` |
| Server info | `INFO`, `INFO memory`, `DBSIZE`, `SLOWLOG GET 10` |

## FAQ

**Is my data sent anywhere?** No. The browser talks only to your company's Redis Console server, which talks only to Redis and the company sign-in provider. There's no telemetry and no AI service.

**Is my command history saved?** No. It lives in memory for the current tab and disappears when you close the tab.

**I can see a database but writes are greyed out.** Either your role on that database is viewer, or the database is read-only. Check the badges in the top bar.

**Why can't I use `KEYS *`?** It can freeze Redis for every user of a large database. The key browser uses `SCAN`, which does the same job safely, page by page.

**I deleted something by mistake.** Redis has no undo. Contact the owning team: they may be able to restore from a backup or replay the data. The audit log shows exactly what was run and when.

**Something looks wrong or insecure.** See `docs/SECURITY.md` for how to report it.
