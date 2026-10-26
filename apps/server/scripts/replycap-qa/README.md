# Round 3 reply-cap qualification

Adapted from every `.mjs` in `<research-dir>/r3-evidence`. These are manual qualification scripts, in addition
to the automated regressions in `test/{unit,integration}`. `redis.mjs` refuses direct ports other than 6411/6412;
all large values and ACL/dictionary fixtures stay on 6411. Remote reads go through the app. No credentials or
session tokens are printed. Start with `.env` loaded, this branch's server on 4600, and QA accounts provisioned
by `node scripts/qa-accounts.mjs http://localhost:4600`.

- `benchmark.mjs <result.json>`: fixed command descriptors in `/tmp/rc-replycap-bench-commands.json`; 15 warmups
  and 50 measured requests per command, 55 ms spacing. Records HTTP p50/p95 and all status/type outcomes. Uses
  real string/hash/zset keys on 6412 and small, repeatable JSON/search/list/stream fixtures for missing types.
- `live-config.mjs`: makes `/tmp/rc-replycap-live-config.json` by copying the dev config's **secret references** and
  adding four policy-restricted aliases for 6411. Restart the own server on 4600 with this config before `run.mjs`.
- `run.mjs <own-server-pid>`: runs all recovered scenarios, with RSS sampling and results in
  `/tmp/rc-replycap-r3-summary.json`. `tiers.mjs` checks effective ACL identities with CLIENT INFO and the prod
  confirmation. `matrix.mjs`/`matrix2.mjs` exercise readOnly/maxRole restrictions. Their deliberate writes to
  permitted operator databases are removed. `apply-blowup` now exercises 30 steps through the API (there is no
  alias estimator to import). RANDOMKEY retries until it picks a long name, at most 60 attempts. `dictdump.mjs qa-admin` additionally checks the transport for the admin role; viewer is denied by the Redis ACL.
- `redis7.mjs`: adapts the old sampling experiment to permitted 6411; records current Redis behavior, not a claim
  of Redis 7 qualification. `small-confirms` records removal of the fail-open probe and checks proxy config.
  `dbg`/`smoke` omit the original token/session dumps.
- `baseline-check.mjs`: supplemental in-process probes for the old scan flood, 9,999-key MGET and 20-step alias
  expansion. Generate the immutable baseline under `apps/server/scripts/.replycap-baseline` with
  `mkdir -p apps/server/scripts/.replycap-baseline` followed by
  `git archive b9ea7e2 apps/server/src | tar -x -C apps/server/scripts/.replycap-baseline`, then run with
  `node --expose-gc --max-old-space-size=512`. It only reads 6412. Remove/archive the generated source afterwards;
  it is not part of the implementation.
- `rss.mjs <own-server-pid>`: eight 20 MiB aggregate replies, each exceeding the default 16 MiB cap after a
  10 MiB element has been received. Asserts 413 and latency/RSS ceilings; writes `/tmp/rc-replycap-rss.json`.
- `cleanup.mjs`: drops only the benchmark index/keys on 6412 and review-prefix fixtures on 6411. Run after
  qualification. Each large-value script also removes its fixtures, and `leftovers` verifies review-prefix absence.

Reports and measurements: `docs/qa/v02-replycap.md` and `docs/qa/v02-replycap-evidence.json`.
