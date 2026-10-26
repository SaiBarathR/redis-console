# Redis Insight replacement: consolidated shortlist

Sources: 01 (first audit), 02 (secure architecture), 03a–03d (four wider sweeps). As of 2026-10-22.
All findings come from desk research and reading source code. Nothing was run.

## Verdict
No open-source project meets the requirements as-is. Two are worth a short hands-on security test before we commit to building our own.

## Tier 1: worth a hands-on test (about 1 week, isolated sandbox)
| Project | Licence / stack | Strengths | Blockers / risks |
|---|---|---|---|
| [LibreDB Studio](https://github.com/libredb/libredb-studio) | MIT, Next.js/TS, ioredis | Native OIDC; "managed" connections keep secrets server-side; role-filtered connections; Redis command editor; audit support | Multi-DB tool, not Redis-focused; built on Next.js; 4 GHSAs in recent months (2 high: connection hijack, OIDC state cookie accepted as session), so pin to 1.0.0 or later; TLS `require` mode disables certificate verification |
| [Zedis Web](https://github.com/vicanso/zedis) | Apache-2.0, Rust + WASM | Backend keeps credentials (encrypted); smart terminal with completion and argument hints; admin/full/read-only roles; per-server restrictions; SSO through a trusted proxy | Web version is an early preview; some documented controls exist only in nightly builds; Rust/WASM is hard for a Node team to audit and extend; audit logging is not on for everything by default |

Test plan for each:
- Can a normal user, calling the API directly:
  - see Redis secrets?
  - change the connection target?
  - get around read-only mode through the console, including EVAL and MULTI?
- Are values rendered safely (XSS)?
- Is TLS certificate verification on?
- What do the audit logs contain?
- What third-party network traffic does it make?
- How large is the dependency tree?

## Tier 2: foundations or partial fits
- [RESPdeck](https://github.com/aeke/respdeck) (MIT, React + Fastify): small and clean, with good security controls. No command console, a single admin session, standalone Redis only.
- Valkey Admin (Apache-2.0): an operations dashboard for Valkey, not a Redis developer client. See 01.

## Commercial or open-core (brings back vendor dependency, so it goes against the project's goal)
- CloudBeaver Enterprise, DbGate Team Premium, Bytebase (SSO, roles and masking need Pro/Enterprise), NineData (proprietary).

## Building blocks if we build our own
- HashiCorp Vault Redis secrets engine: short-lived Redis ACL users per session. Only worth it if the company already runs Vault (Vault is BSL-licensed).
- Teleport, Boundary and Infisical are network or credential layers. None has a governed Redis console. Not needed.

## Ideas to borrow (see 03d)
- iredis-style autocomplete with argument hints
- Redis Insight's Workbench and its Dev/Prod type-to-confirm prompt
- Another Redis Desktop Manager's Java-serialized value viewer
- Bull Board for viewing queues
- Medis / QuickRedis value viewers

## Ruled out
P3X (sends data to the maintainer's server, a critical credential-handling issue); Redis Commander (stale, logs values); Redis Insight (SSPL); Tiny RDM (GPL, desktop only); ARDM (desktop, Vue 2); phpRedisAdmin; Appsmith (no Redis TLS); Beekeeper (desktop only); RedisWebManager (TLS and credential issues).
