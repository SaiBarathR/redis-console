# Redis Console v0.4.1

Fixes and install-guide updates from a first-time deployment of 0.4.0: the published image installed by following
[INSTALL.md](INSTALL.md) as written, on a Linux server behind a Cloudflare Tunnel, next to six Redis-compatible servers
that belong to other applications (Redis 7.2 to 8.10 and Valkey 8.1). The full record:
[qa/v041-deployment-trial.md](qa/v041-deployment-trial.md).

## Fixes

- **A tier that connects as Redis's `default` user is not its own ACL user.** A prod database configured with
  `"viewer": { "username": "default" }` passed the per-tier check without an exception, and nothing was logged. Such a
  tier now needs `"acceptRisks": ["default-credentials"]`, and the message says why: `default` usually has every
  permission, so Redis cannot enforce that role's limits.
- **Accepted risks are logged at every start**, as [OPERATIONS.md](OPERATIONS.md#production-checks-node_envproduction)
  said, for example `database app-queue: production database without TLS (accepted risk "plaintext")`. An exception
  that is no longer needed is named, and so is `acceptRisks` on a database that is not prod.
- **Valkey shows its own version.** A Valkey 8.1.4 server was listed as 7.2.4, the Redis version it reports for
  compatibility. The picker, the status bar and the overview now show "Valkey 8.1.4" (the compatibility version is in
  the tooltip); which views are enabled is unchanged.
- **After signing in on `/login`, you land on `/`.** The address bar used to keep `/login` (and any unknown path)
  while the database picker showed.

## Install guide

- Download the Compose example without a checkout; the GitHub CLI version `gh attestation` needs, and how to compare
  the image digest instead ([§3](INSTALL.md#3-get-the-image), [§7.2](INSTALL.md#72-docker-compose)).
- **Redis servers you cannot add ACL users to** (an application's bundled queue or cache): inspect them read-only with
  their existing login, and what each exception means ([§5](INSTALL.md#redis-servers-you-cannot-add-acl-users-to)).
- **Redis on the same Docker host** ([§7.5](INSTALL.md#75-redis-servers-on-the-same-docker-host)): Redis in another
  Compose project (external networks, container names), Redis installed on the host (`host-gateway`, `bind`,
  protected mode, starting after Docker), and why a `trustProxy` hop count is unsafe once the console joins other
  networks.
- **Cloudflare Tunnel** ([§8](INSTALL.md#cloudflare-tunnel)): the ingress rule, `trustProxy`, Server-Sent Events, and
  the scripts Cloudflare injects that the CSP blocks.
- Keep two local admins, one sealed for break-glass ([§11](INSTALL.md#11-first-sign-in)); make backup copies private
  ([§12](INSTALL.md#12-health-backups-upgrades-and-logs)); new troubleshooting rows.

## Upgrade notes

- **A prod config may now stop at startup** if a tier reachable under `maxRole` uses `"username": "default"` (for
  example an `admin` tier as `default` next to per-tier viewer and operator users). The error names the tier. Give it
  its own ACL user (for `admin`, the restricted `rc-admin` of [INSTALL.md §5](INSTALL.md#5-create-the-redis-acl-users)),
  or add `"acceptRisks": ["default-credentials"]` as a reviewed exception.
- New warning lines at startup name each accepted risk; nothing else changes in the config.
- **API (additive):** `DatabaseSummary.server.engine` (`{ name, version }`) when the server is not Redis itself
  ([CONTRACT-CHANGES.md](CONTRACT-CHANGES.md)).
- No data migration: upgrade by replacing the image (back up the data directory first, as always).

## How it was checked

- The deployment trial itself, through the tunnel: first sign-in, every database connected, reads on all six, writes
  refused on the read-only ones, Server-Sent Events and Pub/Sub, `trustProxy`, the online backup.
- Reviewed by Claude Sonnet 5.5 ([research/35](research/35-deploy-trial-review.md)): no High; two Medium and seven Low,
  all fixed or decided ([REVIEW-LOG.md](REVIEW-LOG.md)). Every regression test failed before its fix.
- `pnpm -r typecheck` clean; shared 73, web 551, server unit 639 passed; the server suite with the cluster, Sentinel
  and mutual-TLS topology 1,117 passed, 8 skipped, in three consecutive runs; Playwright 701 passed, 0 failed, 0 flaky,
  2 skipped. A heap-measurement test that flaked in CI now warms its path before measuring.
