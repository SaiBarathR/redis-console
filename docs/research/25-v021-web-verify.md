# Redis Console v0.2.1 — focused web fix verification

Reviewed **24 October 2026**, `release/v0.2.1` at **`d436424`**, against [the original review](24-v021-web-review.md) and `docs/REVIEW-LOG.md` → “v0.2.1 review – web (GPT reviewer)”. **The original M1/M2/L1 repros are fixed. One new Medium issue was reproduced in L3: Java reference formatting can expand a small Redis value into hundreds of megabytes before applying the display cap.** No content execution was observed.

## Verdicts

| Item | Verdict | Independent verification |
|---|---|---|
| **M1 — wizard provenance** | **Fixed** | Held the **real fetched** `/search/sample` response for source A. Prefix and HASH/JSON controls were disabled. Forced a React input change to source B while held; releasing A did not populate the schema or advance the wizard. Resampling B produced `FT.CREATE idx:vf-20261024:prov ON HASH PREFIX 1 vf-20261024:src-b: SCHEMA rating NUMERIC username TAG`, with no A fields. Redis refused the operator create with `NOPERM`; an admin API confirmation of that same definition then returned 200, and direct `FT.INFO` verified B's fields before the index was dropped. Forced HASH→JSON also discarded the late HASH response; resampling produced `ON JSON` with `$.n`/`$.title`. |
| **M2 — rich view caps** | **Fixed** | Real `TS.MRANGE` over 13 two-sample series rendered 12, explicitly said “Showing 12 of 13 series. 1 not drawn”, and **Show the raw reply** exposed series 13. A real 45-field `FT.SEARCH` reply showed “40 of 45 columns” and the raw-view action. The passing tests also cover 1,200 rows and deep iterator disclosure. Bounds remain in place. |
| **L1 — helper filtering** | **Fixed** | Selected HSET, changed the filter to GET: the selected list item, detail and inserted prompt all became the same first visible result (`ARGET` in this runtime's catalog). HSET did not remain the insertion target. |
| **L2 — stream lifecycle** | **Fixed in exercised scope** | Viewer UI hid delete/create/destroy. Real binary group `ff 67 00` and consumer `fe 63 00` survived listing and the delete dialog. The server's preview argv matched **every byte**; confirmed delete returned 2, left PEL count 0, and preserved all 3 stream entries. Created binary group `fd 32 00` at `1-0`, then destroyed it through a byte-exact confirmation. Ordinary inspector create/destroy also passed. Role/read-only matrix is below. |
| **L3 — PHP/Java/MessagePack** | **Partly fixed; new Medium M3** | The requested structural views and extension summaries work and stay inert. Deep nesting, lying lengths, unknown handles and superclass cycles terminate in the tested cases. **Java's claimed item/output bounds are incomplete**, allowing substantial allocation amplification; see M3. |
| **L4 — profiler download** | **Fixed** | A live 5-second admin capture downloaded an opaque `blob:` URL as static `redis-profiler.log`; it contained 53 lines matching the 53 shown events. Source and passing regression verify the same formatter as Copy, local Blob creation, anchor removal and URL revocation. |
| **L5 — side-by-side drawer** | **Fixed** | Tabbed default; opt-in Console/helper panes visibly left/right at 1440px, DOM order Console then helper. Inserting HGETALL filled/focused the visible Console while the helper stayed open. Keyboard resize changed height by 24px; switching back restored tabs. |
| **Preferences copy** | **Fixed** | Live copy distinguishes the server's maximum from the user's **Keys to scan** choice. |

## L2 authorization, confirmation and shared command policy

The production-build browser/API checks used `sandbox-e2e/6411`. An additional **real Fastify route-injection check**, using the current server and an isolated in-memory auth store, configured writable and read-only aliases of **6411 only**. For **each** of `stream.consumer.delete`, `stream.group.create`, and `stream.group.destroy`:

- Viewer against the writable alias: **403 `forbidden`**.
- Operator and admin against the read-only alias, with no role cap: **403 `read_only`**.
- Instrumented Redis-manager connection calls during each refused typed request: **zero**. This independently exercised read-only enforcement instead of merely observing a maxRole=viewer refusal.

Delete's dialog accurately qualified the count as **“at the last refresh”**, explained that pending entries become unclaimable/unacknowledgeable while stream entries stay, and displayed `XGROUP DELCONSUMER` with the binary identities. Redis's returned count, rather than the stale UI count, drove the outcome. Group destroy likewise described pending/consumer removal and retained stream entries. The new group form preview showed the exact ordinary-key command and explicit start ID.

Policy at `packages/shared/src/commands.ts:193–194`: **DESTROY and DELCONSUMER are write + confirm**. `XGROUP` is a fail-closed subcommand parent at `:206`; **CREATE has no shared allow rule**, so raw Console/Workbench CREATE remains blocked. This is the existing restricted policy, not a newly enabled raw-command capability. Verified raw requests: viewer DELCONSUMER/DESTROY → 403; operator → 428; CREATE → 403 for both. The dedicated typed create at `apps/server/src/routes/keys.ts:146` authorizes a fixed write and keeps its existing no-confirmation policy outside production. Typed destroy/delete require confirmation. No shared-policy relaxation was introduced.

## New M3 — Medium: Java formatting amplifies references before the display cap

**Locations:** `apps/web/src/lib/javaser.ts:106–109` retains an unrestricted descriptor name in a reference description; `:236–240` creates null/reference nodes without charging the item budget; `:319–320` repeats that description for every reference; `:366–367` assembles the complete output. `apps/web/src/lib/format.ts:144–153` calls the entire formatter and only then truncates it to 100,000 display characters. Locations refer to `d436424`; after worktree removal use `git show d436424:<path>`.

**Reproduction, current code executed:** construct a Java serialization stream with a serializable object whose class descriptor name is `A` repeated N times, zero fields, followed by R `TC_REFERENCE` records pointing to object handle `0x7e0001`. No class loading or real Java execution is involved.

```js
// Run in a checkout at d436424; imports are relative to the repository root.
import { javaText, parseJavaSerialized } from './apps/web/src/lib/javaser.ts';
import { formatValue } from './apps/web/src/lib/format.ts';
function fixture(n, refs) {
  const len = Buffer.alloc(2); len.writeUInt16BE(n);
  return Buffer.concat([
    Buffer.from([0xac, 0xed, 0, 5, 0x73, 0x72]), len,
    Buffer.alloc(n, 65), Buffer.alloc(8), // class name and serialVersionUID
    Buffer.from([2, 0, 0, 0x78, 0x70]), // flags, no fields, end annotation, no superclass
    ...Array.from({ length: refs }, () => Buffer.from([0x71, 0, 0x7e, 0, 1])),
  ]);
}
const b = fixture(10000, 1000);
console.log(b.length, javaText(parseJavaSerialized(b)).length);
// Observed: 15021 input bytes -> 10016028 output characters.
const large = fixture(60000, 5000);
console.log(formatValue({ enc: 'base64', data: large.toString('base64') }, 'java').length);
console.log(process.resourceUsage().maxRSS, process.memoryUsage().heapUsed);
```

**Observed versus expected:** the 15,021-byte fixture also reached the real viewer through Redis on 6411: selecting Java returned a 100,078-character capped view (63ms in that run), while the formatter had generated 10,016,028 characters first. A separate subprocess running the **default capped `formatValue`** on the **85,021-byte** larger fixture returned just 100,080 characters but reached **698,496 KiB RSS (~682 MiB)** and **618,354,264 bytes of used heap**. It ran with `--max-old-space-size=128`; that flag did not stop this large string allocation. No actual browser crash is claimed: the larger allocation was isolated from the live browser. Both inputs fit below the configured 512 KiB value limit and the formatter's 4 MiB input limit.

Separately, 150,000 `TC_NULL` records parsed into 150,000 nodes, and 150,000 references parsed into 150,001 top-level nodes, despite `MAX_ITEMS = 100_000`. This bypass matters because references can repeat long labels. The issue is excessive work/allocation before a nominal safety boundary, **not an infinite reference traversal**. Larger output can also fail with JavaScript string limits; catching an exception after allocation does not enforce a resource budget.

**Impact:** an attacker able to place bytes in Redis can make a viewer's Java-tab selection consume hundreds of megabytes on the UI thread. This can stall the tool or exhaust a constrained tab's memory. It is client availability impact; no server execution or data mutation was demonstrated.

**Minimal fix:** charge **every** parsed node, including null/ref/reset, to the item budget; bound reference-label lengths; and make Java text emission enforce an aggregate expanded-output/work budget **before appending/joining strings**. Apply a hard expanded-output limit to Copy too (`Infinity` must not bypass safety), returning a clear limit message and preserving original-byte download. A bounded writer should stop with explicit disclosure rather than calculate an exact omitted count by fully materializing the omitted output. Add regression cases using both fixtures and >100,000 null/reference nodes. Do not remove the existing depth/input limits.

## L3 adversarial and inertness checks

Executed independently constructed inputs against `phpser.ts`, `javaser.ts`, `msgpack.ts`, and the real formatter:

- **PHP:** 500-level nesting stopped at 128; enormous declared string/custom/array lengths failed before reading/allocating their declared payload; 100,001 array entries hit the item cap; oversized reference number was refused. `a:1:{i:0;R:1;}` printed a pointer without traversing it. A custom `C:` payload containing a script stayed quoted bytes. No runaway behavior was observed for PHP.
- **Java:** 200 nested arrays stopped at 64; a declared 2^63−1 string and 2^31−1 int array were refused against remaining bytes; unknown handle failed; a self-referential superclass on an object failed with “class hierarchy too deep”. A descriptor-only self-cycle printed one descriptor line without traversal. Null/reference budget and label expansion failed as M3 describes. A 65,535-dimensional signature caused a terminating `RangeError` in recursive `jvmType` (`:296`); this is another reason to validate type dimensions, but does not establish an infinite loop.
- **MessagePack:** huge array/ext lengths and 200-level nesting failed promptly. Extension types 5 and 7 printed their type/count/hex bytes; the timestamp type remained decoded separately.
- **Live HTML probes:** PHP object class/string, Java string, and MessagePack extension payloads contained `<img ... onerror=...>` and `<script>...`. The PHP/Java text remained escaped text, extension content stayed hex; inspector DOM contained **zero injected img/script/iframe/object nodes**, and the execution sentinel stayed unset. Switching to Hex and back remained inert. Source inspection found no HTML insertion, eval, dynamic Function, or dynamic import in these parsers/formatter/viewer. Their records do not instantiate PHP/Java classes or invoke serialized methods. Existing tests also verify detected-only tabs and disabled structured tabs for truncated previews.

## Build, regression scope and evidence

- `pnpm install`: passed. `pnpm --filter @rconsole/web build`: passed (TypeScript + production Vite build).
- The web-test invocation ran the **complete web suite: 459/459 tests, 31 files passed**. No full repository E2E/backend/topology-suite run was needed for this focused verification.
- Dedicated production server at `http://localhost:4700`, data `/tmp/rc-v021-vf`; accounts created using the requested script. Source checkout stayed clean; no source edits or commits.
- Browser: Chromium from this checkout's Playwright install, under an exclusively created `/tmp/rconsole-e2e.lock`, viewer/operator/admin sessions. T3 preview snapshot twice failed with `Preview automation snapshot timed out after 15000ms.`, so browser checks used the documented fallback.
- Short key-browser/Console/drawer regression: completed names scan (25 fixture matches, 367 scanned at that instant), hash/string/stream inspection, Workbench rich/raw switching, Console `PING` → `PONG`, helper insertion/focus, split/tabs/keyboard resize, 1024px Console layout without document-width overflow. No unexpected page errors or CSP violations were observed in the exercised workflows. This is not a full accessibility, mobile, topology, or long-duration qualification.
- Temporary reproducible scripts/logs: `/tmp/rc-v021-vf-check/{adversarial.mjs,adversarial.json,role-policy.mjs,role-policy.json,focused.mjs,results.json,inert.mjs,inert-results.json}`. Screenshots include binary confirmation, column cap and 1024px regression there. Initial feature screenshots/results are in `/tmp/rc-v021-vf-ev/`, including the successful **9/9 M1 rerun**. The first broad harness started before fixture seeding completed; its M1 setup failure was corrected and rerun. Two independent-harness failures were also corrected: a protective remote-route block (replaced with the local read-only injection matrix) and an assertion expecting unescaped quotes in Java text (rerun proved all three formats inert). The operator index-creation ACL denial was identified from the audit, then the same source-B definition was created and schema-checked as admin over HTTP (`admin-create.json`); the report does not count the initial harness's lack of page errors as proof of creation. None of these harness/ACL qualifications is counted as a product defect.

## Cleanup

Removed the first 26 fixture keys, then the 20 reseeded keys used for the final admin check, exclusively under `vf-20261024:*` on **6411**. Final SCAN and index-list checks found **zero fixture keys and zero fixture indexes**. The final admin-created index was explicitly dropped. Stopped own server PIDs **40784** and **55466**; their pnpm parents exited. The lock created for browser checks was released; a later lock belongs to a concurrent E2E run and was left alone. Own Playwright browsers and the failed preview tab were closed. No connection to 6380; no changes to ports 4000/4400 or `<repo>/data`. The requested `git -C <repo> worktree remove --force ../redis-console-wt/v021-vf` succeeded; the path no longer exists. Port 4700 has no listener and all recorded server/parent PIDs are gone.

**Release recommendation: hold v0.2.1 until M3 bounds Java node counts and expanded formatter output; the other listed fixes pass this focused check.**
